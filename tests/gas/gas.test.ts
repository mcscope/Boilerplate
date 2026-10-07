/**
 * Gas transport checks (src/sim2/gas.ts) on synthetic grids.
 * Run: node_modules/.bin/esbuild tests/gas/gas.test.ts --bundle --platform=node --outfile=/tmp/gas.test.cjs && node /tmp/gas.test.cjs
 */
import { gasTransport } from '../../src/sim2/gas';
import { GAS, GasState, LIQUID, MacGrid, RHO_AIR, SOLID } from '../../src/sim2/types';

const NX = 160, NY = 90, H = 2;
let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
  if (!ok) failures++;
}

function makeGrid(): MacGrid {
  const n = NX * NY;
  const g: MacGrid = { nx: NX, ny: NY, h: H, u: new Float32Array(n), v: new Float32Array(n), s: new Float32Array(n), cellType: new Int32Array(n) };
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const c = i + j * NX;
    const solid = i === 0 || j === 0 || i === NX - 1 || j === NY - 1;
    g.s[c] = solid ? 0 : 1;
    g.cellType[c] = solid ? SOLID : GAS;
  }
  return g;
}
function makeGas(g: MacGrid, fill = RHO_AIR): GasState {
  const n = g.nx * g.ny;
  const s: GasState = { air: new Float32Array(n), vapor: new Float32Array(n), T: new Float32Array(n).fill(20), pendingAir: new Float32Array(n), pendingVapor: new Float32Array(n) };
  for (let c = 0; c < n; c++) if (g.cellType[c] === GAS) s.air[c] = fill;
  return s;
}
/** Velocity from stream function psi at cell corners: u = dpsi/dy, v = -dpsi/dx (discretely divergence-free). */
function setStream(g: MacGrid, psi: (x: number, y: number) => number) {
  for (let j = 1; j < NY - 1; j++) for (let i = 1; i < NX - 1; i++) {
    const c = i + j * NX;
    g.u[c] = (psi(i * H, (j + 1) * H) - psi(i * H, j * H)) / H;
    g.v[c] = -(psi((i + 1) * H, j * H) - psi(i * H, j * H)) / H;
  }
  for (let j = 0; j < NY; j++) { g.u[1 + j * NX] = 0; g.u[NX - 1 + j * NX] = 0; }
  for (let i = 0; i < NX; i++) { g.v[i + NX] = 0; g.v[i + (NY - 1) * NX] = 0; }
}
function minOf(a: Float32Array) { let m = Infinity; for (const x of a) if (x < m) m = x; return m; }
const W = NX * H, HH = NY * H;
const basin = (amp: number) => (x: number, y: number) => amp * W / Math.PI * Math.sin(Math.PI * x / W) * Math.sin(Math.PI * y / HH);

// ---------------------------------------------------------------- 1. conservation in a vortex
{
  const g = makeGrid();
  const s = makeGas(g);
  for (let j = 1; j < NY - 1; j++) for (let i = 1; i < NX - 1; i++) {
    s.air[i + j * NX] = RHO_AIR * (1 + 0.8 * Math.sin(i * 0.21) * Math.cos(j * 0.17) + 0.15 * Math.sin(i * 0.9 + j * 0.7));
    s.vapor[i + j * NX] = (i > 60 && i < 90 && j > 30 && j < 50) ? 0.01 : 0;
  }
  const amp = 300 * W / Math.PI;
  setStream(g, (x, y) => amp * Math.sin(Math.PI * x / W) * Math.sin(Math.PI * y / HH) + 0.3 * amp * Math.sin(2 * Math.PI * x / W) * Math.sin(3 * Math.PI * y / HH));
  const t0 = gasTransport.totals(s);
  let minSeen = Infinity;
  for (let k = 0; k < 1000; k++) {
    gasTransport.advect(g, s, 1 / 120);
    const m = Math.min(minOf(s.air), minOf(s.vapor));
    if (m < minSeen) minSeen = m;
  }
  const t1 = gasTransport.totals(s);
  const ra = Math.abs(t1.air - t0.air) / t0.air, rv = Math.abs(t1.vapor - t0.vapor) / t0.vapor;
  check('conservation (vortex, 1000 steps)', ra < 1e-4 && rv < 1e-4 && minSeen >= 0, `air rel err ${ra.toExponential(2)}, vapor rel err ${rv.toExponential(2)}, min ${minSeen}`);
}

