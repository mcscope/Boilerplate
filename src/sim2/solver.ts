/**
 * A: unified pressure solver (design/unified-physics.md).
 *
 * One projection for the whole grid: incompressible variable-density liquid plus compressible ideal gas.
 *
 * Continuous equation per non-solid cell c (unknown absolute pressure p_c, units of P0):
 *
 *   Σ_open faces f  dt/(ρ_f h²) (p_nb − p_c)  −  α_c (p_c − p*_c)  =  (div(u*)_c − drift_c) / h
 *
 * Discretization / units (all as implemented below):
 * - div(u*)_c = u[c+1] − u[c] + v[c+nx] − v[c]  [px/s, outflow positive, NOT divided by h].
 * - The equation is multiplied by −h, giving the SPD system  A p = b  in velocity units [px/s]:
 *     A_cc = Σ_f k_f + α_c h,   A_c,nb = −k_f  (nb an unknown),   k_f = dt / (ρ_f h)   [px/s per pressure unit]
 *     b_c  = −(div_c − drift_c) + α_c h p*_c + Σ_{f to Dirichlet nb} k_f p_nb
 *   A is a weighted graph Laplacian plus a non-negative diagonal, so it is symmetric positive semi-definite, and
 *   definite in every connected component containing a gas cell (α > 0) or touching a Dirichlet cell. Components
 *   with neither (a sealed, completely liquid-filled region) are made definite by pinning one cell to its
 *   warm-start pressure; that is exact, because the remaining equations sum to the pinned one (pure Neumann
 *   compatibility), so it only fixes the free additive constant.
 *   The residual r = b − A p is therefore a velocity divergence error in px/s, which is what tolerance measures.
 * - Liquid: α = 0. drift_c = driftCompensation · max(0, density_c − restDensity), in px/s of target net outflow:
 *   driftCompensation has units px/s per (particle per cell). driftCompensation = 1 reproduces the classic solver,
 *   which subtracts the raw particle excess from the divergence (px/s) each solve.
 * - Boiling source (liquid cells): vapor held in gas.pendingVapor[c] adds a target outflow
 *   frac · h / dt, frac = min(VAPOR_MAX_CELLS, gasPressure(0, pendingVapor, T) / max(p_warm, P_MIN)), i.e. the
 *   vapor's EOS volume in cells at the cell's last solved pressure. The solver only reads pendingVapor: whoever owns
 *   it must clear/convert it after the step, or the same vapor keeps pushing every step.
 *   In a sealed all-liquid region the pinned cell absorbs any net source (nowhere for the volume to go).
 * - Gas: p*_c = gasPressure(air, vapor, T); α_c = 1 / (dt γ max(p*_c, P_MIN)) [1/(px · pressure)… per unit h],
 *   which is the linearized adiabatic law dp/dt = −γ p div(u)/h integrated implicitly over dt (acoustic term).
 *   P_MIN = 0.02 P0 keeps near-vacuum cells from becoming infinitely compressible.
 * - Cell density ρ_c: liquid.rho (floored at 0.1), gas air+vapor floored at 0.1 RHO_AIR.
 *   Face density ρ_f: ARITHMETIC mean of the two cells. It is what makes the discrete hydrostatic balance exact
 *   (gravity g·dt on a face is cancelled by Δp = ρ_f g h on that same face, with the same ρ_f used in the
 *   velocity update), and it places a liquid/gas interface at the face midway between cell centers. Harmonic
 *   averaging would make interface faces respond with ~gas density (2·ρa), so liquid surface faces would be
 *   ~25× too mobile; arithmetic keeps a surface face's inertia ≈ half a liquid cell.
 * - Solid faces (either side s = 0 or SOLID): closed, velocity untouched.
 * - openTop: every non-solid cell of row j = 1 is Dirichlet p = P0 (gas and liquid alike).
 * - Velocity update on every face between two non-solid cells: u_f −= k_f (p_right − p_left), same k_f as A.
 *
 * Solver: matrix-free PCG with a Modified Incomplete Cholesky MIC(0) preconditioner (Bridson, τ = 0.97, with
 * the usual pivot safety), Float64 internally, warm-started from the previous call's pressure (falling back to
 * p* in gas and P0 in liquid). Stops when max|r| ≤ max(tolerance · ref, ABS_TOL) where ref = max(max|r0|,
 * max|div − drift|). The returned `residual` is max|r| / ref.
 * All work arrays are cached per grid size; no per-call allocation after the first call.
 */
