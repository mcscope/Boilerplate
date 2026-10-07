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
 * 5. Coalesce partial balances (opposite balances in neighboring cells net out; otherwise merge into a larger
 *    neighbor up to 2 cells away; an isolated partial condensate drifts down at K_SETTLE so films run down walls
 *    and collect), pool the partial balances of each connected body of water into one cell so they add up to
 *    whole particles, settle accumulators (remove / spawn particles), apply queued heat (to particle temps where
 *    the cell has particles, a neighbor's particles if a liquid cell lost all of its own, else to the cell T).
 */
import {
  ALC_COMBUSTION, ALC_MOLAR_RATIO, B_ALC, GAS, LIQUID, LATENT_ALCOHOL, LATENT_VAPORIZATION, P0, PhaseContext,
  VAPOR_MOLAR_RATIO, alcMoleFraction, psat, psatAlc, saturatedAlc, saturatedVapor,
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

/** Enthalpy of alcohol vapor per unit mass, on the same footing as H_VAPOR. */
export const H_ALC = LATENT_ALCOHOL + 100;
/** Rate (1/s) at which alcohol spreads evenly through the water in a cell: water and alcohol mix. */
const K_MIX = 8;
/** Alcohol vapor burns above this temperature (°C): a flame, the torch or a fire nearby gets it there. */
export const ALC_IGNITE = 365;
/**
 * Below this mole fraction (3.3%) alcohol vapor is too lean to burn. There's no rich limit: vapor too rich to burn
 * premixed still burns where it meets air (a diffusion flame), at the rate the air in the cell allows.
 */
const ALC_LEAN = 0.033;
/** Burning rate of a flammable cell, 1/s (fast: a flame front). */
const K_BURN = 40;
/** Air needed to burn a unit mass of alcohol (stoichiometric, by mass). */
const AIR_PER_ALC = 9;
/** Hottest a burning gas cell gets (°C). */
const T_FLAME_MAX = 1800;

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

// Alcohol saturation, same table layout.
let satATable: Float64Array | null = null;
function satA(T: number): number {
  let x = (T - SAT_LO) / SAT_STEP;
  if (x <= 0) x = 0; else if (x >= SAT_N - 1.000001) x = SAT_N - 1.000001;
  const i = x | 0, t = x - i, tab = satATable!;
  return tab[i] + (tab[i + 1] - tab[i]) * t;
}

// Bubble point of a water–alcohol liquid: the temperature where (1 - x)·psat(T) + x·psatAlc(T) = p.
// Tabulated over alcohol mole fraction x (0..1) and log pressure (P_MIN..P_MAX ×P0), bilinear lookup.
const BX = 64, BP = 64;
let bubbleTable: Float64Array | null = null;
function bubbleT(p: number, x: number): number {
  if (!bubbleTable) {
    bubbleTable = new Float64Array((BX + 1) * (BP + 1));
    for (let a = 0; a <= BX; a++) for (let b = 0; b <= BP; b++) {
      const xx = a / BX, pp = P0 * Math.exp(Math.log(P_MIN) + (Math.log(P_MAX) - Math.log(P_MIN)) * b / BP);
      let lo = -60, hi = 450;
      for (let it = 0; it < 48; it++) {
        const m = 0.5 * (lo + hi);
        if ((1 - xx) * psat(m) + xx * psatAlc(m) > pp) hi = m; else lo = m;
      }
      bubbleTable[a * (BP + 1) + b] = 0.5 * (lo + hi);
    }
  }
  let fx = x * BX; fx = fx < 0 ? 0 : fx > BX - 1e-9 ? BX - 1e-9 : fx;
  let fp = (Math.log(p / P0) - Math.log(P_MIN)) / (Math.log(P_MAX) - Math.log(P_MIN)) * BP;
  fp = fp < 0 ? 0 : fp > BP - 1e-9 ? BP - 1e-9 : fp;
  const a = fx | 0, b = fp | 0, tx = fx - a, tp = fp - b, t = bubbleTable, W = BP + 1;
  return (t[a * W + b] * (1 - tp) + t[a * W + b + 1] * tp) * (1 - tx) + (t[(a + 1) * W + b] * (1 - tp) + t[(a + 1) * W + b + 1] * tp) * tx;
}

/** Mass fraction of alcohol in the vapor over a liquid with alcohol mole fraction x at temperature T, pressure p. */
function vaporAlcFraction(x: number, T: number, p: number): number {
  const ye = Math.min(1, (x * psatAlc(T)) / p); // mole fraction (Raoult)
  return (ye * 46.07) / (ye * 46.07 + (1 - ye) * 18.02);
}

// ---- module state (allocated on first use, reused) ----
let nCells = 0, maxP = 0;
let vaporRef: Float32Array | null = null;
const st = {
  accM: new Float64Array(0), accH: new Float64Array(0), dQ: new Float64Array(0),
  /** Alcohol mass owed by the liquid (> 0) or condensed into it but not yet placed (< 0), per cell. Part of accM. */
  accA: new Float64Array(0), meanAlc: new Float64Array(0), burnRate: new Float32Array(0),
  nAll: new Int32Array(0), nLive: new Int32Array(0), nWater: new Int32Array(0),
  sumTW: new Float64Array(0), satL: new Float64Array(0),
  start: new Int32Array(0), fill: new Int32Array(0), pool: new Int32Array(0), stack: new Int32Array(0),
  list: new Int32Array(0), cellOf: new Int32Array(0), dead: new Uint8Array(0), removeList: new Int32Array(0),
};

function ensure(n: number, mp: number, vapor: Float32Array) {
  if (!satTable) {
    satTable = new Float64Array(SAT_N);
    for (let i = 0; i < SAT_N; i++) satTable[i] = saturatedVapor(SAT_LO + i * SAT_STEP);
    satATable = new Float64Array(SAT_N);
    for (let i = 0; i < SAT_N; i++) satATable[i] = saturatedAlc(SAT_LO + i * SAT_STEP);
  }
  if (n !== nCells) {
    nCells = n;
    st.accM = new Float64Array(n); st.accH = new Float64Array(n); st.dQ = new Float64Array(n);
    st.accA = new Float64Array(n); st.meanAlc = new Float64Array(n); st.burnRate = new Float32Array(n);
    st.nAll = new Int32Array(n); st.nLive = new Int32Array(n); st.nWater = new Int32Array(n);
    st.sumTW = new Float64Array(n); st.satL = new Float64Array(n);
    st.start = new Int32Array(n + 1); st.fill = new Int32Array(n);
    st.pool = new Int32Array(n); st.stack = new Int32Array(n);
  }
  if (mp > maxP) {
    maxP = mp;
    st.list = new Int32Array(mp); st.cellOf = new Int32Array(mp); st.dead = new Uint8Array(mp); st.removeList = new Int32Array(mp);
  }
  if (vapor !== vaporRef) { vaporRef = vapor; st.accM.fill(0); st.accH.fill(0); st.accA.fill(0); }
}

/** Clear the accumulators (call on level load). */
export function resetPhase(): void { st.accM.fill(0); st.accH.fill(0); st.accA.fill(0); st.burnRate.fill(0); }

/** Alcohol vapor burning in each cell this step (mass per second), for flames and rendering. */
export function alcoholBurning(): Float32Array { return st.burnRate; }

/** Totals of the whole-particle accumulators, for conservation checks (see the header for how they enter M and E). */
export function phaseLedger(): { mass: number; heat: number; alc: number } {
  let m = 0, e = 0, a = 0;
  const { accM, accH, accA } = st;
  for (let c = 0; c < nCells; c++) { m += accM[c]; e += accH[c]; a += accA[c]; }
  return { mass: m, heat: e, alc: a };
}

/** Per-cell mass balance (> 0 owed by the liquid, < 0 condensed but not yet a particle), for debugging / rendering. */
export function phaseBalance(): Float64Array { return st.accM; }

/** Add dm (> 0 owed by liquid, < 0 credited to liquid) at temperature T to cell c's accumulator, conserving energy. */
/**
 * Condensation of a water–alcohol vapor with nothing to condense onto but itself (a cold wall, fog). It condenses
 * once Σ pᵢ/psatᵢ > 1 (its dew point), as a liquid in equilibrium with it: mole fractions ∝ pᵢ/psatᵢ (Raoult), so
 * the condensate is richer in water than the vapor and what stays behind is richer in alcohol. Returns the water
 * and alcohol masses that condense, moving Σ pᵢ/psatᵢ a fraction `rate` of the way back to 1.
 */
function dew(vap: number, av: number, sv: number, sa: number, rate: number): [number, number] {
  const rw = vap / sv, ra = av > 0 ? av / sa : 0, r = rw + ra;
  if (r <= 1) return [0, 0];
  const xw = rw / r, xa = ra / r; // condensate mole fractions
  const n = (rate * (r - 1)) / ((xw * 18.02) / sv + (xa * 46.07) / sa);
  return [Math.min(vap, n * xw * 18.02), Math.min(av, n * xa * 46.07)];
}

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
  const { vapor, pendingVapor, T, alcVapor, pendingAlc } = gas;
  const pressure = ctx.pressure;
  const n = nx * ny;
  const rest = ctx.restDensity;
  const MP = 1 / rest;
  ensure(n, P.temp.length, vapor);
  const { accM, accH, dQ, nAll, nLive, nWater, sumTW, satL, start, fill, list, cellOf, dead, removeList, accA, meanAlc, burnRate } = st;
  const pos = P.pos, kind = P.kind, temp = P.temp, silt = P.silt, alc = P.alc;
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

  // ---- 0. water and alcohol mix: within a cell, the water particles' alcohol fractions even out ----
  const aMix = Math.min(1, K_MIX * dt);
  for (let c = 0; c < n; c++) {
    meanAlc[c] = 0;
    if (nAll[c] === 0) continue;
    let sa = 0, w = 0;
    for (let q = start[c]; q < start[c + 1]; q++) { const k = list[q]; if (kind[k] === WATER) { sa += alc[k]; w++; } }
    if (w === 0) continue;
    const m = sa / w;
    meanAlc[c] = m;
    if (m > 0 && w > 1) for (let q = start[c]; q < start[c + 1]; q++) { const k = list[q]; if (kind[k] === WATER) alc[k] += (m - alc[k]) * aMix; }
  }

  // ---- 1. boiling (limited by superheat) ----
  for (let c = 0; c < n; c++) {
    if (nAll[c] === 0 || s[c] === 0) continue;
    let p = pressure[c] > 0 ? pressure[c] : P0;
    p = p < P_MIN * P0 ? P_MIN * P0 : p > P_MAX * P0 ? P_MAX * P0 : p;
    // A water–alcohol mix boils at its bubble point, giving off vapor of the equilibrium composition.
    const xe = meanAlc[c] > 1e-5 ? alcMoleFraction(meanAlc[c]) : 0;
    const Ts = xe > 0 ? bubbleT(p, xe) : tsat(p);
    const wa = xe > 0 ? vaporAlcFraction(xe, Ts, p) : 0; // alcohol share of the vapor, by mass
    const Hv = wa * H_ALC + (1 - wa) * H_VAPOR;
    let dmTotal = 0;
    for (let q = start[c]; q < start[c + 1]; q++) {
      const k = list[q];
      if (kind[k] !== WATER || temp[k] <= Ts) continue;
      dmTotal += (MP * (temp[k] - Ts)) / (Hv - Ts);
      temp[k] = Ts;
    }
    if (dmTotal === 0) continue;
    const dmA = dmTotal * wa, dmW = dmTotal - dmA;
    accAdd(accM, accH, dQ, c, dmTotal, Ts);
    accA[c] += dmA;
    if (cellType[c] === GAS) { vapor[c] += dmW; alcVapor[c] += dmA; continue; }
    const g = cellType[c - nx] === GAS && s[c - nx] !== 0 ? c - nx
      : cellType[c - 1] === GAS && s[c - 1] !== 0 ? c - 1
      : cellType[c + 1] === GAS && s[c + 1] !== 0 ? c + 1
      : cellType[c + nx] === GAS && s[c + nx] !== 0 ? c + nx : -1;
    if (g >= 0) { vapor[g] += dmW; alcVapor[g] += dmA; }
    else { pendingVapor[c] += dmW; pendingAlc[c] += dmA; }
  }

  // ---- per-cell water temperature and its saturation vapor density ----
  for (let c = 0; c < n; c++) {
    nWater[c] = 0;
    if (nAll[c] === 0) continue;
    let sum = 0, w = 0;
    for (let q = start[c]; q < start[c + 1]; q++) { const k = list[q]; if (kind[k] === WATER) { sum += temp[k]; w++; } }
    nWater[c] = w;
    if (w > 0) { sumTW[c] = sum / w; satL[c] = satV(sum / w) * (1 - (meanAlc[c] > 0 ? alcMoleFraction(meanAlc[c]) : 0)); }
  }

  // ---- 2–4. exchange in gas cells ----
  const aSettle = Math.min(1, K_SETTLE * dt);
  const aEvap = Math.min(0.5, K_EVAP * dt), aWall = Math.min(0.5, K_WALL * dt), aFog = Math.min(1, K_FOG * dt);
  for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const c = i + j * nx;
    if (s[c] === 0 || cellType[c] !== GAS) continue;
    let vap = vapor[c], av = alcVapor[c];
    for (let f = 0; f < 5; f++) {
      const o = f === 0 ? c : f === 1 ? c - nx : f === 2 ? c - 1 : f === 3 ? c + 1 : c + nx;
      if (s[o] === 0) {
        // cold surface: condense only, as a film of the equilibrium water–alcohol mix
        const [dmW, dmA] = dew(vap, av, satV(T[o]), satA(T[o]), aWall);
        if (dmW + dmA > 0) {
          vap -= dmW; av -= dmA;
          dQ[o] += (H_VAPOR - T[o]) * dmW + (H_ALC - T[o]) * dmA;
          accAdd(accM, accH, dQ, c, -(dmW + dmA), T[o]);
          accA[c] -= dmA;
        }
        continue;
      }
      if (nWater[o] === 0 || (o !== c && cellType[o] !== LIQUID)) continue;
      const Tl = sumTW[o];
      // Raoult: each species heads for its own partial saturation over this liquid.
      const dm = aEvap * (satL[o] - vap); // > 0 evaporation, < 0 condensation onto the liquid
      const xe = meanAlc[o] > 0 ? alcMoleFraction(meanAlc[o]) : 0;
      const dmA = xe > 0 || av > 0 ? aEvap * (satA(Tl) * xe - av) : 0;
      if (dm === 0 && dmA === 0) continue;
      vap += dm;
      av += dmA;
      dQ[o] -= (H_VAPOR - Tl) * dm + (H_ALC - Tl) * dmA;
      accAdd(accM, accH, dQ, o, dm + dmA, Tl);
      accA[o] += dmA;
    }
    // fog: condensation in the gas itself, limited so the released heat doesn't overshoot saturation
    const Tc = T[c], sv = satV(Tc), sa = satA(Tc);
    if (vap / sv + (av > 0 ? av / sa : 0) > 1) {
      const TK = Tc + 273.15;
      const dW = sv * (B_CLAUSIUS / (TK * TK) - 1 / TK) * (H_VAPOR - Tc) / CAP_GAS;
      const dA = av > 0 ? sa * (B_ALC / (TK * TK) - 1 / TK) * (H_ALC - Tc) / CAP_GAS : 0;
      const [dmW, dmA] = dew(vap, av, sv, sa, aFog / (1 + Math.max(0, dW, dA)));
      vap -= dmW; av -= dmA;
      dQ[c] += (H_VAPOR - Tc) * dmW + (H_ALC - Tc) * dmA;
      accAdd(accM, accH, dQ, c, -(dmW + dmA), Tc);
      accA[c] -= dmA;
    }
    vapor[c] = vap;
    alcVapor[c] = av;
  }

  // ---- 4b. alcohol vapor burns: within its flammable range, with enough air, above its ignition temperature.
  // C2H5OH + 3 O2 -> 2 CO2 + 3 H2O: per unit of alcohol, 1.17 of water vapor appears and the air loses 0.17 net
  // (oxygen out, CO2 in), so mass is conserved; the heat of combustion goes into the cell. ----
  burnRate.fill(0);
  const aBurn = Math.min(1, K_BURN * dt), air = gas.air;
  for (let c = nx; c < n - nx; c++) {
    if (s[c] === 0 || cellType[c] !== GAS) continue;
    const av = alcVapor[c];
    if (av <= 0 || T[c] < ALC_IGNITE) continue;
    const ma = av / ALC_MOLAR_RATIO, y = ma / (ma + vapor[c] / VAPOR_MOLAR_RATIO + air[c]);
    if (y < ALC_LEAN) continue;
    const dm = Math.min(av * aBurn, air[c] / AIR_PER_ALC);
    if (dm <= 0) continue;
    alcVapor[c] = av - dm;
    vapor[c] += 1.17 * dm;
    air[c] -= 0.17 * dm;
    T[c] = Math.min(T_FLAME_MAX, T[c] + (ALC_COMBUSTION * dm) / CAP_GAS);
    burnRate[c] = dm / dt;
  }

  // ---- 5a. coalesce partial balances: a fraction of a particle drifts to the neighbor holding more of the same
  // sign (droplets merge, a thin film collects), and debt follows the water. Moves accM and accH together, so
  // mass and energy are unchanged. ----
  for (let c = nx; c < n - nx; c++) {
    const m = accM[c];
    if (m === 0) continue;
    const debt = m > 0;
    if (debt ? m >= MP && nWater[c] > 0 : m <= -MP && s[c] !== 0) continue;
    // Opposite balances next to each other belong to the same water (condensate touching liquid that owes
    // evaporation): net them out instead of keeping both, settling the heat difference as real heat (accAdd).
    let opp = -1, oppM = 0;
    for (let f = 0; f < 4; f++) {
      const o = f === 0 ? c - nx : f === 1 ? c - 1 : f === 2 ? c + 1 : c + nx;
      const mo = accM[o];
      if (s[o] === 0 || (debt ? mo >= 0 : mo <= 0) || (nWater[o] === 0 && nWater[c] === 0)) continue;
      if (Math.abs(mo) > oppM) { oppM = Math.abs(mo); opp = o; }
    }
    if (opp >= 0) {
      accAdd(accM, accH, dQ, opp, m, accH[c] / m);
      accA[opp] += accA[c];
      accM[c] = 0; accH[c] = 0; accA[c] = 0;
      continue;
    }
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
    accM[best] += m; accH[best] += accH[c]; accA[best] += accA[c];
    accM[c] = 0; accH[c] = 0; accA[c] = 0;
  }

  // ---- 5a'. pool partial balances per body of water: every cell holding water that is 4-connected to another is
  // the same liquid, so its fractions of a particle (condensate that landed on it, evaporation it owes) add up
  // to whole particles instead of each staying below one. They move with accAdd (heat differences settle as
  // real heat), into the cell of that body holding the largest balance. ----
  {
    const { pool, stack } = st;
    pool.fill(-1);
    for (let c0 = nx; c0 < n - nx; c0++) {
      if (nWater[c0] === 0 || pool[c0] !== -1) continue;
      // flood the body, remembering the cell with the largest partial balance
      let top = 0, head = 0, target = -1, targetM = 0;
      stack[top++] = c0; pool[c0] = c0;
      while (head < top) {
        const c = stack[head++];
        const am = Math.abs(accM[c]);
        if (am > targetM) { targetM = am; target = c; }
        for (let f = 0; f < 4; f++) {
          const o = f === 0 ? c - nx : f === 1 ? c - 1 : f === 2 ? c + 1 : c + nx;
          if (nWater[o] === 0 || pool[o] !== -1 || s[o] === 0) continue;
          pool[o] = c0; stack[top++] = o;
        }
      }
      if (target < 0 || top < 2) continue;
      for (let q = 0; q < top; q++) {
        const c = stack[q], m = accM[c];
        if (c === target || m === 0 || Math.abs(m) >= MP) continue;
        accAdd(accM, accH, dQ, target, m, accH[c] / m);
        accA[target] += accA[c];
        accM[c] = 0; accH[c] = 0; accA[c] = 0;
      }
    }
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
      accA[c] -= MP * alc[best];
      dQ[bestCell] += MP * (temp[best] - Ta); // its heat beyond what was booked stays with the liquid
      accM[c] -= MP;
      accH[c] -= MP * Ta;
    }
  }

  // ---- 5b. apply queued heat ----
  // A liquid cell whose particles were all removed has no heat store of its own (its T follows its particles):
  // hand its heat to a neighbor's liquid.
  for (let c = nx; c < n - nx; c++) {
    if (dQ[c] === 0 || nLive[c] > 0 || s[c] === 0 || cellType[c] !== LIQUID) continue;
    for (let f = 0; f < 4; f++) {
      const o = f === 0 ? c - nx : f === 1 ? c - 1 : f === 2 ? c + 1 : c + nx;
      if (nLive[o] > 0) { dQ[o] += dQ[c]; dQ[c] = 0; break; }
    }
  }
  for (let c = 0; c < n; c++) {
    const q = dQ[c];
    if (q === 0) continue;
    if (nLive[c] > 0) {
      const dT = q / (nLive[c] * MP);
      for (let r = start[c]; r < start[c + 1]; r++) { const k = list[r]; if (!dead[k]) temp[k] += dT; }
      if (cellType[c] === LIQUID) T[c] += dT;
    } else T[c] += q / (s[c] === 0 ? CAP_SOLID : CAP_GAS);
  }

  // ---- 5e. whatever alcohol balance is left shifts the composition of the cell's water: alcohol owed is swapped
  // for water (total liquid mass unchanged, so accM, which counts both, stays right), alcohol credited the other
  // way. ----
  for (let c = 0; c < n; c++) {
    const a = accA[c];
    if (a === 0) continue;
    if (Math.abs(a) < 1e-12) { accA[c] = 0; continue; }
    let room = 0;
    for (let q = start[c]; q < start[c + 1]; q++) {
      const k = list[q];
      if (!dead[k] && kind[k] === WATER) room += a > 0 ? MP * alc[k] : MP * (1 - alc[k]);
    }
    if (room <= 0) continue;
    const take = Math.min(Math.abs(a), room), f = take / room;
    for (let q = start[c]; q < start[c + 1]; q++) {
      const k = list[q];
      if (dead[k] || kind[k] !== WATER) continue;
      alc[k] = a > 0 ? alc[k] * (1 - f) : alc[k] + (1 - alc[k]) * f;
    }
    accA[c] -= a > 0 ? take : -take;
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
      const a = accA[c] < 0 ? Math.min(1, accA[c] / accM[c]) : 0; // alcohol share of the condensate
      if (!P.add(x, y, 0, DROP_SPEED, WATER, Ts, 0, a)) break;
      accM[c] += MP;
      accH[c] += MP * Ts;
      accA[c] += MP * a;
    }
  }

}
