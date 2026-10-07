import { AIR, FLUID, Fluid, OIL, WATER, WAX } from './fluid';

/**
 * Heat, fire and phase changes on top of the liquid simulation.
 *
 * - Every grid cell has a temperature; liquid particles carry their own and share it with their cell.
 * - Heat conducts between neighboring cells (stone, ice and liquids well; air poorly) and hot air rises.
 * - Water boils into steam particles above 100°, which rise, add gas pressure to their air pocket,
 *   and condense back into water when they cool. Water freezes into solid ice cells below 0°; ice melts above.
 * - Oil touching air ignites above 250° and burns away, throwing off heat and flames.
 */

export const AMBIENT = 20;
/** How fast the blowtorch (and chiller) changes temperatures, °C per second. */
const TORCH_POWER = 3000;
export const BOIL = 100;
export const IGNITE = 250;
export const WAX_MELT = 60;
export const WAX_SET = 55;
const WAX_IGNITE = 300;

/** Solid materials per cell. */
export const NONE = 0;
export const STONE = 1;
export const ICE = 2;
export const WAX_SOLID = 3;
export const MUD = 4;
export const WOOD = 5;

/** Seconds a cell of wood burns before it's gone. */
export const WOOD_FUEL = 10;
const WOOD_IGNITE = 300;
const WOOD_HEAT = 500; // °C/s a burning wood cell gives off
const WOOD_SPREAD = 150; // °C/s it preheats each neighboring wood cell (fire runs along a surface)
/*
 * Wood is porous: it soaks up liquid it touches (melted wax, oil, water) and carries it along its grain by
 * capillary action, upward too. That's what makes a wick: a thin, soaked stick has little thermal mass and
 * air on its sides, so a flame keeps the soaked fuel above flash point. The fuel burns first, sparing the wood,
 * and the flame melts the wax below to keep the stick fed. Soaked water has to steam off before wood can light.
 */
const WOOD_CAPACITY = 2; // liquid particles a wood cell can hold
const WOOD_UPTAKE = 3; // chance per second a touching liquid particle is drawn in
const WOOD_WICKING = 4; // capillary spreading rate along the grain, per second
const SOAK_BURN_USE = 1.2; // particles of soaked fuel a burning cell uses per second
const SOAK_HEAT = 900; // °C/s burning soaked fuel gives off
const WOOD_DRYING = 1.5; // particles of soaked water a hot cell steams off per second
const K_WOOD = 0.08;
/** Flames heat the air they pass through and whatever surface they lick: that's how fire spreads and pots boil. */
const FLAME_HEAT = 150; // °C/s into the air cell a flame is in
const FLAME_TOUCH = 25; // °C into a solid or liquid cell a flame runs into

const BURN_TIME = 3; // seconds one oil particle burns
// Heat a burning liquid surface gets back from its own flame (most goes up into the air). Low enough that a
// cold pool's conduction wins and the flame dies; a pool that's hot through (a heated pan) keeps burning.
const BURN_HEAT = 250; // °C/s
const BOIL_RATE = 2; // chance per second a water particle at boiling point turns to steam
const BOIL_LATENT = 6; // °C the cell loses per particle boiled
const CONDENSE_RATE = 1.5;
const CONDENSE_LATENT = BOIL_LATENT; // condensing gives back exactly what boiling took
const MELT_LATENT = 300; // heat (°C × cell) ice soaks up at 0° before it melts
const WAX_LATENT = 150;
const STEAM_GAS = 1.2;
/** Volume (cells) that one particle of water flashing to steam *inside* liquid shoves aside: grease-fire bursts. */
const FLASH_EXPANSION = 4;
/** Water trapped under liquid superheats a little, then flashes to steam all at once. */
const FLASH_POINT = BOIL + 5; // gas one steam particle adds to its pocket (1 = one cell of air at atmosphere)
const MAX_STEAM = 8000;
const MAX_FLAMES = 4000;

// Conductivity per material, and how much heat it takes to warm (air warms fast).
const K_AIR = 0.04, K_STONE = 0.25, K_ICE = 0.35, K_WATER = 0.3, K_OIL = 0.15, K_WAX = 0.15;
const CAP_AIR = 0.5;