import { GAMMA, LIQUID, P0, RHO_AIR, SOLID, gasPressure, GasState, LiquidFields, MacGrid, ProjectOptions, ProjectResult } from './types';

/** Floor on gas pressure used in the compressibility coefficient. */
export const P_MIN = 0.02 * P0;
/** Floor on gas density used for face densities (near-vacuum cells). */
const RHO_GAS_MIN = 0.1 * RHO_AIR;
const RHO_LIQ_MIN = 0.1;
/** Absolute residual floor (px/s of divergence) below which we always stop. */
const ABS_TOL = 1e-4;
const MIC_TAU = 0.97;
/** Cap on the boiling volume source: at most this many cells of vapor volume pushed out per step per cell. */
export const VAPOR_MAX_CELLS = 2;
const MIC_SIGMA = 0.25;

// Cell status
const ST_SOLID = 0;
const ST_UNKNOWN = 1;
const ST_DIRICHLET = 2;

interface Work {
  n: number;
  nx: number;
  status: Uint8Array;
  rho: Float64Array;
  kx: Float64Array; // k for the u face on the left of c (0 if closed)
  ky: Float64Array; // k for the v face on top of c (0 if closed)
  ax: Float64Array; // coupling c <-> c+1 (both unknown)
  ay: Float64Array; // coupling c <-> c+nx (both unknown)
  diag: Float64Array;
  b: Float64Array;
  x: Float64Array; // pressure (all cells; Dirichlet values held here too)
  r: Float64Array;
  z: Float64Array;
  d: Float64Array;
  q: Float64Array;
  precon: Float64Array;
  lx: Float64Array; // ax * precon (MIC factor off-diagonals)
  ly: Float64Array;
  cells: Int32Array; // unknowns, increasing index
  stack: Int32Array;
  comp: Int32Array;
  prevP: Float64Array; // warm start cache (NaN = none)
}

let work: Work | null = null;

function getWork(nx: number, ny: number): Work {
  const n = nx * ny;
  if (work && work.n === n && work.nx === nx) return work;
  const f = () => new Float64Array(n);
  work = {
    n, nx,
    status: new Uint8Array(n),
    rho: f(), kx: f(), ky: f(), ax: f(), ay: f(), diag: f(), b: f(), x: f(), r: f(), z: f(), d: f(), q: f(), precon: f(), lx: f(), ly: f(),
    cells: new Int32Array(n), stack: new Int32Array(n), comp: new Int32Array(n),
    prevP: new Float64Array(n).fill(NaN),
  };
  return work;
}

/** Forget the warm-start pressure (e.g. after a level load). */
export function resetSolver() {
  if (work) work.prevP.fill(NaN);
}

