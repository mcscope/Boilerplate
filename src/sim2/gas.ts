/**
 * B: gas transport for the unified engine (design/unified-physics.md).
 *
 * - `advect`, mass: conservative flux-form advection of `air` and `vapor`. Only gas cells carry gas, and fluxes only
 *   cross faces between two gas cells. Second-order MUSCL (MC-limited slopes, unsplit), substepped internally.
 *   Positivity: with limited slopes the upwind face value of a donor holding q lies in [0, 2q], so a cell whose
 *   summed OUTGOING Courant number is ≤ 0.5 can't export more than it holds. Cells above 0.5 (fast flow, when
 *   the substep budget for second order is used up) fall back to donor-cell, which is positive up to 1.
 *   Substeps are chosen so every cell's outgoing Courant sum is ≤ 1. Each face flux is added to one cell and
 *   subtracted from the other, so mass is conserved to rounding. The work is done in Float64 and written back once.
 * - `advect`, temperature: all non-solid cells, first-order upwind in advective form
 *   (T_c += Σ_inflow C·(T_nb − T_c)), substepped so Σ inflow Courant ≤ 0.9. Every update is a convex combination
 *   of old values, so there are no new extrema (no heat from nothing). It isn't energy-conserving in compressible
 *   flow. That's acceptable: liquid T is overwritten from particles and the gas heat capacity is tiny.
 * - `advectVelocity`: semi-Lagrangian with a clamped MacCormack correction, for faces between two gas cells only.
 * - `remap`: moves gas out of cells that stopped being gas (BFS to the nearest cells that were and still are gas),
 *   holds unplaceable mass as pending, and releases pending mass into nearby gas cells. Conservative up to
 *   float32 storage rounding.
 * - `remap` also fills SOLID -> GAS cells with ambient air (non-conservative by design, see there).
 * - `applyAtmosphere`: the only non-conservative boundary. With openTop, the top interior row is an infinite
 *   reservoir at the ambient state.
 */
import { GAS, GasState, GasTransport, MacGrid, RHO_AIR, SOLID, T_AMBIENT } from './types';

/** Max summed outgoing Courant number per cell per substep for second-order (MUSCL) fluxes from that cell. */
const HO_CFL = 0.5;
/** Max substeps spent to keep everything second order; beyond this, fast cells drop to donor-cell (CFL 1). */
const HO_MAX_STEPS = 4;
/** Max summed incoming Courant number per cell per temperature substep (convexity bound: ≤ 1). */
const TEMP_CFL = 0.9;
const MAX_SUBSTEPS = 64;
/** BFS depth (in cells) searched for a destination when a gas cell is lost. */
const REMAP_RADIUS = 6;
/** Chebyshev radius around pending mass in which a gas cell can receive it. */
const PENDING_RADIUS = 2;

interface Work {
  n: number;
  isGas: Uint8Array;
  open: Uint8Array;
  /** Bit 0: x slope allowed, bit 1: y slope allowed (gas on both sides and the cell is slow enough). */
  slopeMask: Uint8Array;
  qa: Float64Array; qb: Float64Array; // air, double-buffered
  ra: Float64Array; rb: Float64Array; // vapor
  sxq: Float64Array; syq: Float64Array; sxr: Float64Array; syr: Float64Array;
  cu: Float64Array; cv: Float64Array; // full-dt Courant numbers on gas–gas faces, 0 elsewhere
  out: Float64Array; // summed outgoing Courant number per gas cell (full dt)
  tin: Float64Array; // summed incoming Courant number per open cell (full dt), for temperature
  tOld: Float32Array;
  prevU: Float32Array;
  prevV: Float32Array;
  hatU: Float32Array; hatV: Float32Array;
  minU: Float32Array; maxU: Float32Array; minV: Float32Array; maxV: Float32Array;
  faceMask: Uint8Array;
  queue: Int32Array;
  dist: Int32Array;
  stamp: Int32Array;
  stampId: number;
  targets: Int32Array;
}

let work: Work | null = null;

