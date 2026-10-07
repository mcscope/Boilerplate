/**
 * C: phase change for the unified engine (design/unified-physics.md).
 *
 * Evaporation, condensation and boiling move mass between liquid water particles and the gas `vapor` field,
 * and move latent heat with it. Nothing here is a rule like "water at 100° turns to steam": every transfer is a
 * rate toward equilibrium (saturation) or is limited by the heat that is actually available.
 *
 * ## Units and energy convention
 *
 * Mass: water density 1, cell volume 1, so one liquid particle has mass MP = 1 / restDensity (≈ 0.36).
 * Energy: "°C × unit mass of water" (water's specific heat = 1). Heat capacities:
 *  - liquid: each particle has capacity MP (oil and wax too). A cell's liquid heat lives in its particles' temps.
 *  - gas cell: CAP_GAS per cell (fixed, volumetric; the same convention as Thermo's CAP_AIR and as the
 *    T advection of the gas transport, which conserves Σ T per cell, not Σ mass·T).
 *  - solid cell: CAP_SOLID = 1.
 *  - vapor: carries no sensible heat of its own (its warmth is part of the gas cell's fixed capacity); it holds a
 *    constant enthalpy H_VAPOR = LATENT_VAPORIZATION + 100 per unit mass. Turning liquid at temperature T into
 *    vapor therefore costs H_VAPOR − T (= 540 at 100 °C, 560 at 80 °C, 520 at 120 °C — latent heat falls with
 *    temperature, as it really does), and condensing at T gives the same back.
 *
 * Conserved total (what the tests check):
 *    E = Σ_particles MP·temp + Σ_gas cells CAP_GAS·T + Σ_solid cells CAP_SOLID·T
 *        + H_VAPOR·(Σ vapor + Σ pendingVapor) − Σ accH
 *    M = Σ_water particles MP − Σ accM + Σ vapor + Σ pendingVapor
 * (liquid cells' T is derived from their particles by Thermo and is not part of E.)
 *
 * ## Whole particles
 * Liquid can only lose or gain whole particles, so each cell keeps a signed mass accumulator `accM`
 * (> 0: mass already turned into vapor that its water particles still owe; < 0: condensed mass not yet spawned as
 * a particle) and `accH`, the sensible heat associated with it. When accM ≥ MP a water particle is removed from the
 * cell (or a neighbor); when accM ≤ −MP a particle is spawned there. Both settle accH exactly, so E and M are
 * conserved to rounding.
 *
 * ## Processes (per call, in order)
 * 1. Boiling: a water particle hotter than Tsat(p_local) converts the excess heat MP·(T − Tsat) into vapor mass
 *    (MP·(T − Tsat) / (H_VAPOR − Tsat)) and drops to Tsat. The vapor goes into a gas neighbor of its cell if any
 *    (top first), else into the cell's pendingVapor, which the gas transport releases when the cell turns gas.
 * 2. Interface exchange: each gas cell relaxes its vapor toward saturatedVapor(T_liquid) of every adjacent liquid
 *    cell holding water (and of droplets inside it), at K_EVAP per second per face. Positive = evaporation
 *    (cools the liquid), negative = condensation onto the liquid (warms it).
 * 3. Cold surfaces: vapor above saturatedVapor(T_solid) next to a solid condenses at K_WALL; the heat goes into
 *    the solid, the droplet forms in the gas cell.
 * 4. Fog: vapor above saturatedVapor(T_gas) condenses in the gas at K_FOG, limited so the latent heat released
 *    into the cell doesn't overshoot equilibrium.
 * 5. Coalesce partial balances (merge into a larger neighbor up to 2 cells away; an isolated partial condensate
 *    drifts down at K_SETTLE so films run down walls and collect), settle accumulators (remove / spawn particles),
 *    apply queued heat (to particle temps where the cell has particles, else to the cell T).
 */
import {
  GAS, LIQUID, LATENT_VAPORIZATION, P0, PhaseContext, saturatedVapor,
} from './types';