export function project(grid: MacGrid, gas: GasState, liquid: LiquidFields, opts: ProjectOptions, pressureOut: Float32Array): ProjectResult {
  const { nx, ny, h, u, v, s, cellType } = grid;
  const n = nx * ny;
  const W = getWork(nx, ny);
  const { status, rho, kx, ky, ax, ay, diag, b, x, r, precon, lx, ly, cells, stack, comp, prevP } = W;
  const dt = opts.dt;
  const kScale = dt / h;

  // ---- 1. Classify cells, densities, warm start / Dirichlet values -------------------------------------------
  let numCells = 0;
  for (let j = 0, c = 0; j < ny; j++) for (let i = 0; i < nx; i++, c++) {
    const t = cellType[c];
    if (s[c] === 0 || t === SOLID || i === 0 || j === 0 || i === nx - 1 || j === ny - 1) {
      status[c] = ST_SOLID;
      rho[c] = 0;
      x[c] = 0;
      continue;
    }
    if (t === LIQUID) {
      const rl = liquid.rho[c];
      rho[c] = rl > RHO_LIQ_MIN ? rl : RHO_LIQ_MIN;
    } else {
      const rg = gas.air[c] + gas.vapor[c] + gas.alcVapor[c];
      rho[c] = rg > RHO_GAS_MIN ? rg : RHO_GAS_MIN;
    }
    if (opts.openTop && j === 1) {
      status[c] = ST_DIRICHLET;
      x[c] = P0;
    } else {
      status[c] = ST_UNKNOWN;
      const pp = prevP[c];
      x[c] = pp === pp && pp > 0 ? pp : t === LIQUID ? P0 : gasPressure(gas.air[c], gas.vapor[c], gas.T[c], gas.alcVapor[c]);
      cells[numCells++] = c;
    }
  }

  // ---- 2. Pin sealed all-liquid components (otherwise A is singular there) -----------------------------------
  comp.fill(0);
  // Only liquid needs checking: any component holding a gas cell (α > 0) is already definite, so the flood walks
  // liquid cells only and stops counting a component as sealed as soon as it touches gas or a Dirichlet cell.
  for (let q0 = 0; q0 < numCells; q0++) {
    const seed = cells[q0];
    if (comp[seed] !== 0 || cellType[seed] !== LIQUID) continue;
    let top = 0, anchored = false;
    stack[top++] = seed;
    comp[seed] = 1;
    while (top > 0) {
      const c = stack[--top];
      for (let k = 0; k < 4; k++) {
        const o = k === 0 ? c - 1 : k === 1 ? c + 1 : k === 2 ? c - nx : c + nx;
        const st = status[o];
        if (st === ST_DIRICHLET) anchored = true;
        else if (st === ST_UNKNOWN && comp[o] === 0) {
          if (cellType[o] !== LIQUID) { anchored = true; continue; }
          comp[o] = 1;
          stack[top++] = o;
        }
      }
    }
    if (!anchored) status[seed] = ST_DIRICHLET; // keeps its warm-start value in x[seed]
  }
  if (numCells > 0) {
    // Compact the unknown list (pinned cells removed).
    let m = 0;
    for (let qq = 0; qq < numCells; qq++) if (status[cells[qq]] === ST_UNKNOWN) cells[m++] = cells[qq];
    numCells = m;
  }

  // ---- 3. Face coefficients ----------------------------------------------------------------------------------
  // kx[c]: face between c-1 and c; ky[c]: face between c-nx and c.
  for (let c = nx; c < n - nx; c++) {
    const sc = status[c];
    if (sc === ST_SOLID) { kx[c] = 0; ky[c] = 0; continue; }
    kx[c] = status[c - 1] !== ST_SOLID ? (2 * kScale) / (rho[c] + rho[c - 1]) : 0;
    ky[c] = status[c - nx] !== ST_SOLID ? (2 * kScale) / (rho[c] + rho[c - nx]) : 0;
  }
  for (let c = 0; c < nx; c++) { kx[c] = 0; ky[c] = 0; kx[n - nx + c] = 0; ky[n - nx + c] = 0; }

  // ---- 4. Assemble A (diag, ax, ay) and b --------------------------------------------------------------------
  const drift = opts.driftCompensation, rest = liquid.restDensity;
  let divRef = 0;
  for (let qq = 0; qq < numCells; qq++) {
    const c = cells[qq];
    const kl = kx[c], kr = kx[c + 1], kt = ky[c], kb = ky[c + nx];
    let dg = kl + kr + kt + kb;
    let div = u[c + 1] - u[c] + v[c + nx] - v[c];
    let rhs = 0;
    if (cellType[c] === LIQUID) {
      if (drift > 0) {
        const ex = liquid.density[c] - rest;
        if (ex > 0) div -= drift * ex;
      }
      // Boiling source: vapor waiting in this liquid cell (gas.pendingVapor) needs room. Its volume, as a fraction
      // of the cell, is gasPressure(0, pv, T) / p_local; making room for it within this step means a net outflow of
      // frac · h / dt (px/s summed over faces). Capped at VAPOR_MAX_CELLS cells of volume per step.
      const pv = gas.pendingVapor[c], pa = gas.pendingAlc[c];
      if (pv > 0 || pa > 0) {
        const pl = x[c] > P_MIN ? x[c] : P_MIN;
        let frac = gasPressure(0, pv, gas.T[c], pa) / pl;
        if (frac > VAPOR_MAX_CELLS) frac = VAPOR_MAX_CELLS;
        div -= frac * h / dt;
      }
    } else {
      const ps = gasPressure(gas.air[c], gas.vapor[c], gas.T[c], gas.alcVapor[c]);
      const ah = h / (dt * GAMMA * (ps > P_MIN ? ps : P_MIN));
      dg += ah;
      rhs += ah * ps;
    }
    const ad = div < 0 ? -div : div;
    if (ad > divRef) divRef = ad;
    rhs -= div;
    // Dirichlet neighbors move to the right-hand side.
    if (kl > 0 && status[c - 1] === ST_DIRICHLET) rhs += kl * x[c - 1];
    if (kr > 0 && status[c + 1] === ST_DIRICHLET) rhs += kr * x[c + 1];
    if (kt > 0 && status[c - nx] === ST_DIRICHLET) rhs += kt * x[c - nx];
    if (kb > 0 && status[c + nx] === ST_DIRICHLET) rhs += kb * x[c + nx];
    diag[c] = dg;
    b[c] = rhs;
    ax[c] = status[c + 1] === ST_UNKNOWN ? kr : 0;
    ay[c] = status[c + nx] === ST_UNKNOWN ? kb : 0;
  }
  // Couplings must be zero from any non-unknown cell into the unknowns (used by MIC/matvec via c-1, c-nx).
  for (let c = 0; c < n; c++) if (status[c] !== ST_UNKNOWN) { ax[c] = 0; ay[c] = 0; diag[c] = 0; r[c] = 0; }

  // ---- 5. MIC(0) preconditioner ------------------------------------------------------------------------------
  for (let qq = 0; qq < numCells; qq++) {
    const c = cells[qq];
    const A = diag[c];
    const axl = ax[c - 1], ayt = ay[c - nx];
    const pl = precon[c - 1], pt = precon[c - nx];
    const el = axl * pl, et = ayt * pt;
    let e = A - el * el - et * et - MIC_TAU * (axl * ay[c - 1] * pl * pl + ayt * ax[c - nx] * pt * pt);
    if (e < MIC_SIGMA * A) e = A;
    precon[c] = 1 / Math.sqrt(e);
  }
  // precon of non-unknown cells must be 0 so their couplings vanish (couplings are already 0, but be safe).
  for (let c = 0; c < n; c++) {
    if (status[c] !== ST_UNKNOWN) precon[c] = 0;
    lx[c] = ax[c] * precon[c];
    ly[c] = ay[c] * precon[c];
  }

  // ---- 6. PCG ------------------------------------------------------------------------------------------------
  // r = b - A x (only over unknowns; Dirichlet already in b, so treat x of non-unknowns as 0 in the matvec).
  let rMax = residual(cells, numCells, nx, diag, ax, ay, x, b, r);
  const ref = Math.max(rMax, divRef, 1e-12);
  const target = Math.max(opts.tolerance * ref, ABS_TOL);
  const maxIters = opts.maxIters;
  let iterations = 0;
  if (rMax > target && numCells > 0) {
    iterations = pcg(W, nx, ny, target, maxIters);
    rMax = pcgResidual;
  }

  // ---- 7. Velocity update ------------------------------------------------------------------------------------
  for (let c = nx; c < n - nx; c++) {
    if (status[c] === ST_SOLID) continue;
    const pc = x[c];
    const kl = kx[c];
    if (kl > 0) u[c] -= kl * (pc - x[c - 1]);
    const kt = ky[c];
    if (kt > 0) v[c] -= kt * (pc - x[c - nx]);
  }

  // ---- 8. Output + warm-start cache --------------------------------------------------------------------------
  for (let c = 0; c < n; c++) {
    if (status[c] === ST_SOLID) {
      pressureOut[c] = 0;
      prevP[c] = NaN;
    } else {
      pressureOut[c] = x[c];
      prevP[c] = x[c];
    }
  }
  return { iterations, residual: rMax / ref };
}