// ---------------------------------------------------------------- 1b. compressive flow: positivity stress
{
  const g = makeGrid();
  const s = makeGas(g);
  for (let j = 1; j < NY - 1; j++) for (let i = 2; i < NX - 1; i++) g.u[i + j * NX] = 900 * Math.sin(i * 0.3 + j * 0.1);
  for (let j = 2; j < NY - 1; j++) for (let i = 1; i < NX - 1; i++) g.v[i + j * NX] = 700 * Math.cos(j * 0.4 - i * 0.05);
  const t0 = gasTransport.totals(s).air;
  let minSeen = Infinity;
  for (let k = 0; k < 300; k++) { gasTransport.advect(g, s, 1 / 120); minSeen = Math.min(minSeen, minOf(s.air)); }
  const ra = Math.abs(gasTransport.totals(s).air - t0) / t0;
  check('positivity (compressive, 900 px/s)', minSeen >= 0 && ra < 1e-4, `min ${minSeen}, rel err ${ra.toExponential(2)}`);
}

// ---------------------------------------------------------------- 2. blob transport
{
  const g = makeGrid();
  const s = makeGas(g, 0);
  const U = 100, V = 40;
  for (let c = 0; c < NX * NY; c++) { g.u[c] = U; g.v[c] = V; }
  for (let j = 0; j < NY; j++) { g.u[1 + j * NX] = 0; g.u[NX - 1 + j * NX] = 0; }
  for (let i = 0; i < NX; i++) { g.v[i + NX] = 0; g.v[i + (NY - 1) * NX] = 0; }
  const cx0 = 40, cy0 = 30, R = 6;
  const moments = () => {
    let m = 0, mx = 0, my = 0, mxx = 0, peak = 0;
    for (let j = 1; j < NY - 1; j++) for (let i = 1; i < NX - 1; i++) { const a = s.air[i + j * NX]; m += a; mx += a * i; my += a * j; mxx += a * i * i; if (a > peak) peak = a; }
    const x = mx / m; return { m, x, y: my / m, sx: Math.sqrt(mxx / m - x * x), peak };
  };
  for (let j = 1; j < NY - 1; j++) for (let i = 1; i < NX - 1; i++) {
    s.air[i + j * NX] = Math.hypot(i + 0.5 - cx0, j + 0.5 - cy0) < R ? 1 : 0;
  }
  const a0 = moments();
  for (let k = 0; k < 120; k++) gasTransport.advect(g, s, 1 / 120);
  const a1 = moments();
  const ex = U / H, ey = V / H;
  const errX = a1.x - a0.x - ex, errY = a1.y - a0.y - ey;
  check('blob transport speed', Math.abs(errX) < 0.5 && Math.abs(errY) < 0.5 && a1.peak <= 1 + 1e-6,
    `moved (${(a1.x - a0.x).toFixed(2)}, ${(a1.y - a0.y).toFixed(2)}) cells, expected (${ex}, ${ey}); peak ${a1.peak.toFixed(3)} (was 1); x-std ${a0.sx.toFixed(2)} -> ${a1.sx.toFixed(2)} cells; mass err ${(Math.abs(a1.m - a0.m) / a0.m).toExponential(2)}`);
}