/** Evaporation / condensation rate at a liquid–gas face, 1/s (fraction of the gap to saturation per second). */
export const K_EVAP = 4;
/** Condensation rate on a cold solid face, 1/s. */
export const K_WALL = 4;
/** Condensation rate of supersaturated vapor in open gas (fog), 1/s. */
export const K_FOG = 2;
/** Rate (1/s) at which a partial condensate balance with nothing larger nearby moves one cell down. */
export const K_SETTLE = 4;
/** Heat capacity of a gas cell and a solid cell (energy per °C), see the header. */
export const CAP_GAS = 0.5;
export const CAP_SOLID = 1;
/** Enthalpy of vapor per unit mass relative to liquid at 0 °C (latent heat at 100 °C + sensible to 100 °C). */
export const H_VAPOR = LATENT_VAPORIZATION + 100;
/** Downward speed (px/s) of a freshly condensed droplet. */
const DROP_SPEED = 10;
/** Boiling uses the local pressure clamped to this range (×P0), so a near-vacuum cell doesn't boil at room temperature. */
const P_MIN = 0.1, P_MAX = 50;
const WATER = 0;
const B_CLAUSIUS = 4895; // same constant as psat in types.ts

/** Saturation temperature (°C) at absolute pressure p: inverse of psat. */
export function tsat(p: number): number {
  return 1 / (1 / 373.15 - Math.log(p / P0) / B_CLAUSIUS) - 273.15;
}

// saturatedVapor from a table (linear interpolation, 1/8 °C steps; relative error < 1e-5): exp is the hot spot.
const SAT_LO = -100, SAT_HI = 600, SAT_STEP = 0.125;
const SAT_N = Math.round((SAT_HI - SAT_LO) / SAT_STEP) + 1;
let satTable: Float64Array | null = null;
function satV(T: number): number {
  let x = (T - SAT_LO) / SAT_STEP;
  if (x <= 0) x = 0; else if (x >= SAT_N - 1.000001) x = SAT_N - 1.000001;
  const i = x | 0, t = x - i, tab = satTable!;
  return tab[i] + (tab[i + 1] - tab[i]) * t;
}

// ---- module state (allocated on first use, reused) ----
let nCells = 0, maxP = 0;
let vaporRef: Float32Array | null = null;
const st = {
  accM: new Float64Array(0), accH: new Float64Array(0), dQ: new Float64Array(0),
  nAll: new Int32Array(0), nLive: new Int32Array(0), nWater: new Int32Array(0),
  sumTW: new Float64Array(0), satL: new Float64Array(0),
  start: new Int32Array(0), fill: new Int32Array(0),
  list: new Int32Array(0), cellOf: new Int32Array(0), dead: new Uint8Array(0), removeList: new Int32Array(0),
};

function ensure(n: number, mp: number, vapor: Float32Array) {
  if (!satTable) {
    satTable = new Float64Array(SAT_N);
    for (let i = 0; i < SAT_N; i++) satTable[i] = saturatedVapor(SAT_LO + i * SAT_STEP);
  }
  if (n !== nCells) {
    nCells = n;
    st.accM = new Float64Array(n); st.accH = new Float64Array(n); st.dQ = new Float64Array(n);
    st.nAll = new Int32Array(n); st.nLive = new Int32Array(n); st.nWater = new Int32Array(n);
    st.sumTW = new Float64Array(n); st.satL = new Float64Array(n);
    st.start = new Int32Array(n + 1); st.fill = new Int32Array(n);
  }
  if (mp > maxP) {
    maxP = mp;
    st.list = new Int32Array(mp); st.cellOf = new Int32Array(mp); st.dead = new Uint8Array(mp); st.removeList = new Int32Array(mp);
  }
  if (vapor !== vaporRef) { vaporRef = vapor; st.accM.fill(0); st.accH.fill(0); }
}