let pcgResidual = 0;

/**
 * Preconditioned CG on A x = b, starting from the residual already in W.r. Kept out of `project` so V8 optimizes
 * these hot loops on their own (inlined into the big function they ran several times slower).
 * Kernels sweep the whole interior range [lo, hi): non-unknown cells have zero diag, couplings and precon, so they
 * stay at r = q = z = d = 0 and x keeps their Dirichlet value. Cheaper than indirect indexing through `cells`.
 * Returns the iteration count; the final max|r| is left in `pcgResidual`.
 */
function pcg(W: Work, nx: number, ny: number, target: number, maxIters: number): number {
  const { diag, ax, ay, precon, lx, ly, x, r, z, d, q } = W;
  const lo = nx, hi = (ny - 1) * nx;
  let sigma = applyMIC(1, ny - 1, nx, lx, ly, precon, r, q, z);
  d.set(z);
  let iterations = 0, rMax = Infinity;
  while (iterations < maxIters) {
    iterations++;
    const dAd = matvecDot(lo, hi, nx, diag, ax, ay, d, q);
    if (!(dAd > 0)) break;
    rMax = updateXR(lo, hi, sigma / dAd, d, q, x, r);
    if (rMax <= target) break;
    const sigNew = applyMIC(1, ny - 1, nx, lx, ly, precon, r, q, z);
    updateD(lo, hi, sigNew / sigma, z, d);
    sigma = sigNew;
  }
  pcgResidual = rMax;
  return iterations;
}

