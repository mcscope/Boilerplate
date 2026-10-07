/**
 * Validation for src/sim2/phase.ts (workstream C). Standalone: uses a real Fluid for particles and synthetic gas
 * fields with a tiny fake loop (classification, vapor diffusion, droplet fall, pending release).
 * Run: node_modules/.bin/esbuild tests/phase/phase.test.ts --bundle --platform=node --outfile=/tmp/phase.cjs && node /tmp/phase.cjs
 */
import { Fluid } from '../../src/sim/fluid';
import { phaseChange, phaseLedger, phaseBalance, resetPhase, H_VAPOR, CAP_GAS, CAP_SOLID, tsat } from '../../src/sim2/phase';
import { GAS, LIQUID, SOLID, P0, RHO_AIR, GasState, MacGrid, PhaseContext, saturatedVapor } from '../../src/sim2/types';

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
  if (!ok) failures++;
}

/** A bare particle store (Fluid is abstract; these tests never step it). */
class ParticleStore extends Fluid { step() {} }

class Scene {
  f: Fluid; grid: MacGrid; gas: GasState; pressure: Float32Array; residue: Float32Array; ctx: PhaseContext; n: number;
  counts = new Float32Array(0);
  tmp = new Float32Array(0);
  constructor(public nx: number, public ny: number, maxP = 20000) {
    const h = 2, n = nx * ny;
    this.n = n;
    this.f = new ParticleStore(nx, ny, h, maxP);
    this.grid = { nx, ny, h, u: this.f.u, v: this.f.v, s: this.f.s, cellType: new Int32Array(n) };
    this.gas = { air: new Float32Array(n).fill(RHO_AIR), vapor: new Float32Array(n), T: new Float32Array(n).fill(20), pendingAir: new Float32Array(n), pendingVapor: new Float32Array(n) };
    this.pressure = new Float32Array(n).fill(P0);
    this.residue = new Float32Array(n);
    const f = this.f;
    this.ctx = {
      grid: this.grid, gas: this.gas, pressure: this.pressure, dt: 1 / 240, residue: this.residue,
      particles: {
        get count() { return f.count; }, pos: f.pos, vel: f.vel, kind: f.kind, temp: f.temp, silt: f.silt,
        add: (x: number, y: number, vx: number, vy: number, k: number, t: number, s: number) => f.addParticle(x, y, vx, vy, k, t, s),
        remove: (k: number) => f.removeParticle(k),
      },
      restDensity: f.restDensity,
    } as PhaseContext;
    resetPhase();
  }
  get MP() { return 1 / this.f.restDensity; }
  fillWater(i0: number, j0: number, i1: number, j1: number, T: number, kind = 0) {
    const f = this.f, sp = 2 * f.radius, h = f.h;
    for (let y = j0 * h + f.radius; y < j1 * h; y += sp) for (let x = i0 * h + f.radius; x < i1 * h; x += sp) f.addParticle(x, y, 0, 0, kind, T, 0.01);
  }
  classify() {
    const { f, n, nx } = this, ct = this.grid.cellType;
    if (this.counts.length !== n) this.counts = new Float32Array(n);
    const cnt = this.counts; cnt.fill(0);
    for (let k = 0; k < f.count; k++) cnt[Math.floor(f.pos[2 * k] / f.h) + Math.floor(f.pos[2 * k + 1] / f.h) * nx]++;
    for (let c = 0; c < n; c++) {
      const prev = ct[c];
      ct[c] = f.s[c] === 0 ? SOLID : cnt[c] >= 1 ? LIQUID : GAS;
      if (ct[c] === GAS && prev === LIQUID) { this.gas.vapor[c] += this.gas.pendingVapor[c]; this.gas.pendingVapor[c] = 0; }
      if (ct[c] === LIQUID && prev === GAS) { this.gas.pendingVapor[c] += this.gas.vapor[c]; this.gas.vapor[c] = 0; }
    }
  }
  diffuse(D: number) {
    const { n, nx } = this, ct = this.grid.cellType, v = this.gas.vapor;
    if (this.tmp.length !== n) this.tmp = new Float32Array(n);
    const dv = this.tmp; dv.fill(0);
    for (let c = nx; c < n - nx; c++) {
      if (ct[c] !== GAS) continue;
      for (const o of [c + 1, c + nx]) if (ct[o] === GAS) { const q = D * (v[c] - v[o]); dv[c] -= q; dv[o] += q; }
    }
    for (let c = 0; c < n; c++) v[c] += dv[c];
  }
  fall(dt: number) {
    const f = this.f;
    for (let k = 0; k < f.count; k++) {
      if (f.vel[2 * k + 1] === 0) continue;
      const y = f.pos[2 * k + 1] + f.vel[2 * k + 1] * dt * 20;
      if (!f.solidAt(f.pos[2 * k], y)) f.pos[2 * k + 1] = y; else f.vel[2 * k + 1] = 0;
    }
  }
  liquidMass() { let m = 0; for (let k = 0; k < this.f.count; k++) if (this.f.kind[k] === 0) m += this.MP; return m - phaseLedger().mass; }
  vaporMass() { let v = 0; for (let c = 0; c < this.n; c++) v += this.gas.vapor[c] + this.gas.pendingVapor[c]; return v; }
  mass() { return this.liquidMass() + this.vaporMass(); }
  energy() {
    const f = this.f, ct = this.grid.cellType, T = this.gas.T;
    let e = 0;
    for (let k = 0; k < f.count; k++) e += this.MP * f.temp[k];
    for (let c = 0; c < this.n; c++) {
      if (f.s[c] === 0) e += CAP_SOLID * T[c];
      else if (ct[c] === GAS) e += CAP_GAS * T[c];
      e += H_VAPOR * (this.gas.vapor[c] + this.gas.pendingVapor[c]);
    }
    return e - phaseLedger().heat;
  }
  meanWaterT() { let s = 0, n = 0; for (let k = 0; k < this.f.count; k++) if (this.f.kind[k] === 0) { s += this.f.temp[k]; n++; } return s / n; }
}