// ---------------------------------------------------------------- 3. remap
{
  const g = makeGrid();
  const s = makeGas(g);
  const prev = new Int32Array(g.cellType);
  const tot0 = gasTransport.totals(s).air;
  // a 6-row slab of liquid appears (all of its gas is within reach of gas above/below)
  for (let j = 45; j <= 50; j++) for (let i = 1; i < NX - 1; i++) g.cellType[i + j * NX] = LIQUID;
  gasTransport.remap(g, s, prev);
  let liquidMass = 0, pendingSum = 0;
  for (let c = 0; c < NX * NY; c++) pendingSum += s.pendingAir[c];
  for (let j = 45; j <= 50; j++) for (let i = 1; i < NX - 1; i++) liquidMass += s.air[i + j * NX];
  const tot1 = gasTransport.totals(s);
  const ra = Math.abs(tot1.air - tot0) / tot0;
  check('remap: gas -> liquid conserves, liquid holds none', ra < 1e-5 && liquidMass === 0 && pendingSum === 0, `rel err ${ra.toExponential(2)}, pending ${pendingSum}, row-44 air ${s.air[80 + 44 * NX].toFixed(4)} (ambient ${RHO_AIR})`);

  prev.set(g.cellType);
  for (let j = 46; j <= 49; j++) g.cellType[80 + j * NX] = GAS; // a hole opens inside the slab
  gasTransport.remap(g, s, prev);
  let maxNew = 0; for (let j = 46; j <= 49; j++) maxNew = Math.max(maxNew, s.air[80 + j * NX]);
  check('remap: liquid -> gas starts as vacuum', maxNew === 0, `max air in new cells ${maxNew}`);

  // sealed bubble deep in liquid collapses -> pending; then reappears 2 cells over
  const g2 = makeGrid();
  for (let j = 1; j < NY - 1; j++) for (let i = 1; i < NX - 1; i++) g2.cellType[i + j * NX] = LIQUID;
  const b = 50 + 60 * NX;
  g2.cellType[b] = GAS; g2.cellType[b + 1] = GAS;
  const s2 = makeGas(g2);
  s2.vapor[b] = 0.003;
  const before = gasTransport.totals(s2);
  const p2 = new Int32Array(g2.cellType);
  g2.cellType[b] = LIQUID; g2.cellType[b + 1] = LIQUID;
  gasTransport.remap(g2, s2, p2);
  const mid = gasTransport.totals(s2);
  const pend = s2.pendingAir[b] + s2.pendingAir[b + 1];
  check('remap: no gas reachable -> pending', Math.abs(pend - 2 * RHO_AIR) < 1e-7 && Math.abs(mid.air - before.air) < 1e-7 && Math.abs(mid.vapor - before.vapor) < 1e-9,
    `pending air ${pend.toFixed(4)}, totals air ${before.air.toFixed(4)} -> ${mid.air.toFixed(4)}, vapor ${before.vapor.toFixed(4)} -> ${mid.vapor.toFixed(4)}`);
  p2.set(g2.cellType);
  g2.cellType[b + 2] = GAS;
  gasTransport.remap(g2, s2, p2);
  const after = gasTransport.totals(s2);
  check('remap: pending released into new gas cell', Math.abs(s2.air[b + 2] - 2 * RHO_AIR) < 1e-7 && Math.abs(s2.vapor[b + 2] - 0.003) < 1e-9 && s2.pendingAir[b] === 0 && Math.abs(after.air - before.air) < 1e-7,
    `new cell air ${s2.air[b + 2].toFixed(4)}, vapor ${s2.vapor[b + 2].toFixed(4)}`);

  // gas -> solid
  const g3 = makeGrid(); const s3 = makeGas(g3); const p3 = new Int32Array(g3.cellType);
  const t3 = gasTransport.totals(s3).air;
  for (let j = 20; j < 30; j++) for (let i = 20; i < 30; i++) { g3.cellType[i + j * NX] = SOLID; g3.s[i + j * NX] = 0; }
  gasTransport.remap(g3, s3, p3);
  const r3 = Math.abs(gasTransport.totals(s3).air - t3) / t3;
  check('remap: gas -> solid conserves', r3 < 1e-5 && s3.air[25 + 25 * NX] === 0 && s3.pendingAir[25 + 25 * NX] === 0, `rel err ${r3.toExponential(2)}, centre-of-block air ${s3.air[25 + 25 * NX]}`);
  // the block disappears again (SOLID -> GAS): it opens up at ambient, not as a vacuum
  const p3b = new Int32Array(g3.cellType);
  for (let j = 20; j < 30; j++) for (let i = 20; i < 30; i++) { g3.cellType[i + j * NX] = GAS; g3.s[i + j * NX] = 1; }
  gasTransport.remap(g3, s3, p3b);
  check('remap: solid -> gas fills with ambient air', s3.air[25 + 25 * NX] === Math.fround(RHO_AIR), `centre air ${s3.air[25 + 25 * NX].toFixed(4)}`);
}