function getWork(n: number): Work {
  if (work && work.n === n) return work;
  const f64 = () => new Float64Array(n);
  work = {
    n,
    isGas: new Uint8Array(n), open: new Uint8Array(n), slopeMask: new Uint8Array(n),
    qa: f64(), qb: f64(), ra: f64(), rb: f64(),
    sxq: f64(), syq: f64(), sxr: f64(), syr: f64(),
    cu: f64(), cv: f64(), out: f64(), tin: f64(),
    tOld: new Float32Array(n), prevU: new Float32Array(n), prevV: new Float32Array(n),
    hatU: new Float32Array(n), hatV: new Float32Array(n),
    minU: new Float32Array(n), maxU: new Float32Array(n), minV: new Float32Array(n), maxV: new Float32Array(n),
    faceMask: new Uint8Array(n),
    queue: new Int32Array(n), dist: new Int32Array(n), stamp: new Int32Array(n), stampId: 0,
    targets: new Int32Array(n),
  };
  return work;
}

/** MC (monotonized central) limiter. a = backward difference, b = forward difference. */
function mc(a: number, b: number): number {
  if (a * b <= 0) return 0;
  const aa = a < 0 ? -a : a, ab = b < 0 ? -b : b;
  let m = 0.5 * (aa + ab);
  if (2 * aa < m) m = 2 * aa;
  if (2 * ab < m) m = 2 * ab;
  return a > 0 ? m : -m;
}

/**
 * One fused substep for air (and vapor if `withVapor`): slopes, face fluxes and the update in a single row-major
 * sweep, reading w.qa/w.ra and writing w.qb/w.rb. When cell c is visited, its new value is initialized and the
 * fluxes through its left and top faces are applied to it and to c-1 / c-nx (visited earlier, so already
 * initialized, and their slopes are ready). Non-gas cells are never read or written.
 */
function massSubstep(nx: number, ny: number, w: Work, k: number, hoLimit: number, withVapor: boolean) {
  const { isGas, slopeMask, out, qa, qb, ra, rb, sxq, syq, sxr, syr, cu, cv } = w;
  for (let j = 1; j < ny - 1; j++) {
    for (let i = 1; i < nx - 1; i++) {
      const c = i + j * nx;
      if (!isGas[c]) continue;
      const m = out[c] > hoLimit ? 0 : slopeMask[c];
      const q = qa[c];
      qb[c] = q;
      sxq[c] = m & 1 ? mc(q - qa[c - 1], qa[c + 1] - q) : 0;
      syq[c] = m & 2 ? mc(q - qa[c - nx], qa[c + nx] - q) : 0;
      if (withVapor) {
        const r = ra[c];
        rb[c] = r;
        sxr[c] = m & 1 ? mc(r - ra[c - 1], ra[c + 1] - r) : 0;
        syr[c] = m & 2 ? mc(r - ra[c - nx], ra[c + nx] - r) : 0;
      }
      // left face (c-1 | c); cu is 0 unless both are gas
      let C = cu[c] * k;
      if (C !== 0) {
        const d = C > 0 ? c - 1 : c;
        const g = C > 0 ? 0.5 * (1 - C) : -0.5 * (1 + C);
        const f = C * (qa[d] + g * sxq[d]);
        qb[c - 1] -= f; qb[c] += f;
        if (withVapor) { const fr = C * (ra[d] + g * sxr[d]); rb[c - 1] -= fr; rb[c] += fr; }
      }
      // top face (c-nx | c)
      C = cv[c] * k;
      if (C !== 0) {
        const d = C > 0 ? c - nx : c;
        const g = C > 0 ? 0.5 * (1 - C) : -0.5 * (1 + C);
        const f = C * (qa[d] + g * syq[d]);
        qb[c - nx] -= f; qb[c] += f;
        if (withVapor) { const fr = C * (ra[d] + g * syr[d]); rb[c - nx] -= fr; rb[c] += fr; }
      }
    }
  }
}