/** Clear the accumulators (call on level load). */
export function resetPhase(): void { st.accM.fill(0); st.accH.fill(0); }

/** Totals of the whole-particle accumulators, for conservation checks (see the header for how they enter M and E). */
export function phaseLedger(): { mass: number; heat: number } {
  let m = 0, e = 0;
  const { accM, accH } = st;
  for (let c = 0; c < nCells; c++) { m += accM[c]; e += accH[c]; }
  return { mass: m, heat: e };
}

/** Per-cell mass balance (> 0 owed by the liquid, < 0 condensed but not yet a particle), for debugging / rendering. */
export function phaseBalance(): Float64Array { return st.accM; }

/** Add dm (> 0 owed by liquid, < 0 credited to liquid) at temperature T to cell c's accumulator, conserving energy. */
function accAdd(accM: Float64Array, accH: Float64Array, dQ: Float64Array, c: number, dm: number, T: number) {
  const m = accM[c];
  if (m !== 0 && (m > 0) !== (dm > 0)) {
    // Cancel against the opposite balance at its own average temperature; the difference is real heat for the cell.
    const Ta = accH[c] / m;
    const x = Math.min(Math.abs(dm), Math.abs(m));
    const part = dm > 0 ? x : -x;
    accM[c] = m + part;
    accH[c] += part * Ta;
    dQ[c] += part * (Ta - T);
    dm -= part;
    if (accM[c] === 0 || Math.abs(accM[c]) < 1e-12) { dQ[c] -= accH[c] - accM[c] * T; accH[c] = accM[c] * T; }
  }
  accM[c] += dm;
  accH[c] += dm * T;
}