// ---------------------------------------------------------------- 4. velocity advection
{
  const g = makeGrid();
  for (let c = 0; c < NX * NY; c++) { g.u[c] = 50; g.v[c] = -30; }
  for (let k = 0; k < 100; k++) gasTransport.advectVelocity(g, 1 / 120);
  let maxDev = 0;
  for (let j = 5; j < NY - 5; j++) for (let i = 5; i < NX - 5; i++) {
    const c = i + j * NX; maxDev = Math.max(maxDev, Math.abs(g.u[c] - 50), Math.abs(g.v[c] + 30));
  }
  check('velocity: uniform flow stays uniform', maxDev < 1e-3, `max deviation in interior ${maxDev.toExponential(2)} px/s`);

  const g2 = makeGrid();
  const xc = W / 2, yc = HH / 2, sig = 20;
  setStream(g2, (x, y) => 200 * sig * Math.exp(-((x - xc) ** 2 + (y - yc) ** 2) / (2 * sig * sig)));
  const ke = () => { let e = 0; for (let c = 0; c < NX * NY; c++) e += g2.u[c] ** 2 + g2.v[c] ** 2; return e; };
  const probe = () => g2.v[Math.floor(xc / H + 8) + Math.floor(yc / H) * NX];
  const e0 = ke(), c0 = probe();
  // Incompressible test projection (Gauss-Seidel): without it, pure self-advection of a vortex isn't steady.
  const project = () => {
    for (let it = 0; it < 60; it++) for (let j = 1; j < NY - 1; j++) for (let i = 1; i < NX - 1; i++) {
      const c = i + j * NX;
      const sl = g2.s[c - 1], sr = g2.s[c + 1], st = g2.s[c - NX], sb = g2.s[c + NX], sum = sl + sr + st + sb;
      if (!sum) continue;
      const d = 1.9 * (g2.u[c + 1] - g2.u[c] + g2.v[c + NX] - g2.v[c]) / sum;
      g2.u[c] += sl * d; g2.u[c + 1] -= sr * d; g2.v[c] += st * d; g2.v[c + NX] -= sb * d;
    }
  };
  for (let k = 0; k < 240; k++) { gasTransport.advectVelocity(g2, 1 / 120); project(); }
  const e1 = ke(), c1 = probe();
  check('velocity: vortex keeps rotating', e1 < e0 * 1.0001 && e1 > 0.5 * e0 && c1 > 0.5 * c0,
    `after 2 s (~2 turns, with projection): KE ${(100 * e1 / e0).toFixed(1)}%, v at r=8 cells ${c0.toFixed(1)} -> ${c1.toFixed(1)}`);

  const g3 = makeGrid();
  for (let c = 0; c < NX * NY; c++) { g3.u[c] = 100; g3.v[c] = 0; }
  g3.cellType[50 + 50 * NX] = LIQUID; g3.u[50 + 50 * NX] = 7; g3.u[51 + 50 * NX] = 7;
  gasTransport.advectVelocity(g3, 1 / 60);
  check('velocity: liquid faces untouched', g3.u[50 + 50 * NX] === 7 && g3.u[51 + 50 * NX] === 7, 'ok');
}