function advectTemperature(grid: MacGrid, T: Float32Array, w: Work, dt: number, maxIn: number) {
  const { nx, ny, u, v } = grid;
  const { open, tOld } = w;
  if (maxIn === 0) return;
  const steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(maxIn / TEMP_CFL)));
  const k = dt / grid.h / steps;
  for (let st = 0; st < steps; st++) {
    tOld.set(T);
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const c = i + j * nx;
        if (!open[c]) continue;
        let a = 0, b = 0; // a = Σ C_in, b = Σ C_in · T_nb
        let x: number;
        if (open[c - 1] && (x = u[c]) > 0) { a += x; b += x * tOld[c - 1]; }
        if (open[c + 1] && (x = u[c + 1]) < 0) { a -= x; b -= x * tOld[c + 1]; }
        if (open[c - nx] && (x = v[c]) > 0) { a += x; b += x * tOld[c - nx]; }
        if (open[c + nx] && (x = v[c + nx]) < 0) { a -= x; b -= x * tOld[c + nx]; }
        if (a === 0) continue;
        a *= k; b *= k;
        if (a > 1) { b /= a; a = 1; } // only if MAX_SUBSTEPS was hit: stay convex
        T[c] = tOld[c] * (1 - a) + b;
      }
    }
  }
}

function advect(grid: MacGrid, gas: GasState, dt: number) {
  const { nx, ny, u, v, s, cellType } = grid;
  const w = getWork(nx * ny);
  const { isGas, open, slopeMask, out, tin, cu, cv, qa, ra } = w;
  const air = gas.air, vapor = gas.vapor;
  const k0 = dt / grid.h;

  // Pass 1 (interior only; the ring stays 0 in the masks): masks, Courant numbers (full dt) on gas–gas faces,
  // per-cell outgoing Courant sums (mass) and incoming sums (temperature), scattered from each face, and the
  // Float64 working copies.
  let withVapor = false;
  for (let j = 1; j < ny - 1; j++) {
    for (let i = 1; i < nx - 1; i++) {
      const c = i + j * nx;
      const o = s[c] > 0 && cellType[c] !== SOLID;
      const gc = o && cellType[c] === GAS;
      open[c] = o ? 1 : 0;
      isGas[c] = gc ? 1 : 0;
      out[c] = 0; tin[c] = 0;
      qa[c] = air[c];
      const r = vapor[c];
      ra[c] = r;
      if (r !== 0) withVapor = true;
      if (!o) { cu[c] = 0; cv[c] = 0; continue; }
      let x = u[c] * k0;
      if (open[c - 1]) { if (x > 0) tin[c] += x; else tin[c - 1] -= x; }
      if (gc && isGas[c - 1]) { cu[c] = x; if (x > 0) out[c - 1] += x; else out[c] -= x; } else cu[c] = 0;
      x = v[c] * k0;
      if (open[c - nx]) { if (x > 0) tin[c] += x; else tin[c - nx] -= x; }
      if (gc && isGas[c - nx]) { cv[c] = x; if (x > 0) out[c - nx] += x; else out[c] -= x; } else cv[c] = 0;
    }
  }
  // Pass 2: maxima, and where a second-order slope is geometrically possible.
  let maxOut = 0, maxIn = 0;
  for (let j = 1; j < ny - 1; j++) {
    for (let i = 1; i < nx - 1; i++) {
      const c = i + j * nx;
      if (tin[c] > maxIn) maxIn = tin[c];
      if (!isGas[c]) continue;
      if (out[c] > maxOut) maxOut = out[c];
      slopeMask[c] = (isGas[c - 1] && isGas[c + 1] ? 1 : 0) | (isGas[c - nx] && isGas[c + nx] ? 2 : 0);
    }
  }
  if (maxOut > 0) {
    const steps = Math.min(MAX_SUBSTEPS, Math.max(Math.ceil(maxOut), Math.min(Math.ceil(maxOut / HO_CFL), HO_MAX_STEPS), 1));
    const k = 1 / steps;
    const hoLimit = HO_CFL * steps; // second order only where the per-substep outflow sum is ≤ HO_CFL
    for (let st = 0; st < steps; st++) {
      massSubstep(nx, ny, w, k, hoLimit, withVapor);
      let t = w.qa; w.qa = w.qb; w.qb = t;
      t = w.ra; w.ra = w.rb; w.rb = t;
    }
    // Write back. Rounding can leave values like -1e-20 where a cell was drained exactly; clamp those.
    const qf = w.qa, rf = w.ra;
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const c = i + j * nx;
        if (!isGas[c]) continue;
        air[c] = qf[c] > 0 ? qf[c] : 0;
        if (withVapor) vapor[c] = rf[c] > 0 ? rf[c] : 0;
      }
    }
  }
  advectTemperature(grid, gas.T, w, dt, maxIn);
}