// ---- 1. mass conservation in a busy closed box (superheated pool, cold ceiling, oil, droplets, boiling) ----
{
  const nx = 40, ny = 30;
  const S = new Scene(nx, ny);
  for (let i = 0; i < nx; i++) { S.gas.T[i + nx] = 10; S.gas.T[i] = 5; }
  S.fillWater(3, 18, 37, ny - 1, 110);
  S.fillWater(10, 14, 14, 16, 60, 1);
  S.classify();
  const m0 = S.mass(), n0 = S.f.count;
  let maxErr = 0;
  for (let step = 0; step < 4000; step++) {
    S.classify();
    phaseChange(S.ctx);
    S.diffuse(0.2);
    S.fall(S.ctx.dt);
    maxErr = Math.max(maxErr, Math.abs(S.mass() - m0) / m0);
  }
  console.log(`  busy box: particles ${n0} -> ${S.f.count}, vapor ${S.vaporMass().toFixed(3)}, ledger ${phaseLedger().mass.toFixed(4)}`);
  check('mass conservation (4000 calls)', maxErr < 1e-6, `max rel err ${maxErr.toExponential(2)}`);
  const e1 = S.energy();
  for (let step = 0; step < 4000; step++) { phaseChange(S.ctx); S.diffuse(0.2); }
  const drift = Math.abs(S.energy() - e1) / Math.abs(e1);
  check('energy conservation (4000 more calls, frozen cell types)', drift < 1e-5, `rel drift ${drift.toExponential(2)} (E=${e1.toFixed(1)})`);
}

// ---- 2. energy per call, with boiling, condensation, removals and spawns ----
{
  const S = new Scene(40, 30);
  S.fillWater(3, 18, 37, 29, 125);
  for (let c = 0; c < 40; c++) S.gas.T[c] = 0;
  let worst = 0, cum = 0;
  for (let step = 0; step < 3000; step++) {
    S.classify();
    const e = S.energy();
    phaseChange(S.ctx);
    const d = S.energy() - e;
    worst = Math.max(worst, Math.abs(d)); cum += d;
    S.diffuse(0.2); S.fall(S.ctx.dt);
  }
  check('energy per call (boiling + condensation + spawns)', Math.abs(cum) < 1e-5 * S.energy(), `worst |ΔE| per call ${worst.toExponential(2)}, cumulative ${cum.toExponential(2)} (E≈${S.energy().toFixed(0)})`);
}