/**
 * z = M⁻¹ r with M = L Lᵀ the MIC(0) factor (lx, ly = L's off-diagonals, precon = 1/L_cc); q is scratch.
 * Rows [j0, j1) are swept as a two-row wavefront (row j at column i alongside row j+1 at column i−1): the two
 * dependency chains are independent, which roughly doubles throughput of this latency-bound triangular solve.
 * Results are identical to a plain row-major sweep. Returns z·r.
 */
function applyMIC(j0: number, j1: number, nx: number, lx: Float64Array, ly: Float64Array, precon: Float64Array,
  r: Float64Array, q: Float64Array, z: Float64Array): number {
  // Forward: L q = r, in increasing index order.
  let j = j0;
  for (; j + 1 < j1; j += 2) {
    const a0 = j * nx, b0 = a0 + nx;
    let c = a0;
    q[c] = (r[c] + lx[c - 1] * q[c - 1] + ly[c - nx] * q[c - nx]) * precon[c];
    for (let i = 1; i < nx; i++) {
      const ca = a0 + i, cb = b0 + i - 1;
      const ta = r[ca] + lx[ca - 1] * q[ca - 1] + ly[ca - nx] * q[ca - nx];
      const tb = r[cb] + lx[cb - 1] * q[cb - 1] + ly[cb - nx] * q[cb - nx];
      q[ca] = ta * precon[ca];
      q[cb] = tb * precon[cb];
    }
    c = b0 + nx - 1;
    q[c] = (r[c] + lx[c - 1] * q[c - 1] + ly[c - nx] * q[c - nx]) * precon[c];
  }
  for (; j < j1; j++) {
    for (let c = j * nx, e = c + nx; c < e; c++) q[c] = (r[c] + lx[c - 1] * q[c - 1] + ly[c - nx] * q[c - nx]) * precon[c];
  }
  // Backward: Lᵀ z = q, in decreasing index order.
  let dot = 0;
  j = j1 - 1;
  for (; j - 1 >= j0; j -= 2) {
    const b0 = j * nx, a0 = b0 - nx; // b = lower row (processed first), a = upper row lagging one column
    let c = b0 + nx - 1;
    let zc = (q[c] + lx[c] * z[c + 1] + ly[c] * z[c + nx]) * precon[c];
    z[c] = zc;
    dot += zc * r[c];
    for (let i = nx - 2; i >= 0; i--) {
      const cb = b0 + i, ca = a0 + i + 1;
      const zb = (q[cb] + lx[cb] * z[cb + 1] + ly[cb] * z[cb + nx]) * precon[cb];
      const za = (q[ca] + lx[ca] * z[ca + 1] + ly[ca] * z[ca + nx]) * precon[ca];
      z[cb] = zb;
      z[ca] = za;
      dot += zb * r[cb] + za * r[ca];
    }
    c = a0;
    zc = (q[c] + lx[c] * z[c + 1] + ly[c] * z[c + nx]) * precon[c];
    z[c] = zc;
    dot += zc * r[c];
  }
  for (; j >= j0; j--) {
    for (let c = j * nx + nx - 1, e = j * nx; c >= e; c--) {
      const zc = (q[c] + lx[c] * z[c + 1] + ly[c] * z[c + nx]) * precon[c];
      z[c] = zc;
      dot += zc * r[c];
    }
  }
  return dot;
}

