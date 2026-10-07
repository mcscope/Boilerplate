/**
 * Unified physics (design/unified-physics.md): one MAC grid where every open cell is liquid (FLIP particles) or
 * gas (Eulerian air + vapor), one variable-density pressure projection for both, and phase change as mass
 * transfer between particles and the vapor field. Builds on Fluid's particle machinery (FLIP transfer,
 * separation, cohesion, density).
 */
import { Fluid } from '../sim/fluid';
import { gasTransport } from './gas';
import { phaseChange, resetPhase } from './phase';
import { project, resetSolver } from './solver';
import { GAS, GasState, LiquidFields, P0, PhaseContext, ProjectOptions, ProjectResult, RHO_AIR, SOLID, T_AMBIENT } from './types';

export class UnifiedFluid extends Fluid {
  /** Gas state; `gasState.T` is shared with Thermo.T once attachTemperature() has been called. */
  readonly gasState: GasState;
  /** Solved absolute pressure per cell from the last projection (solid cells 0). Same units as P0. */
  readonly pressure: Float32Array;
  /** Solver settings; dt is filled in per substep. */
  projectOptions: ProjectOptions = { dt: 0, openTop: true, maxIters: 100, tolerance: 1e-3, driftCompensation: 1 };
  lastProject: ProjectResult = { iterations: 0, residual: 0 };

  private readonly liquid: LiquidFields;
  private readonly phase: PhaseContext;
  private savedU: Float32Array;
  private savedV: Float32Array;
  /** 1 where the face velocity came from particles this substep (P2G), 0 where it's gas (carried over). */
  private uFromP: Uint8Array;
  private vFromP: Uint8Array;

  constructor(nx: number, ny: number, h: number, maxParticles: number) {
    super(nx, ny, h, maxParticles);
    const n = nx * ny;
    this.gasState = {
      air: new Float32Array(n),
      vapor: new Float32Array(n),
      T: new Float32Array(n).fill(T_AMBIENT),
      pendingAir: new Float32Array(n),
      pendingVapor: new Float32Array(n),
      alcVapor: new Float32Array(n),
      pendingAlc: new Float32Array(n),
    };
    this.pressure = new Float32Array(n);
    this.savedU = new Float32Array(n);
    this.savedV = new Float32Array(n);
    this.uFromP = new Uint8Array(n);
    this.vFromP = new Uint8Array(n);
    this.liquid = { rho: this.cellRho, density: this.density, restDensity: this.restDensity };
    const self = this;
    this.phase = {
      grid: this,
      gas: this.gasState,
      pressure: this.pressure,
      particles: {
        get count() { return self.count; },
        get pos() { return self.pos; },
        get vel() { return self.vel; },
        get kind() { return self.kind; },
        get temp() { return self.temp; },
        get silt() { return self.silt; },
        get alc() { return self.alc; },
        add: (x, y, vx, vy, kind, temp, silt, alc) => self.addParticle(x, y, vx, vy, kind, temp, silt, alc),
        remove: k => self.removeParticle(k),
      },
      dt: 0,
      residue: new Float32Array(n),
      restDensity: this.restDensity,
    };
  }

  /** Share the temperature field with Thermo (and, optionally, its residue field for evaporated silt). */
  attachTemperature(T: Float32Array, residue?: Float32Array) {
    this.gasState.T = T;
    if (residue) this.phase.residue = residue;
  }

  clearParticles() {
    super.clearParticles();
    resetPhase();
    resetSolver();
    this.resetGas();
  }

  /** After loading: classify cells and fill every gas cell with ambient air. */
  refreshFields() {
    super.refreshFields();
    if (!this.gasReady) this.initGas();
  }

  private resetGas() {
    this.gasReady = false;
    this.gasState.air.fill(0);
    this.gasState.vapor.fill(0);
    this.gasState.alcVapor.fill(0);
    this.gasState.pendingAlc.fill(0);
    this.gasState.pendingAir.fill(0);
    this.gasState.pendingVapor.fill(0);
    this.pressure.fill(0);
  }

  private initGas() {
    const { air, vapor } = this.gasState, ct = this.cellType;
    for (let c = 0; c < ct.length; c++) {
      const g = ct[c] === GAS;
      air[c] = g ? RHO_AIR : 0;
      vapor[c] = 0;
      this.pressure[c] = ct[c] === SOLID ? 0 : P0;
    }
    this.gasState.pendingAir.fill(0);
    this.gasState.pendingVapor.fill(0);
    this.gasState.alcVapor.fill(0);
    this.gasState.pendingAlc.fill(0);
    this.prevType.set(ct);
    this.gasReady = true;
  }