// ---------------------------------------------------------------- velocity

/** Min / max of the four values used by the last sample() call (for the MacCormack clamp). */
let sMin = 0, sMax = 0;

/**
 * Bilinear sample of a staggered component at (gx, gy) in that component's own index space (F[i + j*nx] sits at
 * (i, j)); the caller has already clamped gx, gy so the 2x2 stencil stays in the grid. Records the stencil min/max.
 */
function sample(F: Float32Array, nx: number, gx: number, gy: number): number {
  const i = gx | 0, j = gy | 0, fx = gx - i, fy = gy - j;
  const c = i + j * nx;
  const a = F[c], b = F[c + 1], d = F[c + nx], e = F[c + nx + 1];
  let lo = a < b ? a : b, hi = a < b ? b : a;
  if (d < lo) lo = d; else if (d > hi) hi = d;
  if (e < lo) lo = e; else if (e > hi) hi = e;
  sMin = lo; sMax = hi;
  return (1 - fy) * ((1 - fx) * a + fx * b) + fy * ((1 - fx) * d + fx * e);
}

/** Same as sample() without the min/max bookkeeping. */
function sampleFast(F: Float32Array, nx: number, gx: number, gy: number): number {
  const i = gx | 0, j = gy | 0, fx = gx - i, fy = gy - j;
  const c = i + j * nx;
  return (1 - fy) * ((1 - fx) * F[c] + fx * F[c + 1]) + fy * ((1 - fx) * F[c + nx] + fx * F[c + nx + 1]);
}

/**
 * Semi-Lagrangian advection of the gas–gas faces with a MacCormack correction (Selle et al. 2008): a backtrace gives
 * û, a forward trace of û gives ũ, and u = û + ½(u − ũ), clamped to the min/max of the backtrace stencil so it
 * can't overshoot. Damping is much lower than plain bilinear backtracing (vortex test: 75% vs 43% KE after 2 s).
 * u and v are written in place (no buffer swapping). Traced points are clamped to the interior (inside the outer
 * solid ring). Work is in index units: a u face (i, j) is at u-index (i, j), physical ((i)h, (j+½)h).
 */