export class Thermo {
  readonly nx: number;
  readonly ny: number;
  readonly h: number;
  /** Cell temperature, °C. */
  T: Float32Array;
  /** Solid material per cell. */
  mat: Uint8Array;
  /** Incremented whenever ice forms or melts, so the renderer can redraw solids. */
  solidChanges = 0;
  /** Silt left behind by boiling muddy water, per cell; the sediment system collects it. */
  residue: Float32Array;
  /** Seconds of burning left in each wood cell. */
  fuel: Float32Array;
  /** 1 while a wood cell is on fire. */
  burning: Uint8Array;
  /** Liquid fuel (wax or oil) soaked into each wood cell, in particles. */
  soak: Float32Array;
  /** Water soaked into each wood cell, in particles. */
  wet: Float32Array;

  // Steam particles
  steamCount = 0;
  sx = new Float32Array(MAX_STEAM);
  sy = new Float32Array(MAX_STEAM);
  svx = new Float32Array(MAX_STEAM);
  svy = new Float32Array(MAX_STEAM);
  sT = new Float32Array(MAX_STEAM);

  // Flames (visual only)
  flameCount = 0;
  fx = new Float32Array(MAX_FLAMES);
  fy = new Float32Array(MAX_FLAMES);
  fvx = new Float32Array(MAX_FLAMES);
  fvy = new Float32Array(MAX_FLAMES);
  fLife = new Float32Array(MAX_FLAMES);
  fMax = new Float32Array(MAX_FLAMES);

  /** Heat absorbed so far by each ice cell on its way to melting. */
  private melt: Float32Array;
  private Tn: Float32Array;
  /**
   * Heat to add to each cell at the start of the next step. Liquid cells re-derive their temperature from
   * their particles every step, so changes made after that point (boiling, condensing, steam) are queued here.
   */
  private pending: Float32Array;
  private sumT: Float32Array;
  private cnt: Float32Array;
  private cntWater: Float32Array;
  private cntWax: Float32Array;
  private k: Float32Array;
  private cap: Float32Array;

  constructor(private fluid: Fluid) {
    this.nx = fluid.nx;
    this.ny = fluid.ny;
    this.h = fluid.h;
    const n = this.nx * this.ny;
    this.T = new Float32Array(n).fill(AMBIENT);
    this.mat = new Uint8Array(n);
    this.melt = new Float32Array(n);
    this.residue = new Float32Array(n);
    this.fuel = new Float32Array(n);
    this.burning = new Uint8Array(n);
    this.soak = new Float32Array(n);
    this.wet = new Float32Array(n);
    this.Tn = new Float32Array(n);
    this.pending = new Float32Array(n);
    this.sumT = new Float32Array(n);
    this.cnt = new Float32Array(n);
    this.cntWater = new Float32Array(n);
    this.cntWax = new Float32Array(n);
    this.k = new Float32Array(n);
    this.cap = new Float32Array(n);
  }

  reset() {
    this.T.fill(AMBIENT);
    this.mat.fill(NONE);
    this.melt.fill(0);
    this.pending.fill(0);
    this.residue.fill(0);
    this.fuel.fill(0);
    this.burning.fill(0);
    this.soak.fill(0);
    this.wet.fill(0);
    this.steamCount = 0;
    this.flameCount = 0;
  }

  cellAt(x: number, y: number) {
    const i = Math.floor(x / this.h), j = Math.floor(y / this.h);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return -1;
    return i + j * this.nx;
  }

  addSteam(x: number, y: number, vx = 0, vy = 0, temp = BOIL + 5) {
    if (this.steamCount >= MAX_STEAM || this.fluid.solidAt(x, y)) return;
    const k = this.steamCount++;
    this.sx[k] = x; this.sy[k] = y; this.svx[k] = vx; this.svy[k] = vy; this.sT[k] = temp;
  }