  /**
   * Add water vapor (total mass, in cell-mass units: a cell of ambient air holds RHO_AIR) spread over the gas
   * cells in a disk, and warm them to at least `temp`. Used by the Steam tool and by drying wood.
   */
  addVapor(x: number, y: number, r: number, amount: number, temp = 110) {
    const { nx, ny, h } = this, ct = this.cellType;
    const ci = x / h, cj = y / h, rc = Math.max(0.5, r / h);
    let n = 0;
    const visit = (fn: (c: number) => void) => {
      for (let j = Math.floor(cj - rc); j <= Math.ceil(cj + rc); j++) for (let i = Math.floor(ci - rc); i <= Math.ceil(ci + rc); i++) {
        if (i < 1 || j < 1 || i >= nx - 1 || j >= ny - 1) continue;
        if ((i + 0.5 - ci) ** 2 + (j + 0.5 - cj) ** 2 > rc * rc + 0.5) continue;
        const c = i + j * nx;
        if (this.s[c] !== 0 && ct[c] === GAS) fn(c);
      }
    };
    visit(() => n++);
    if (n === 0) return 0;
    const per = amount / n, T = this.gasState.T;
    visit(c => { this.gasState.vapor[c] += per; if (T[c] < temp) T[c] = temp; });
    return amount;
  }

  step(dt: number) {
    const sdt = dt / this.params.substeps;
    const { nx, ny } = this;
    const ct = this.cellType, g = this.params.gravity;
    for (let sub = 0; sub < this.params.substeps; sub++) {
      // 1. Particles: gravity + motion, separation and cohesion.
      this.integrate(sdt);
      this.separate(this.params.separationIters);

      // 2. P2G, keeping the (advected) gas velocity on faces the particles don't own.
      this.savedU.set(this.u);
      this.savedV.set(this.v);
      this.transfer(true); // also classifies cells LIQUID (has particles) / GAS / SOLID
      if (!this.gasReady) this.initGas();
      const { u, v, du, dv, savedU, savedV, uFromP, vFromP } = this;
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const c = i + j * nx, t = ct[c];
        // x-face between c-1 and c
        if (i > 0) {
          const tl = ct[c - 1];
          if (t === SOLID || tl === SOLID) uFromP[c] = 0; // already zeroed by transfer
          else if (du[c] > 0 && !(t === GAS && tl === GAS)) uFromP[c] = 1;
          else { uFromP[c] = 0; u[c] = savedU[c]; }
        } else uFromP[c] = 0;
        // y-face between c-nx and c
        if (j > 0) {
          const tt = ct[c - nx];
          if (t === SOLID || tt === SOLID) vFromP[c] = 0;
          else if (dv[c] > 0 && !(t === GAS && tt === GAS)) vFromP[c] = 1;
          else { vFromP[c] = 0; v[c] = savedV[c]; }
        } else vFromP[c] = 0;
      }

      // 3. Liquid density per cell; remap gas for cells that changed phase; atmosphere boundary.
      this.updateDensity();
      gasTransport.remap(this, this.gasState, this.prevType);
      this.prevType.set(ct);
      this.projectOptions.openTop = this.openTop;
      gasTransport.applyAtmosphere(this, this.gasState, this.openTop);

      // 4. Gravity on faces the particles didn't supply (particles got theirs in integrate).
      for (let j = 1; j < ny; j++) for (let i = 0; i < nx; i++) {
        const c = i + j * nx;
        if (vFromP[c] || ct[c] === SOLID || ct[c - nx] === SOLID) continue;
        v[c] += g * sdt;
      }

      // 5. One projection for liquid and gas. FLIP picks up only what the projection changes.
      this.prevU.set(u);
      this.prevV.set(v);
      this.projectOptions.dt = sdt;
      this.lastProject = project(this, this.gasState, this.liquid, this.projectOptions, this.pressure);

      // 6. G2P.
      this.transfer(false);

      // 7. Gas transport with the projected velocity.
      gasTransport.advect(this, this.gasState, sdt);
      gasTransport.advectVelocity(this, sdt);

      // 8. Evaporation, condensation, boiling.
      this.phase.dt = sdt;
      phaseChange(this.phase);
    }
    // Air connectivity, for consumers that want "open air" (thermo's ambient cooling).
    this.labelRegions();
  }
}