function advectVelocity(grid: MacGrid, dt: number) {
  const { nx, ny, h, u, v, cellType } = grid;
  const n = nx * ny;
  const w = getWork(n);
  const { prevU: U, prevV: V, hatU, hatV, minU, maxU, minV, maxV, faceMask } = w;
  U.set(u); V.set(v);
  hatU.set(u); hatV.set(v);
  const k = dt / h;
  // Interior clamp, in each component's index space: physical x in [h, (nx-1)h], y in [h, (ny-1)h].
  const uxHi = nx - 1.0001, uyLo = 0.5, uyHi = ny - 1.5;
  const vxLo = 0.5, vxHi = nx - 1.5, vyHi = ny - 1.0001;
  // Backtrace: û on gas–gas faces (faceMask bit 0: u face, bit 1: v face).
  for (let j = 1; j < ny - 1; j++) {
    for (let i = 1; i < nx - 1; i++) {
      const c = i + j * nx;
      let m = 0;
      if (cellType[c] === GAS) {
        if (i > 1 && cellType[c - 1] === GAS) {
          m |= 1;
          const vu = 0.25 * (V[c - 1] + V[c] + V[c - 1 + nx] + V[c + nx]);
          let x = i - k * U[c], y = j - k * vu;
          x = x < 1 ? 1 : x > uxHi ? uxHi : x; y = y < uyLo ? uyLo : y > uyHi ? uyHi : y;
          hatU[c] = sample(U, nx, x, y);
          minU[c] = sMin; maxU[c] = sMax;
        }
        if (j > 1 && cellType[c - nx] === GAS) {
          m |= 2;
          const uv = 0.25 * (U[c - nx] + U[c - nx + 1] + U[c] + U[c + 1]);
          let x = i - k * uv, y = j - k * V[c];
          x = x < vxLo ? vxLo : x > vxHi ? vxHi : x; y = y < 1 ? 1 : y > vyHi ? vyHi : y;
          hatV[c] = sample(V, nx, x, y);
          minV[c] = sMin; maxV[c] = sMax;
        }
      }
      faceMask[c] = m;
    }
  }
  // Forward trace of û, error correction, clamp.
  for (let j = 1; j < ny - 1; j++) {
    for (let i = 1; i < nx - 1; i++) {
      const c = i + j * nx;
      const m = faceMask[c];
      if (m === 0) continue;
      if (m & 1) {
        const vu = 0.25 * (V[c - 1] + V[c] + V[c - 1 + nx] + V[c + nx]);
        let x = i + k * U[c], y = j + k * vu;
        x = x < 1 ? 1 : x > uxHi ? uxHi : x; y = y < uyLo ? uyLo : y > uyHi ? uyHi : y;
        let r = hatU[c] + 0.5 * (U[c] - sampleFast(hatU, nx, x, y));
        if (r < minU[c]) r = minU[c]; else if (r > maxU[c]) r = maxU[c];
        u[c] = r;
      }
      if (m & 2) {
        const uv = 0.25 * (U[c - nx] + U[c - nx + 1] + U[c] + U[c + 1]);
        let x = i + k * uv, y = j + k * V[c];
        x = x < vxLo ? vxLo : x > vxHi ? vxHi : x; y = y < 1 ? 1 : y > vyHi ? vyHi : y;
        let r = hatV[c] + 0.5 * (V[c] - sampleFast(hatV, nx, x, y));
        if (r < minV[c]) r = minV[c]; else if (r > maxV[c]) r = maxV[c];
        v[c] = r;
      }
    }
  }
}

// ---------------------------------------------------------------- remap

/**
 * BFS from `start` up to REMAP_RADIUS steps through cells that are open now, or were open before (so mass can
 * escape a region that just turned solid). Collects into w.targets the cells at the smallest distance that are
 * GAS now and were GAS before (cells that just turned gas stay near-vacuum). Returns the count.
 */
function findTargets(grid: MacGrid, prevType: Int32Array, w: Work, start: number): number {
  const { nx, ny, cellType, s } = grid;
  const { queue, dist, stamp, targets } = w;
  if (++w.stampId >= 0x7fffffff) { stamp.fill(0); w.stampId = 1; }
  const sid = w.stampId;
  let head = 0, tail = 0, found = 0, foundDist = -1;
  queue[tail++] = start; stamp[start] = sid; dist[start] = 0;
  while (head < tail) {
    const c = queue[head++];
    const d = dist[c];
    if (foundDist >= 0 && d > foundDist) break;
    if (c !== start && cellType[c] === GAS && prevType[c] === GAS) {
      targets[found++] = c; foundDist = d;
      continue;
    }
    if (d >= REMAP_RADIUS || foundDist >= 0) continue;
    const i = c % nx, j = (c - i) / nx;
    for (let e = 0; e < 4; e++) {
      let nb: number;
      if (e === 0) { if (i <= 1) continue; nb = c - 1; }
      else if (e === 1) { if (i >= nx - 2) continue; nb = c + 1; }
      else if (e === 2) { if (j <= 1) continue; nb = c - nx; }
      else { if (j >= ny - 2) continue; nb = c + nx; }
      if (stamp[nb] === sid) continue;
      const passable = (cellType[nb] !== SOLID && s[nb] !== 0) || prevType[nb] !== SOLID;
      if (!passable) continue;
      stamp[nb] = sid; dist[nb] = d + 1; queue[tail++] = nb;
    }
  }
  return found;
}