// ---------------------------------------------------------------- 4b. temperature: bounded
{
  const g = makeGrid(); const s = makeGas(g);
  for (let j = 1; j < NY - 1; j++) for (let i = 1; i < NX - 1; i++) s.T[i + j * NX] = i < 80 ? 100 : 20;
  for (let j = 50; j < NY - 1; j++) for (let i = 1; i < NX - 1; i++) g.cellType[i + j * NX] = LIQUID;
  setStream(g, basin(300));
  for (let k = 0; k < 500; k++) gasTransport.advect(g, s, 1 / 120);
  let lo = Infinity, hi = -Infinity;
  for (let j = 1; j < NY - 1; j++) for (let i = 1; i < NX - 1; i++) { const t = s.T[i + j * NX]; lo = Math.min(lo, t); hi = Math.max(hi, t); }
  check('temperature: no new extrema', lo >= 20 - 1e-3 && hi <= 100 + 1e-3, `T range [${lo.toFixed(3)}, ${hi.toFixed(3)}]`);
}

// ---------------------------------------------------------------- 4c. atmosphere
{
  const g = makeGrid(); const s = makeGas(g, 0);
  gasTransport.applyAtmosphere(g, s, true);
  check('atmosphere: top row ambient', s.air[10 + NX] === Math.fround(RHO_AIR) && s.air[10 + 2 * NX] === 0, 'ok');
}

// ---------------------------------------------------------------- 5. timing
{
  const g = makeGrid(); const s = makeGas(g);
  for (let j = 60; j < NY - 1; j++) for (let i = 1; i < NX - 1; i++) { g.cellType[i + j * NX] = LIQUID; s.air[i + j * NX] = 0; }
  for (let c = 0; c < NX * NY; c++) s.vapor[c] = g.cellType[c] === GAS ? 0.002 : 0;
  const dt = 1 / 120;
  setStream(g, basin(200));
  for (let k = 0; k < 50; k++) { gasTransport.advect(g, s, dt); gasTransport.advectVelocity(g, dt); setStream(g, basin(200)); }
  const N = 300;
  let tA = 0, tV = 0;
  for (let k = 0; k < N; k++) {
    let t = performance.now(); gasTransport.advect(g, s, dt); tA += performance.now() - t;
    t = performance.now(); gasTransport.advectVelocity(g, dt); tV += performance.now() - t;
  }
  // remap: a row of gas floods, timed over many calls (each on a fresh copy of the state)
  const base = new Int32Array(g.cellType);
  let tR = 0;
  for (let k = 0; k < 200; k++) {
    const gw: MacGrid = { ...g, cellType: new Int32Array(base) };
    const sw: GasState = { ...s, air: s.air.slice(), vapor: s.vapor.slice(), pendingAir: s.pendingAir.slice(), pendingVapor: s.pendingVapor.slice() };
    for (let i = 1; i < NX - 1; i++) gw.cellType[i + (59 - (k % 4)) * NX] = LIQUID;
    const t = performance.now(); gasTransport.remap(gw, sw, base); if (k >= 100) tR += performance.now() - t;
  }
  const total = (tA + tV) / N;
  // Informational only: wall-clock numbers depend on machine load, so this never fails the run.
  console.log(`${total <= 1.5 ? 'PASS' : 'SLOW'}  timing 160x90 (~200 px/s, dt 1/120, air+vapor, target 1.5 ms): advect ${(tA / N).toFixed(3)} ms + advectVelocity ${(tV / N).toFixed(3)} ms = ${total.toFixed(3)} ms; remap (158 cells flood) ${(tR / 100).toFixed(3)} ms`);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
if (failures) process.exit(1);
