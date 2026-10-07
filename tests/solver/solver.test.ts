// Validation for src/sim2/solver.ts (synthetic grids, no other modules). Run:
//   node_modules/.bin/esbuild tests/solver/solver.test.ts --bundle --platform=node --outfile=/private/tmp/solver.test.js
//   node /private/tmp/solver.test.js
import { project, resetSolver } from '../../src/sim2/solver';
import { GAS, LIQUID, P0, RHO_AIR, SOLID, GasState, LiquidFields, MacGrid, ProjectOptions, gasPressure } from '../../src/sim2/types';

const NX = 160, NY = 90, H = 2, G = 800, DT = 1 / 120;
let failures = 0;
function check(name: string, ok: boolean, info: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${info}`);
  if (!ok) failures++;
}

function makeScene(nx = NX, ny = NY) {
  const n = nx * ny;
  const grid: MacGrid = { nx, ny, h: H, u: new Float32Array(n), v: new Float32Array(n), s: new Float32Array(n), cellType: new Int32Array(n) };
  const gas: GasState = { air: new Float32Array(n), vapor: new Float32Array(n), T: new Float32Array(n).fill(20), pendingAir: new Float32Array(n), pendingVapor: new Float32Array(n), alcVapor: new Float32Array(n), pendingAlc: new Float32Array(n) };
  const liquid: LiquidFields = { rho: new Float32Array(n), density: new Float32Array(n), restDensity: 1 };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const c = i + j * nx;
    const solid = i === 0 || j === 0 || i === nx - 1 || j === ny - 1;
    grid.s[c] = solid ? 0 : 1;
    grid.cellType[c] = solid ? SOLID : GAS;
    if (!solid) gas.air[c] = RHO_AIR;
  }
  const pressure = new Float32Array(n);
  return { grid, gas, liquid, pressure };
}
type Scene = ReturnType<typeof makeScene>;
function setLiquid(sc: Scene, c: number, rho: number) {
  sc.grid.cellType[c] = LIQUID; sc.liquid.rho[c] = rho; sc.liquid.density[c] = 1; sc.gas.air[c] = 0; sc.gas.vapor[c] = 0;
}
function open(sc: Scene, c: number) { return sc.grid.s[c] !== 0; }
function addGravity(sc: Scene) {
  const { nx, ny, v } = sc.grid;
  for (let c = nx; c < nx * ny; c++) if (open(sc, c) && open(sc, c - nx)) v[c] += DT * G;
}
function opts(o: Partial<ProjectOptions> = {}): ProjectOptions {
  return { dt: DT, openTop: true, maxIters: 400, tolerance: 1e-5, driftCompensation: 1, ...o };
}
function maxDiv(sc: Scene, type: number) {
  const { nx, ny, u, v, cellType } = sc.grid;
  let m = 0;
  for (let c = nx; c < nx * (ny - 1); c++) if (open(sc, c) && cellType[c] === type) m = Math.max(m, Math.abs(u[c + 1] - u[c] + v[c + nx] - v[c]));
  return m;
}
function maxSpeed(sc: Scene, type: number) {
  const { nx, ny, u, v, cellType } = sc.grid;
  let m = 0;
  for (let c = nx; c < nx * (ny - 1); c++) {
    if (!open(sc, c) || cellType[c] !== type) continue;
    m = Math.max(m, Math.abs(u[c]), Math.abs(v[c]));
  }
  return m;
}

// ---------- 1. Hydrostatic ----------
function hydrostatic(preStratified: boolean) {
  resetSolver();
  const sc = makeScene();
  const surf = 45;
  for (let j = surf; j < NY - 1; j++) for (let i = 1; i < NX - 1; i++) setLiquid(sc, i + j * NX, 1);
  // Expected discrete hydrostatic profile with arithmetic face densities.
  const rhoCell = (j: number) => (j >= surf ? 1 : RHO_AIR);
  const expP = new Float64Array(NY);
  expP[1] = P0;
  for (let j = 2; j < NY - 1; j++) expP[j] = expP[j - 1] + 0.5 * (rhoCell(j) + rhoCell(j - 1)) * G * H;
  if (preStratified) for (let j = 2; j < surf; j++) for (let i = 1; i < NX - 1; i++) sc.gas.air[i + j * NX] = RHO_AIR * expP[j] / P0;
  addGravity(sc);
  const res = project(sc.grid, sc.gas, sc.liquid, opts(), sc.pressure);
  // Liquid: compare the profile relative to the top liquid row (uniform gas hasn't stratified yet, so it may be
  // offset by the gas's one-step compression); gas: absolute.
  let errL = 0, errG = 0;
  for (let j = 2; j < NY - 1; j++) for (let i = 1; i < NX - 1; i++) {
    const c = i + j * NX;
    if (j >= surf) errL = Math.max(errL, Math.abs(sc.pressure[c] - sc.pressure[i + surf * NX] - (expP[j] - expP[surf])));
    else errG = Math.max(errG, Math.abs(sc.pressure[c] - expP[j]));
  }
  let off = 0;
  for (let i = 1; i < NX - 1; i++) off = Math.max(off, Math.abs(sc.pressure[i + surf * NX] - expP[surf]));
  const bottomGauge = expP[NY - 2] - P0;
  const vl = maxSpeed(sc, LIQUID), vg = maxSpeed(sc, GAS);
  const tag = preStratified ? 'stratified gas' : 'uniform gas';
  check(`hydrostatic (${tag})`, errL < 0.01 * bottomGauge && vl < 0.5,
    `liquid max|Δp-Δp_exp| ${errL.toFixed(2)}, surface offset ${off.toFixed(1)} (bottom gauge ${bottomGauge.toFixed(0)}, gas gauge ${(expP[surf - 1] - P0).toFixed(0)}), gas ${errG.toFixed(2)}; max speed liquid ${vl.toFixed(4)} gas ${vg.toFixed(4)} px/s; iters ${res.iterations}`);
}
hydrostatic(false);
hydrostatic(true);

// ---------- 2. Liquid divergence ----------
{
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (const openTop of [false, true]) {
    resetSolver();
    const sc = makeScene();
    for (let c = 0; c < NX * NY; c++) if (open(sc, c)) setLiquid(sc, c, 1);
    const { u, v } = sc.grid;
    for (let c = NX; c < NX * (NY - 1); c++) {
      if (open(sc, c) && open(sc, c - 1)) u[c] = 100 * rnd();
      if (open(sc, c) && open(sc, c - NX)) v[c] = 100 * rnd();
    }
    const before = maxDiv(sc, LIQUID);
    const t0 = performance.now();
    const res = project(sc.grid, sc.gas, sc.liquid, opts({ openTop, maxIters: 1000, tolerance: 1e-6 }), sc.pressure);
    const ms = performance.now() - t0;
    // Row 1 cells are Dirichlet when openTop (they don't get a divergence constraint).
    let after = 0;
    for (let c = (openTop ? 2 : 1) * NX; c < NX * (NY - 1); c++) if (open(sc, c)) after = Math.max(after, Math.abs(u[c + 1] - u[c] + v[c + NX] - v[c]));
    check(`liquid divergence (${openTop ? 'openTop' : 'sealed, pinned'})`, after < 1e-2,
      `max|div| ${before.toFixed(1)} -> ${after.toExponential(2)} px/s; iters ${res.iterations}, rel residual ${res.residual.toExponential(2)}, ${ms.toFixed(1)} ms (cold)`);
  }
}

// ---------- 3. Compressed gas ----------
{
  resetSolver();
  const nx = 40, ny = 20;
  const sc = makeScene(nx, ny);
  for (let c = 0; c < nx * ny; c++) if (open(sc, c) && c % nx < nx / 2) sc.gas.air[c] = 2 * RHO_AIR;
  const o = opts({ openTop: false });
  const res = project(sc.grid, sc.gas, sc.liquid, o, sc.pressure);
  const mid = nx / 2;
  let uMid = 0;
  for (let j = 1; j < ny - 1; j++) uMid += sc.grid.u[mid + j * nx] / (ny - 2);
  // Plausibility: the acoustic (Riemann) velocity Δp/(ρ c) is the natural scale for a released pressure step.
  const rhoM = 1.5 * RHO_AIR, c0 = Math.sqrt(1.4 * 1.5 * P0 / rhoM);
  const riemann = P0 / (rhoM * c0);
  check('compressed gas: flow left->right', uMid > 0 && uMid < 2 * riemann,
    `mean u across middle ${uMid.toFixed(1)} px/s (Riemann scale Δp/(ρc) ≈ ${riemann.toFixed(0)}); p left ${sc.pressure[5 + 10 * nx].toFixed(0)} right ${sc.pressure[35 + 10 * nx].toFixed(0)}; iters ${res.iterations}`);
  // Repeated projects with a donor-cell mass update (no velocity advection, no damping).
  const { u, v } = sc.grid, air = sc.gas.air, flux = new Float64Array(nx * ny);
  let mass0 = 0;
  for (let c = 0; c < nx * ny; c++) mass0 += air[c];
  let maxU = 0, finite = true, maxIt = 0;
  for (let step = 0; step < 600; step++) {
    if (step > 0) maxIt = Math.max(maxIt, project(sc.grid, sc.gas, sc.liquid, o, sc.pressure).iterations);
    const sub = 4, dts = DT / sub;
    for (let k = 0; k < sub; k++) {
      flux.fill(0);
      for (let c = nx; c < nx * (ny - 1); c++) {
        if (!open(sc, c)) continue;
        if (open(sc, c - 1)) { const f = u[c] * dts / H * (u[c] > 0 ? air[c - 1] : air[c]); flux[c - 1] -= f; flux[c] += f; }
        if (open(sc, c - nx)) { const f = v[c] * dts / H * (v[c] > 0 ? air[c - nx] : air[c]); flux[c - nx] -= f; flux[c] += f; }
      }
      for (let c = 0; c < nx * ny; c++) air[c] += flux[c];
    }
    for (let c = 0; c < nx * ny; c++) { maxU = Math.max(maxU, Math.abs(u[c]), Math.abs(v[c])); if (!Number.isFinite(u[c])) finite = false; }
  }
  let mass1 = 0, pMin = Infinity, pMax = 0, uEnd = 0;
  for (let c = 0; c < nx * ny; c++) {
    mass1 += air[c];
    if (open(sc, c)) { const p = gasPressure(air[c], 0, 20); pMin = Math.min(pMin, p); pMax = Math.max(pMax, p); uEnd = Math.max(uEnd, Math.abs(u[c]), Math.abs(v[c])); }
  }
  check('compressed gas: 600 steps stable', finite && maxU < 5000 && pMax / pMin < 1.5,
    `max |u| over run ${maxU.toFixed(0)}, at end ${uEnd.toFixed(1)} px/s; p range at end ${pMin.toFixed(0)}..${pMax.toFixed(0)} (equilibrium ${(1.5 * P0).toFixed(0)}); mass drift ${((mass1 / mass0 - 1) * 100).toExponential(2)}%; max iters ${maxIt}`);
}

// ---------- 4. Bubble buoyancy ----------
{
  resetSolver();
  const sc = makeScene();
  for (let j = 30; j < NY - 1; j++) for (let i = 1; i < NX - 1; i++) setLiquid(sc, i + j * NX, 1);
  const bx0 = 75, bx1 = 85, by0 = 75, by1 = 85;
  for (let j = by0; j < by1; j++) for (let i = bx0; i < bx1; i++) {
    const c = i + j * NX;
    sc.grid.cellType[c] = GAS; sc.liquid.rho[c] = 0; sc.gas.air[c] = RHO_AIR * (1 + ((j - 30) * G * H) / P0); // ~hydrostatic
  }
  addGravity(sc);
  const res = project(sc.grid, sc.gas, sc.liquid, opts(), sc.pressure);
  let vb = 0, nb = 0;
  for (let j = by0 + 1; j < by1; j++) for (let i = bx0; i < bx1; i++) { vb += sc.grid.v[i + j * NX]; nb++; }
  vb /= nb;
  let vl = 0, nl = 0;
  for (let j = 50; j < 70; j++) for (let i = 10; i < 30; i++) { vl += sc.grid.v[i + j * NX]; nl++; }
  vl /= nl;
  check('bubble buoyancy', vb < -1 && Math.abs(vl) < 1,
    `mean v inside bubble ${vb.toFixed(2)} px/s (negative = up), on top face ${sc.grid.v[80 + by0 * NX].toFixed(2)}, far liquid ${vl.toFixed(4)}; liquid max|div| ${maxDiv(sc, LIQUID).toExponential(2)}; iters ${res.iterations}`);
}

// ---------- 5. Oil under water ----------
{
  resetSolver();
  const sc = makeScene();
  for (let j = 30; j < NY - 1; j++) for (let i = 1; i < NX - 1; i++) setLiquid(sc, i + j * NX, 1);
  for (let j = 70; j < 80; j++) for (let i = 70; i < 90; i++) sc.liquid.rho[i + j * NX] = 0.7;
  addGravity(sc);
  const res = project(sc.grid, sc.gas, sc.liquid, opts(), sc.pressure);
  let vo = 0, no = 0;
  for (let j = 71; j < 80; j++) for (let i = 70; i < 90; i++) { vo += sc.grid.v[i + j * NX]; no++; }
  vo /= no;
  let vl = 0, nl = 0;
  for (let j = 50; j < 70; j++) for (let i = 10; i < 30; i++) { vl += sc.grid.v[i + j * NX]; nl++; }
  vl /= nl;
  check('oil rises in water', vo < -0.1 && Math.abs(vl) < 0.5, `mean v in oil ${vo.toFixed(3)} px/s, far water ${vl.toFixed(4)}; iters ${res.iterations}`);
}

// ---------- 5b. Boiling volume source (pendingVapor in a liquid cell) ----------
{
  resetSolver();
  const sc = makeScene();
  for (let j = 30; j < NY - 1; j++) for (let i = 1; i < NX - 1; i++) setLiquid(sc, i + j * NX, 1);
  const c = 80 + 70 * NX;
  sc.gas.T[c] = 100;
  sc.gas.pendingVapor[c] = 0.005; // vapor mass (RHO_AIR units)
  const res = project(sc.grid, sc.gas, sc.liquid, opts(), sc.pressure);
  const { u, v } = sc.grid;
  const out = u[c + 1] - u[c] + v[c + NX] - v[c];
  // The source uses the warm-start pressure (after resetSolver: P0 for liquid), i.e. last step's pressure in a run.
  const frac = Math.min(2, gasPressure(0, 0.005, 100) / P0);
  const expect = frac * H / DT;
  check('boiling source pushes liquid out', Math.abs(out - expect) < 0.02 * expect + 0.05,
    `net outflow ${out.toFixed(2)} px/s, expected frac·h/dt = ${expect.toFixed(2)} (frac ${frac.toFixed(3)} cells at warm-start p = P0; solved p ${sc.pressure[c].toFixed(0)}); iters ${res.iterations}`);
}

// ---------- 6. Timing ----------
function timing(name: string, setup: (sc: Scene) => void, o: ProjectOptions) {
  resetSolver();
  const sc = makeScene();
  setup(sc);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const N = 200;
  let t = 0, it = 0, itMax = 0, nl = 0, tMax = 0;
  for (let c = 0; c < NX * NY; c++) if (sc.grid.cellType[c] === LIQUID) nl++;
  for (let k = 0; k < N + 20; k++) {
    addGravity(sc);
    // Perturb liquid faces like FLIP noise / particle motion.
    for (let c = NX; c < NX * (NY - 1); c++) if (sc.grid.cellType[c] === LIQUID) { sc.grid.u[c] += 5 * rnd(); sc.grid.v[c] += 5 * rnd(); }
    for (let c = 0; c < NX * NY; c++) if (!open(sc, c)) { sc.grid.u[c] = 0; sc.grid.v[c] = 0; if (c + 1 < NX * NY) sc.grid.u[c + 1] = 0; if (c + NX < NX * NY) sc.grid.v[c + NX] = 0; }
    const t0 = process.cpuUsage();
    const r = project(sc.grid, sc.gas, sc.liquid, o, sc.pressure);
    const cu = process.cpuUsage(t0);
    const dtm = (cu.user + cu.system) / 1000; // CPU ms: wall time is meaningless on a loaded machine
    if (k >= 20) { t += dtm; tMax = Math.max(tMax, dtm); it += r.iterations; itMax = Math.max(itMax, r.iterations); }
  }
  console.log(`TIME  ${name}: ${(t / N).toFixed(2)} cpu-ms/call avg (max ${tMax.toFixed(2)}), iters avg ${(it / N).toFixed(1)} max ${itMax} (${nl} liquid cells, tol ${o.tolerance}, maxIters ${o.maxIters})`);
}
// Calibration: one 5-point stencil pass over the grid, to normalize timings on a loaded machine.
{
  const n = NX * NY, a = new Float64Array(n).map(() => Math.random()), o = new Float64Array(n);
  const pass = () => { for (let c = NX; c < n - NX; c++) o[c] = 4 * a[c] - a[c - 1] - a[c + 1] - a[c - NX] - a[c + NX]; };
  for (let k = 0; k < 200; k++) pass();
  const t0 = process.cpuUsage();
  for (let k = 0; k < 1000; k++) pass();
  const cu = process.cpuUsage(t0);
  console.log(`CALIB stencil pass ${((cu.user + cu.system) / 1000 / 1000).toFixed(4)} cpu-ms (machine-speed reference)`);
}
const sceneTank = (sc: Scene) => {
  for (let j = 55; j < NY - 1; j++) for (let i = 1; i < NX - 1; i++) setLiquid(sc, i + j * NX, 1);
  // A cup of water hanging in the air, and a bubble in the tank.
  const wall = (c: number) => { sc.grid.s[c] = 0; sc.grid.cellType[c] = SOLID; };
  for (let j = 20; j < 50; j++) { wall(40 + j * NX); wall(60 + j * NX); }
  for (let i = 40; i <= 60; i++) wall(i + 50 * NX);
  for (let j = 30; j < 50; j++) for (let i = 41; i < 60; i++) setLiquid(sc, i + j * NX, 1);
  for (let j = 60; j < 66; j++) for (let i = 100; i < 108; i++) { const c = i + j * NX; sc.grid.cellType[c] = GAS; sc.gas.air[c] = RHO_AIR * 1.05; }
};
timing('tank+cup+bubble openTop tol 1e-4', sceneTank, opts({ tolerance: 1e-4, maxIters: 200 }));
timing('tank+cup+bubble openTop tol 1e-3', sceneTank, opts({ tolerance: 1e-3, maxIters: 200 }));
timing('tank+cup+bubble sealed tol 1e-4', sceneTank, opts({ openTop: false, tolerance: 1e-4, maxIters: 200 }));

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exitCode = failures ? 1 : 0;