function remap(grid: MacGrid, gas: GasState, prevType: Int32Array) {
  const { nx, ny, cellType } = grid;
  const n = nx * ny;
  const w = getWork(n);
  const { air, vapor, pendingAir, pendingVapor } = gas;

  // 1. Cells holding gas that are no longer gas: push their mass to the nearest cells that stayed gas, split
  //    evenly among all of them at that distance; with none in reach, hold it as pending at the cell.
  for (let c = 0; c < n; c++) {
    if (cellType[c] === GAS) continue;
    const a = air[c], b = vapor[c];
    if (a === 0 && b === 0) continue;
    air[c] = 0; vapor[c] = 0;
    const k = findTargets(grid, prevType, w, c);
    if (k === 0) { pendingAir[c] += a; pendingVapor[c] += b; continue; }
    const fa = a / k, fb = b / k;
    for (let t = 0; t < k; t++) {
      const d = w.targets[t];
      air[d] += fa; vapor[d] += fb;
    }
  }

  // 2. Cells that were SOLID and are now GAS (erased wall, burnt-out wood, melted ice) open up full of ambient
  //    air rather than as a vacuum. This creates mass (like the atmosphere boundary), on purpose: a wall vanishing
  //    shouldn't suck in its surroundings. LIQUID -> GAS cells, in contrast, start empty.
  for (let c = 0; c < n; c++) {
    if (cellType[c] === GAS && prevType[c] === SOLID && air[c] === 0 && vapor[c] === 0) air[c] = RHO_AIR;
  }

  // 3. Release pending mass. Pending in a gas cell joins it directly. Pending in a non-gas cell goes to the nearest
  //    gas cell within PENDING_RADIUS (Chebyshev), preferring cells that just became gas (LIQUID -> GAS starts as a
  //    near-vacuum; this is how a moving or collapsed bubble's mass re-emerges). Otherwise it stays pending.
  for (let c = 0; c < n; c++) {
    const a = pendingAir[c], b = pendingVapor[c];
    if (a === 0 && b === 0) continue;
    let dst = -1;
    if (cellType[c] === GAS) dst = c;
    else {
      const i = c % nx, j = (c - i) / nx;
      let best = 1e9;
      for (let dj = -PENDING_RADIUS; dj <= PENDING_RADIUS; dj++) {
        const jj = j + dj;
        if (jj < 1 || jj > ny - 2) continue;
        for (let di = -PENDING_RADIUS; di <= PENDING_RADIUS; di++) {
          const ii = i + di;
          if (ii < 1 || ii > nx - 2) continue;
          const d = ii + jj * nx;
          if (cellType[d] !== GAS) continue;
          const score = di * di + dj * dj - (prevType[d] !== GAS ? 100 : 0);
          if (score < best) { best = score; dst = d; }
        }
      }
    }
    if (dst < 0) continue;
    air[dst] += a; vapor[dst] += b;
    pendingAir[c] = 0; pendingVapor[c] = 0;
  }
}

// ---------------------------------------------------------------- atmosphere / totals

/**
 * Open sky: the top interior row's gas cells are reset to ambient (air, vapor and T). This is the only
 * non-conservative boundary (the other mass source is remap's SOLID -> GAS fill): the atmosphere is an infinite reservoir that absorbs or supplies whatever mass flows through row 1.
 */
function applyAtmosphere(grid: MacGrid, gas: GasState, openTop: boolean) {
  if (!openTop) return;
  const { nx, s, cellType } = grid;
  for (let i = 1; i < nx - 1; i++) {
    const c = i + nx;
    if (s[c] === 0 || cellType[c] !== GAS) continue;
    gas.air[c] = RHO_AIR; gas.vapor[c] = 0; gas.T[c] = T_AMBIENT;
  }
}

function totals(gas: GasState) {
  let air = 0, vapor = 0;
  const n = gas.air.length;
  for (let c = 0; c < n; c++) {
    air += gas.air[c] + gas.pendingAir[c];
    vapor += gas.vapor[c] + gas.pendingVapor[c];
  }
  return { air, vapor };
}

export const gasTransport: GasTransport = { remap, advect, advectVelocity, applyAtmosphere, totals };