  private removeSteam(k: number) {
    const l = --this.steamCount;
    this.sx[k] = this.sx[l]; this.sy[k] = this.sy[l]; this.svx[k] = this.svx[l]; this.svy[k] = this.svy[l]; this.sT[k] = this.sT[l];
  }

  addFlame(x: number, y: number) {
    if (this.flameCount >= MAX_FLAMES) return;
    const k = this.flameCount++;
    this.fx[k] = x; this.fy[k] = y;
    this.fvx[k] = (Math.random() - 0.5) * 20;
    this.fvy[k] = -30 - Math.random() * 40;
    this.fMax[k] = this.fLife[k] = 0.3 + Math.random() * 0.5;
  }

  /**
   * Blowtorch / chiller: push temperatures in a disk toward `target` at a limited rate (°C per second).
   * Only exposed things are reached: open cells, liquid, and the surfaces of solids, never the inside of a wall.
   */
  applyTemperature(x: number, y: number, r: number, target: number, dt = 1 / 60, power = TORCH_POWER) {
    const f = this.fluid, hot = target > AMBIENT, step = power * dt;
    const toward = (t: number) => (hot ? Math.min(target, Math.max(t, t + step)) : Math.max(target, Math.min(t, t - step)));
    const ci = x / this.h, cj = y / this.h, rc = r / this.h, nx = this.nx;
    for (let j = Math.floor(cj - rc); j <= Math.ceil(cj + rc); j++) for (let i = Math.floor(ci - rc); i <= Math.ceil(ci + rc); i++) {
      if (i < 1 || j < 1 || i >= this.nx - 1 || j >= this.ny - 1 || (i + 0.5 - ci) ** 2 + (j + 0.5 - cj) ** 2 > rc * rc) continue;
      const c = i + j * nx;
      const exposed = f.s[c] !== 0 || f.s[c - 1] !== 0 || f.s[c + 1] !== 0 || f.s[c - nx] !== 0 || f.s[c + nx] !== 0;
      if (exposed) this.T[c] = toward(this.T[c]);
    }
    for (let k = 0; k < f.count; k++) {
      if ((f.pos[2 * k] - x) ** 2 + (f.pos[2 * k + 1] - y) ** 2 > r * r) continue;
      f.temp[k] = toward(f.temp[k]);
    }
    for (let k = 0; k < this.steamCount; k++) {
      if ((this.sx[k] - x) ** 2 + (this.sy[k] - y) ** 2 <= r * r && !hot) this.sT[k] = toward(this.sT[k]);
    }
    if (hot) for (let n = 0; n < 3; n++) this.addFlame(x + (Math.random() - 0.5) * r * 1.5, y + (Math.random() - 0.5) * r * 1.5);
  }

  /** Before the liquid step: tell the pressure system how much steam each air cell holds. */
  preStep() {
    const g = this.fluid.extraGas;
    g.fill(0);
    for (let k = 0; k < this.steamCount; k++) {
      const c = this.cellAt(this.sx[k], this.sy[k]);
      if (c >= 0) g[c] += STEAM_GAS;
    }
  }

  step(dt: number) {
    this.liquidToCells();
    for (let c = 0; c < this.T.length; c++) this.T[c] += this.pending[c];
    this.pending.fill(0);
    this.burn(dt);
    this.soakWood(dt);
    this.burnWood(dt);
    this.conduct(dt);
    this.cellsToLiquid();
    this.boilAndFreeze(dt);
    this.moveSteam(dt);
    this.moveFlames(dt);
  }

  /** Liquid cells take the mean temperature of their particles (that's how moving liquid carries heat). */
  private liquidToCells() {
    const f = this.fluid, { sumT, cnt, cntWater, cntWax } = this;
    sumT.fill(0);
    cnt.fill(0);
    cntWater.fill(0);
    cntWax.fill(0);
    for (let k = 0; k < f.count; k++) {
      const c = this.cellAt(f.pos[2 * k], f.pos[2 * k + 1]);
      if (c < 0) continue;
      sumT[c] += f.temp[k];
      cnt[c]++;
      if (f.kind[k] === WATER) cntWater[c]++;
      else if (f.kind[k] === WAX) cntWax[c]++;
    }
    for (let c = 0; c < this.T.length; c++) if (cnt[c] > 0) this.T[c] = sumT[c] / cnt[c];
  }