/** r = b − A x over the unknowns; returns max|r|. */
function residual(cells: Int32Array, m: number, nx: number, diag: Float64Array, ax: Float64Array, ay: Float64Array,
  x: Float64Array, b: Float64Array, r: Float64Array): number {
  let rMax = 0;
  for (let k = 0; k < m; k++) {
    const c = cells[k];
    // Couplings to non-unknowns are 0, but x there holds Dirichlet values: guard so they don't enter twice.
    let Ax = diag[c] * x[c];
    if (ax[c] !== 0) Ax -= ax[c] * x[c + 1];
    if (ax[c - 1] !== 0) Ax -= ax[c - 1] * x[c - 1];
    if (ay[c] !== 0) Ax -= ay[c] * x[c + nx];
    if (ay[c - nx] !== 0) Ax -= ay[c - nx] * x[c - nx];
    const rr = b[c] - Ax;
    r[c] = rr;
    const ar = rr < 0 ? -rr : rr;
    if (ar > rMax) rMax = ar;
  }
  return rMax;
}

/** q = A d over the unknowns (d is 0 elsewhere); returns d·q. */
function matvecDot(lo: number, hi: number, nx: number, diag: Float64Array, ax: Float64Array, ay: Float64Array,
  d: Float64Array, q: Float64Array): number {
  let dot = 0;
  for (let c = lo; c < hi; c++) {
    const dc = d[c];
    const Ad = diag[c] * dc - ax[c] * d[c + 1] - ax[c - 1] * d[c - 1] - ay[c] * d[c + nx] - ay[c - nx] * d[c - nx];
    q[c] = Ad;
    dot += dc * Ad;
  }
  return dot;
}

/** x += α d, r −= α q; returns max|r|. */
function updateXR(lo: number, hi: number, alpha: number, d: Float64Array, q: Float64Array, x: Float64Array, r: Float64Array): number {
  let rMax = 0;
  for (let c = lo; c < hi; c++) {
    x[c] += alpha * d[c];
    const rr = r[c] - alpha * q[c];
    r[c] = rr;
    const ar = rr < 0 ? -rr : rr;
    if (ar > rMax) rMax = ar;
  }
  return rMax;
}

/** d = z + β d. */
function updateD(lo: number, hi: number, beta: number, z: Float64Array, d: Float64Array) {
  for (let c = lo; c < hi; c++) {
    d[c] = z[c] + beta * d[c];
  }
}