export function phaseChange(ctx: PhaseContext): void {
  const { grid, gas, dt, residue } = ctx;
  const P = ctx.particles;
  const { nx, ny, h, s, cellType } = grid;
  const { vapor, pendingVapor, T } = gas;
  const pressure = ctx.pressure;
  const n = nx * ny;
  const rest = ctx.restDensity;
  const MP = 1 / rest;
  ensure(n, P.temp.length, vapor);
  const { accM, accH, dQ, nAll, nLive, nWater, sumTW, satL, start, fill, list, cellOf, dead, removeList } = st;
  const pos = P.pos, kind = P.kind, temp = P.temp, silt = P.silt;
  const count = P.count;
  const inv = 1 / h;

  // ---- bucket particles by cell (counting sort) ----
  nAll.fill(0);
  dQ.fill(0);
  for (let k = 0; k < count; k++) {
    let i = Math.floor(pos[2 * k] * inv), j = Math.floor(pos[2 * k + 1] * inv);
    i = i < 0 ? 0 : i >= nx ? nx - 1 : i;
    j = j < 0 ? 0 : j >= ny ? ny - 1 : j;
    const c = i + j * nx;
    cellOf[k] = c;
    nAll[c]++;
    dead[k] = 0;
  }
  start[0] = 0;
  for (let c = 0; c < n; c++) { start[c + 1] = start[c] + nAll[c]; fill[c] = start[c]; nLive[c] = nAll[c]; }
  for (let k = 0; k < count; k++) list[fill[cellOf[k]]++] = k;

  // ---- 1. boiling (limited by superheat) ----
  for (let c = 0; c < n; c++) {
    if (nAll[c] === 0 || s[c] === 0) continue;
    let p = pressure[c] > 0 ? pressure[c] : P0;
    p = p < P_MIN * P0 ? P_MIN * P0 : p > P_MAX * P0 ? P_MAX * P0 : p;
    const Ts = tsat(p);
    let dmTotal = 0;
    for (let q = start[c]; q < start[c + 1]; q++) {
      const k = list[q];
      if (kind[k] !== WATER || temp[k] <= Ts) continue;
      dmTotal += (MP * (temp[k] - Ts)) / (H_VAPOR - Ts);
      temp[k] = Ts;
    }
    if (dmTotal === 0) continue;
    accAdd(accM, accH, dQ, c, dmTotal, Ts);
    if (cellType[c] === GAS) { vapor[c] += dmTotal; continue; }
    const g = cellType[c - nx] === GAS && s[c - nx] !== 0 ? c - nx
      : cellType[c - 1] === GAS && s[c - 1] !== 0 ? c - 1
      : cellType[c + 1] === GAS && s[c + 1] !== 0 ? c + 1
      : cellType[c + nx] === GAS && s[c + nx] !== 0 ? c + nx : -1;
    if (g >= 0) vapor[g] += dmTotal;
    else pendingVapor[c] += dmTotal;
  }

  // ---- per-cell water temperature and its saturation vapor density ----
  for (let c = 0; c < n; c++) {
    nWater[c] = 0;
    if (nAll[c] === 0) continue;
    let sum = 0, w = 0;
    for (let q = start[c]; q < start[c + 1]; q++) { const k = list[q]; if (kind[k] === WATER) { sum += temp[k]; w++; } }
    nWater[c] = w;
    if (w > 0) { sumTW[c] = sum / w; satL[c] = satV(sum / w); }
  }

  // ---- 2–4. exchange in gas cells ----
  const aSettle = Math.min(1, K_SETTLE * dt);
  const aEvap = Math.min(0.5, K_EVAP * dt), aWall = Math.min(0.5, K_WALL * dt), aFog = Math.min(1, K_FOG * dt);
  for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const c = i + j * nx;
    if (s[c] === 0 || cellType[c] !== GAS) continue;
    let vap = vapor[c];
    for (let f = 0; f < 5; f++) {
      const o = f === 0 ? c : f === 1 ? c - nx : f === 2 ? c - 1 : f === 3 ? c + 1 : c + nx;
      if (s[o] === 0) {
        // cold surface: condense only
        const sv = satV(T[o]);
        if (vap <= sv) continue;
        const dm = aWall * (vap - sv);
        vap -= dm;
        dQ[o] += (H_VAPOR - T[o]) * dm;
        accAdd(accM, accH, dQ, c, -dm, T[o]);
        continue;
      }
      if (nWater[o] === 0 || (o !== c && cellType[o] !== LIQUID)) continue;
      const Tl = sumTW[o];
      const dm = aEvap * (satL[o] - vap); // > 0 evaporation, < 0 condensation onto the liquid
      if (dm === 0) continue;
      vap += dm;
      dQ[o] -= (H_VAPOR - Tl) * dm;
      accAdd(accM, accH, dQ, o, dm, Tl);
    }
    // fog: condensation in the gas itself, limited so the released heat doesn't overshoot saturation
    const Tc = T[c];
    const sv = satV(Tc);
    if (vap > sv) {
      const TK = Tc + 273.15;
      const dsdT = sv * (B_CLAUSIUS / (TK * TK) - 1 / TK);
      const a = (H_VAPOR - Tc) / CAP_GAS;
      const dm = aFog * (vap - sv) / (1 + Math.max(0, dsdT) * a);
      vap -= dm;
      dQ[c] += (H_VAPOR - Tc) * dm;
      accAdd(accM, accH, dQ, c, -dm, Tc);
    }
    vapor[c] = vap;
  }

  // ---- 5a. coalesce partial balances: a fraction of a particle drifts to the neighbor holding more of the same
  // sign (droplets merge, a thin film collects), and debt follows the water. Moves accM and accH together, so
  // mass and energy are unchanged. ----
  for (let c = nx; c < n - nx; c++) {
    const m = accM[c];
    if (m === 0) continue;
    const debt = m > 0;
    if (debt ? m >= MP && nWater[c] > 0 : m <= -MP && s[c] !== 0) continue;
    const orphan = debt ? nWater[c] === 0 : s[c] === 0;
    let best = -1, bestM = orphan ? -1 : Math.abs(m);
    // 4 neighbors, then cells 2 away (through an open / watery middle cell), so isolated partial balances merge too
    for (let f = 0; f < 8; f++) {
      const d = f === 0 || f === 4 ? -nx : f === 1 || f === 5 ? -1 : f === 2 || f === 6 ? 1 : nx;
      let o = c + d;
      if (f >= 4) {
        if (debt ? nWater[o] === 0 : s[o] === 0) continue;
        o += d;
        if (o < 0 || o >= n) continue;
      }
      const mo = accM[o];
      if (debt ? nWater[o] === 0 || mo < 0 : s[o] === 0 || mo > 0) continue;
      const am = Math.abs(mo);
      if (am > bestM || (am === bestM && o < c && !orphan)) { bestM = am; best = o; }
    }
    // Partial condensate with nothing bigger nearby settles: a film runs down walls, mist drifts down, and they
    // collect and merge on the way.
    if (best < 0 && !debt && s[c + nx] !== 0 && Math.random() < aSettle) best = c + nx;
    if (best < 0) continue;
    accM[best] += m; accH[best] += accH[c];
    accM[c] = 0; accH[c] = 0;
  }

  // ---- 5b. settle debts: remove whole water particles ----
  let nRemove = 0;
  for (let c = 0; c < n; c++) {
    while (accM[c] >= MP) {
      const Ta = accH[c] / accM[c];
      // the live water particle closest to Ta, in the cell, else its neighbors
      let best = -1, bestD = Infinity, bestCell = -1;
      for (let f = 0; f < 5 && best < 0; f++) {
        const o = f === 0 ? c : f === 1 ? c - nx : f === 2 ? c - 1 : f === 3 ? c + 1 : c + nx;
        if (o < 0 || o >= n) continue;
        for (let q = start[o]; q < start[o + 1]; q++) {
          const k = list[q];
          if (dead[k] || kind[k] !== WATER) continue;
          const d = Math.abs(temp[k] - Ta);
          if (d < bestD) { bestD = d; best = k; bestCell = o; }
        }
      }
      if (best < 0) break;
      dead[best] = 1;
      removeList[nRemove++] = best;
      nLive[bestCell]--;
      residue[bestCell] += silt[best];
      dQ[bestCell] += MP * (temp[best] - Ta); // its heat beyond what was booked stays with the liquid
      accM[c] -= MP;
      accH[c] -= MP * Ta;
    }
  }

  // ---- 5b. apply queued heat ----
  for (let c = 0; c < n; c++) {
    const q = dQ[c];
    if (q === 0) continue;
    if (nLive[c] > 0) {
      const dT = q / (nLive[c] * MP);
      for (let r = start[c]; r < start[c + 1]; r++) { const k = list[r]; if (!dead[k]) temp[k] += dT; }
      if (cellType[c] === LIQUID) T[c] += dT;
    } else T[c] += q / (s[c] === 0 ? CAP_SOLID : CAP_GAS);
  }

  // ---- 5c. remove particles (descending index keeps swap-with-last safe) ----
  if (nRemove > 0) {
    // insertion sort descending (lists are short)
    for (let a = 1; a < nRemove; a++) {
      const v = removeList[a];
      let b = a - 1;
      while (b >= 0 && removeList[b] < v) { removeList[b + 1] = removeList[b]; b--; }
      removeList[b + 1] = v;
    }
    for (let a = 0; a < nRemove; a++) P.remove(removeList[a]);
  }

  // ---- 5d. settle credits: spawn droplets ----
  for (let c = 0; c < n; c++) {
    while (accM[c] <= -MP && s[c] !== 0) {
      const Ts = accH[c] / accM[c];
      const i = c % nx, j = (c - i) / nx;
      const x = (i + 0.2 + 0.6 * Math.random()) * h, y = (j + 0.2 + 0.6 * Math.random()) * h;
      if (!P.add(x, y, 0, DROP_SPEED, WATER, Ts, 0)) break;
      accM[c] += MP;
      accH[c] += MP * Ts;
    }
  }
}