// ---- 3. evaporation rates ----
function evapRate(Tw: number, seconds: number) {
  const S = new Scene(40, 30);
  S.fillWater(1, 20, 39, 29, Tw);
  S.classify();
  let cols = 0;
  for (let c = 0; c < S.n - 40; c++) if (S.grid.cellType[c] === GAS && S.grid.cellType[c + 40] === LIQUID) cols++;
  const steps = Math.round(seconds / S.ctx.dt);
  const l0 = S.liquidMass(), p0 = S.f.count;
  let evaporated = 0;
  for (let k = 0; k < steps; k++) {
    phaseChange(S.ctx);
    for (let c = 0; c < S.n; c++) { evaporated += S.gas.vapor[c]; S.gas.vapor[c] = 0; } // dry wind
    for (let q = 0; q < S.f.count; q++) S.f.temp[q] = Tw; // heater
  }
  return { perCell: evaporated / seconds / cols, frac: evaporated / l0, particles: p0 - S.f.count };
}
{
  const r20 = evapRate(20, 60), r95 = evapRate(95, 10);
  console.log(`  20 °C, dry wind, 60 s: ${r20.perCell.toExponential(2)} mass/s per surface cell; ${(r20.frac * 100).toFixed(2)}% of a 9-deep pool, ${r20.particles} particles removed`);
  console.log(`  95 °C, dry wind, 10 s: ${r95.perCell.toExponential(2)} mass/s per surface cell; ${(r95.frac * 100).toFixed(2)}% of pool, ${r95.particles} particles removed`);
  check('room-temp evaporation slow', r20.frac < 0.05, `${(r20.frac * 100).toFixed(2)}% per minute even with permanently dry air`);
  check('95 °C water steams fast', r95.perCell > 20 * r20.perCell, `ratio ${(r95.perCell / r20.perCell).toFixed(1)}x`);
  const S = new Scene(40, 30); S.fillWater(1, 20, 39, 29, 95); S.classify();
  for (let k = 0; k < 240; k++) phaseChange(S.ctx);
  const c = 20 + 19 * 40;
  console.log(`  95 °C still air after 1 s: vapor above surface ${S.gas.vapor[c].toExponential(3)} (sat(95)=${saturatedVapor(95).toExponential(3)}), mean water T ${S.meanWaterT().toFixed(2)}`);
}
{
  const S = new Scene(20, 20);
  S.classify();
  const vap0 = saturatedVapor(60);
  for (let c = 0; c < S.n; c++) if (S.f.s[c] !== 0) { S.gas.vapor[c] = vap0; S.gas.T[c] = 60; }
  const target = 2 + 10 * 20; S.gas.T[target] = 10;
  // a steam source near the floor (stand-in for a boiling pot below): 0.3 mass/s ≈ 0.8 particle/s
  const src = 10 + 17 * 20, rate = 0.3;
  let injected = S.vaporMass();
  for (let k = 0; k < 2400; k++) {
    for (let i = 0; i < 20; i++) S.gas.T[i] = 10; // ceiling held cold (chiller)
    S.gas.vapor[src] += rate * S.ctx.dt; injected += rate * S.ctx.dt;
    S.classify(); phaseChange(S.ctx); S.diffuse(0.2); S.fall(S.ctx.dt);
  }
  const condensed = injected - S.vaporMass();
  if (process.env.DEBUG) { const b = phaseBalance(); for (let j = 0; j < 20; j++) console.log(Array.from(b.subarray(j * 20, j * 20 + 20), (x) => (x * 100).toFixed(0).padStart(4)).join('') + '   ' + Array.from(S.grid.cellType.subarray(j * 20, j * 20 + 20)).join('')); }
  check('vapor condenses on a cold ceiling into droplets', S.f.count >= 3, `${S.f.count} droplets in 10 s; condensed ${condensed.toFixed(3)} of ${injected.toFixed(3)} vapor supplied (liquid now ${S.liquidMass().toFixed(3)})`);
  // single cold cell, no cold walls: fog limited by its own latent heat
  const F = new Scene(20, 20); F.classify();
  F.gas.vapor[target] = saturatedVapor(60); F.gas.T[target] = 10;
  for (let k = 0; k < 240; k++) phaseChange(F.ctx);
  console.log(`  fog in one 10 °C cell with 60 °C-saturated vapor: cell warmed to ${F.gas.T[target].toFixed(1)} °C, vapor ${F.gas.vapor[target].toExponential(3)} vs sat ${saturatedVapor(F.gas.T[target]).toExponential(3)}`);
}

// ---- 4. superheat ----
function superheat(p: number) {
  const S = new Scene(30, 30);
  S.fillWater(1, 1, 29, 29, 120); // fills the box: no interface, only boiling
  S.classify();
  S.pressure.fill(p);
  const l0 = S.liquidMass();
  phaseChange(S.ctx);
  return { conv: (l0 - S.liquidMass()) / l0, T: S.meanWaterT(), pend: S.vaporMass() };
}
{
  const a = superheat(P0), b = superheat(2 * P0);
  check('120 °C at P0 boils its superheat away', Math.abs(a.conv - 20 / 540) < 0.002 && Math.abs(a.T - 100) < 0.01, `converted ${(a.conv * 100).toFixed(3)}% (expect ${(100 * 20 / 540).toFixed(3)}%), T ${a.T.toFixed(3)}`);
  check('120 °C at 2·P0 does not boil', b.conv < 1e-6 && b.T > 119.9, `Tsat(2P0)=${tsat(2 * P0).toFixed(2)} °C, converted ${(b.conv * 100).toFixed(4)}%, T ${b.T.toFixed(2)}`);
}

// ---- 5. timing 160x90, ~5k particles ----
{
  const S = new Scene(160, 90, 20000);
  S.fillWater(20, 72, 140, 89, 80);
  S.fillWater(60, 66, 100, 72, 105);
  S.classify();
  for (let c = 0; c < S.n; c++) S.gas.vapor[c] = S.grid.cellType[c] === GAS ? 0.0003 : 0;
  for (let k = 0; k < 50; k++) phaseChange(S.ctx);
  const N = 300, t0 = performance.now();
  for (let k = 0; k < N; k++) phaseChange(S.ctx);
  const ms = (performance.now() - t0) / N;
  check('timing 160x90', ms <= 1, `${ms.toFixed(3)} ms/call with ${S.f.count} particles`);
}

if (failures) { console.log(`${failures} failed`); process.exit(1); } else console.log('all passed');