  private hasAirNeighbor(c: number) {
    const ct = this.fluid.cellType, nx = this.nx;
    return ct[c - 1] === AIR || ct[c + 1] === AIR || ct[c - nx] === AIR || ct[c + nx] === AIR || ct[c] === AIR;
  }

  /** Oil touching air ignites when hot enough; burning oil heats its cell and is slowly consumed. */
  /** Capillary action: wood draws in liquid it touches and spreads it along its grain. */
  private soakWood(dt: number) {
    const { nx, ny, T, mat, soak, wet } = this;
    const f = this.fluid;
    const uptake = Math.min(1, WOOD_UPTAKE * dt);
    for (let k = f.count - 1; k >= 0; k--) {
      if (Math.random() > uptake) continue;
      const c = this.cellAt(f.pos[2 * k], f.pos[2 * k + 1]);
      if (c < 0) continue;
      for (const o of [c - 1, c + 1, c - nx, c + nx]) {
        if (mat[o] !== WOOD || soak[o] + wet[o] > WOOD_CAPACITY - 1) continue;
        if (f.kind[k] === WATER) wet[o] += 1;
        else soak[o] += 1;
        T[o] = (T[o] + f.temp[k]) / 2;
        f.removeParticle(k);
        break;
      }
    }
    const rate = Math.min(0.25, WOOD_WICKING * dt);
    for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      const c = i + j * nx;
      if (mat[c] !== WOOD) continue;
      for (const o of [c + 1, c + nx]) {
        if (mat[o] !== WOOD) continue;
        const q = (soak[c] - soak[o]) * rate, w = (wet[c] - wet[o]) * rate;
        soak[c] -= q; soak[o] += q;
        wet[c] -= w; wet[o] += w;
      }
    }
  }

  /**
   * Wood (or the fuel soaked into it) ignites where it touches air once hot enough. Soaked fuel burns first and
   * fiercely; then the wood itself burns through, heating its neighbors so fire runs along it, and is gone.
   * Wet wood can't get above 100° until its water has steamed off. Cool it below flash point or cut off its
   * air and it goes out.
   */
  private burnWood(dt: number) {
    const { nx, ny, T, mat, fuel, burning, soak, wet } = this;
    const f = this.fluid, ct = f.cellType;
    let changed = false;
    for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      const c = i + j * nx;
      if (mat[c] !== WOOD) continue;
      let open = -1;
      for (const o of [c - nx, c - 1, c + 1, c + nx]) if (ct[o] === AIR) { open = o; break; }

      if (wet[c] > 0.05 && T[c] > BOIL) {
        // Drying: water steams off, holding the wood at 100° meanwhile.
        const q = Math.min(wet[c], WOOD_DRYING * dt);
        wet[c] -= q;
        T[c] = BOIL;
        if (open >= 0 && Math.random() < q * 3) this.addSteam(((open % nx) + 0.5) * this.h, (Math.floor(open / nx) + 0.5) * this.h, 0, -20);
      }

      const fueled = soak[c] > 0.05;
      const flash = fueled ? IGNITE : WOOD_IGNITE;
      if (!burning[c]) {
        if (open >= 0 && T[c] >= flash && wet[c] <= 0.05) burning[c] = 1;
        continue;
      }
      if (open < 0 || T[c] < flash * 0.8) { burning[c] = 0; continue; }
      if (fueled) {
        soak[c] = Math.max(0, soak[c] - SOAK_BURN_USE * dt);
        T[c] += SOAK_HEAT * dt;
      } else {
        T[c] += WOOD_HEAT * dt;
        fuel[c] -= dt;
      }
      for (const o of [c - 1, c + 1, c - nx, c + nx]) if (mat[o] === WOOD) T[o] += WOOD_SPREAD * dt;
      if (Math.random() < (fueled ? 25 : 10) * dt) {
        this.addFlame(((open % nx) + Math.random()) * this.h, (Math.floor(open / nx) + Math.random()) * this.h);
      }
      if (fuel[c] <= 0) {
        mat[c] = NONE;
        f.s[c] = 1;
        burning[c] = 0;
        changed = true;
      }
    }
    if (changed) this.solidChanges++;
  }

  private burn(dt: number) {
    const f = this.fluid;
    for (let k = f.count - 1; k >= 0; k--) {
      const kind = f.kind[k];
      if (kind === WATER) continue;
      const c = this.cellAt(f.pos[2 * k], f.pos[2 * k + 1]);
      if (c < 0) continue;
      const air = this.hasAirNeighbor(c);
      // Only fuel *vapor* burns, so liquid burns only while its surface stays above its flash point.
      // The flame's heat goes into the cell, and conduction carries it off into the rest of the pool:
      // a thin film or an already-hot pan keeps itself burning; a cold, deep pool puts itself out.
      const flash = kind === OIL ? IGNITE : WAX_IGNITE;
      if (f.burn[k] <= 0) {
        if (air && f.temp[k] >= flash) f.burn[k] = BURN_TIME * (kind === OIL ? 1 : 2.5) * (0.7 + Math.random() * 0.6);
        continue;
      }
      if (!air || f.temp[k] < flash * 0.85) { f.burn[k] = 0; continue; } // smothered, or cooled below flash
      f.burn[k] -= dt;
      this.T[c] += BURN_HEAT * dt;
      if (Math.random() < 12 * dt) this.addFlame(f.pos[2 * k] + (Math.random() - 0.5) * 2, f.pos[2 * k + 1] - 1);
      if (f.burn[k] <= 0) f.removeParticle(k);
    }
  }

  /** Conduction between neighboring cells, rising hot air, and slow loss to the surroundings. */
  private conduct(dt: number) {
    const { nx, ny, T, Tn, k, cap, mat } = this;
    const f = this.fluid, ct = f.cellType;
    for (let c = 0; c < nx * ny; c++) {
      if (mat[c] === ICE) { k[c] = K_ICE; cap[c] = 1; }
      else if (mat[c] === WAX_SOLID) { k[c] = K_WAX; cap[c] = 1; }
      else if (mat[c] === WOOD) { k[c] = K_WOOD; cap[c] = 1; }
      else if (f.s[c] === 0) { k[c] = K_STONE; cap[c] = 1; }
      else if (ct[c] === FLUID) { k[c] = K_WATER * (1 - f.cellOil[c] - f.cellWax[c]) + K_OIL * f.cellOil[c] + K_WAX * f.cellWax[c]; cap[c] = 1; }
      else { k[c] = K_AIR; cap[c] = CAP_AIR; }
    }
    const rate = Math.min(0.24, 9 * dt);
    Tn.set(T);
    for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      const c = i + j * nx;
      let flow = 0;
      for (const o of [c - 1, c + 1, c - nx, c + nx]) flow += 0.5 * (k[c] + k[o]) * (T[o] - T[c]);
      Tn[c] = T[c] + (rate * flow) / cap[c];
    }
    T.set(Tn);

    // Hot air rises: move heat from an air cell into the open cell above it.
    const lift = Math.min(0.45, 20 * dt);
    for (let j = 2; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      const c = i + j * nx, up = c - nx;
      if (ct[c] !== AIR || f.s[up] === 0) continue;
      const d = T[c] - T[up];
      if (d > 0) { const q = d * lift * 0.5; T[c] -= q; T[up] += q; }
    }

    // Everything drifts back toward room temperature; open air fastest.
    for (let c = 0; c < nx * ny; c++) {
      let r = 0.003;
      if (ct[c] === AIR) r = f.region[c] >= 0 && f.regionAtmosphere[f.region[c]] ? 0.4 : 0.02;
      else if (mat[c] === STONE) r = 0.02;
      T[c] += (AMBIENT - T[c]) * Math.min(1, r * dt);
    }
  }

  /** Particles pick up the temperature change of their cell. */
  private cellsToLiquid() {
    const f = this.fluid;
    for (let k = 0; k < f.count; k++) {
      const c = this.cellAt(f.pos[2 * k], f.pos[2 * k + 1]);
      if (c < 0 || this.cnt[c] === 0) continue;
      f.temp[k] += this.T[c] - this.sumT[c] / this.cnt[c];
    }
  }

  private boilAndFreeze(dt: number) {
    const f = this.fluid, { T, mat, nx, ny } = this;

    // Boiling: water at 100° turns to steam, absorbing heat (so a pot boils steadily instead of all at once).
    for (let k = f.count - 1; k >= 0; k--) {
      if (f.kind[k] !== WATER || f.temp[k] < BOIL) continue;
      const c = this.cellAt(f.pos[2 * k], f.pos[2 * k + 1]);
      const submerged = c >= 0 && !this.hasAirNeighbor(c);
      const flash = submerged && f.temp[k] >= FLASH_POINT;
      if (flash || Math.random() < BOIL_RATE * dt * Math.min(4, 1 + (f.temp[k] - BOIL) / 20)) {
        this.addSteam(f.pos[2 * k], f.pos[2 * k + 1], f.vel[2 * k] * 0.3, -20, BOIL + 5);
        if (c >= 0) {
          this.pending[c] -= BOIL_LATENT;
          this.residue[c] += f.silt[k];
          // Steam is huge compared with the water it came from. Boiling under liquid (water sunk beneath hot oil,
          // or superheated water) bursts outward; boiling at an open surface just bubbles off.
          if (submerged) f.expansion[c] += FLASH_EXPANSION * Math.min(3, 1 + (f.temp[k] - BOIL) / 50);
        }
        f.removeParticle(k);
      } else if (!submerged) f.temp[k] = BOIL; // at an open surface extra heat goes into boiling; trapped water superheats
    }

    // Solidifying: a cold cell that is mostly water becomes ice; mostly molten wax becomes solid wax.
    // Only that liquid is used up; anything else in the cell gets pushed out by the solver.
    let changed = false;
    const freeze = new Map<number, number>(); // cell → liquid kind that solidified
    for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      const c = i + j * nx;
      if (f.cellType[c] !== FLUID || this.cnt[c] === 0) continue;
      if (T[c] < -1 && this.cntWater[c] > this.cnt[c] / 2) freeze.set(c, WATER);
      else if (T[c] < WAX_SET && this.cntWax[c] > this.cnt[c] / 2) freeze.set(c, WAX);
    }
    if (freeze.size) {
      for (const [c, kind] of freeze) { mat[c] = kind === WATER ? ICE : WAX_SOLID; f.s[c] = 0; this.melt[c] = 0; }
      for (let k = f.count - 1; k >= 0; k--) {
        const kind = freeze.get(this.cellAt(f.pos[2 * k], f.pos[2 * k + 1]));
        if (kind !== undefined && f.kind[k] === kind) f.removeParticle(k);
      }
      changed = true;
    }

    // Melting: warm ice turns back into water.
    const sp = 2 * f.radius;
    for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      const c = i + j * nx;
      const isIce = mat[c] === ICE;
      if (!isIce && mat[c] !== WAX_SOLID) continue;
      const meltAt = isIce ? 0 : WAX_MELT;
      if (T[c] <= meltAt) continue;
      // Holds at its melting point while soaking up latent heat, then turns liquid.
      this.melt[c] += T[c] - meltAt;
      T[c] = meltAt;
      if (this.melt[c] < (isIce ? MELT_LATENT : WAX_LATENT)) continue;
      this.melt[c] = 0;
      mat[c] = NONE;
      f.s[c] = 1;
      T[c] = meltAt + 1;
      for (let y = j * this.h + f.radius; y < (j + 1) * this.h; y += sp)
        for (let x = i * this.h + f.radius; x < (i + 1) * this.h; x += sp) f.addParticle(x, y, 0, 0, isIce ? WATER : WAX, meltAt + 1);
      changed = true;
    }
    if (changed) this.solidChanges++;
  }

  /** Steam rises (fast through water, as bubbles), drifts, warms what it touches, and condenses when cool. */
  private moveSteam(dt: number) {
    const f = this.fluid, g = f.params.gravity;
    for (let k = this.steamCount - 1; k >= 0; k--) {
      const c = this.cellAt(this.sx[k], this.sy[k]);
      if (c < 0) { this.removeSteam(k); continue; }
      const inLiquid = f.cellType[c] === FLUID;

      // Exchange heat with the cell.
      const d = this.T[c] - this.sT[k];
      this.sT[k] += d * Math.min(1, (inLiquid ? 0.5 : 0.8) * dt);
      this.pending[c] -= d * Math.min(1, 0.2 * dt);

      // Condenses a few degrees below boiling (hysteresis), so steam in a hot sealed pocket persists and builds pressure.
      const CONDENSE_AT = BOIL - 5;
      if (this.sT[k] < CONDENSE_AT && Math.random() < CONDENSE_RATE * dt * (1 + (CONDENSE_AT - this.sT[k]) / 30)) {
        if (f.addParticle(this.sx[k], this.sy[k], this.svx[k], this.svy[k], WATER, BOIL - 5)) this.pending[c] += CONDENSE_LATENT;
        this.removeSteam(k);
        continue;
      }

      const lift = inLiquid ? 1.2 * g : 0.3 * g;
      this.svy[k] -= lift * dt;
      this.svx[k] += (Math.random() - 0.5) * 300 * dt;
      const drag = Math.exp(-(inLiquid ? 6 : 3) * dt);
      this.svx[k] *= drag;
      this.svy[k] *= drag;
      const nx = this.sx[k] + this.svx[k] * dt, ny = this.sy[k] + this.svy[k] * dt;
      if (!f.solidAt(nx, this.sy[k])) this.sx[k] = nx; else this.svx[k] *= -0.3;
      if (!f.solidAt(this.sx[k], ny)) this.sy[k] = ny;
      else if (this.svy[k] < 0) {
        // Blocked from above: like a bubble under a tilted roof, slide toward whichever side the ceiling rises.
        // Compare how high the ceiling is a little way to each side, and slide toward the higher side.
        // (Checking for open space alone fails under a thin roof: there's open air above it on the low side.)
        const x = this.sx[k], y = this.sy[k], hh = this.h / 2;
        const ceiling = (xx: number) => { for (let s = 0; s <= 16; s++) if (f.solidAt(xx, y - s * hh)) return s; return 99; };
        let dir = 0;
        for (let d = 1; d <= 12 && dir === 0; d++) {
          const l = ceiling(x - d * this.h), r = ceiling(x + d * this.h);
          if (l !== r) dir = r > l ? 1 : -1;
        }
        if (dir !== 0) this.svx[k] += dir * Math.abs(this.svy[k]) * 0.9;
        this.svy[k] *= -0.1;
      } else this.svy[k] *= -0.3;
    }
  }

  private moveFlames(dt: number) {
    const f = this.fluid;
    for (let k = this.flameCount - 1; k >= 0; k--) {
      this.fLife[k] -= dt;
      const c = this.cellAt(this.fx[k], this.fy[k]);
      const hit = c < 0 || f.s[c] === 0 || f.cellType[c] === FLUID;
      if (c >= 0) {
        if (hit) this.T[c] += FLAME_TOUCH;
        else this.T[c] += FLAME_HEAT * dt * (this.fLife[k] / this.fMax[k]);
      }
      if (this.fLife[k] <= 0 || hit) {
        const l = --this.flameCount;
        this.fx[k] = this.fx[l]; this.fy[k] = this.fy[l]; this.fvx[k] = this.fvx[l]; this.fvy[k] = this.fvy[l];
        this.fLife[k] = this.fLife[l]; this.fMax[k] = this.fMax[l];
        continue;
      }
      this.fvx[k] += (Math.random() - 0.5) * 200 * dt;
      this.fx[k] += this.fvx[k] * dt;
      this.fy[k] += this.fvy[k] * dt;
    }
  }
}
