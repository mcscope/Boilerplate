/**
 * Shared contract for the unified physics engine (design/unified-physics.md).
 * Agents implementing solver.ts, gas.ts, phase.ts and unified.ts code against these types.
 * Don't change this file without coordinating: other modules depend on it.
 *
 * Grid conventions match src/sim/fluid.ts exactly:
 * - cell (i, j) has index c = i + j * nx; y points down; cell size h px.
 * - u[c] is the x-velocity on the LEFT face of cell c (between c-1 and c).
 * - v[c] is the y-velocity on the TOP face of cell c (between c-nx and c); positive v = downward.
 * - s[c] = 0 for solid cells, 1 for open cells. The outer ring of cells is always solid.
 */

/** Cell phases, numerically identical to FLUID / AIR / SOLID in src/sim/fluid.ts. */
export const LIQUID = 0;
export const GAS = 1;
export const SOLID = 2;

/** Atmospheric pressure, in (water density) * px²/s². Same value as the classic AIR_STIFFNESS. */
export const P0 = 60000;
/** Mass density of ambient air (water = 1). Real ratio is 1/830; exaggerated for numerical stability. */
export const RHO_AIR = 0.02;
/** Ambient temperature, °C. */
export const T_AMBIENT = 20;
/** Ratio of water vapor's molar mass to air's: vapor contributes vapor / 0.622 to the pressure. */
export const VAPOR_MOLAR_RATIO = 0.622;
/** Heat capacity ratio used for gas compressibility. */
export const GAMMA = 1.4;
/** Latent heat of vaporization, as °C of temperature change per unit of liquid mass (water ≈ 540). */
export const LATENT_VAPORIZATION = 540;

export interface MacGrid {
  readonly nx: number;
  readonly ny: number;
  readonly h: number;
  /** Face velocities (px/s), shared by liquid and gas. */
  u: Float32Array;
  v: Float32Array;
  /** 1 = open, 0 = solid. */
  s: Float32Array;
  /** LIQUID / GAS / SOLID per cell, set by the integration layer before projection. */
  cellType: Int32Array;
}

/**
 * Gas state, Eulerian, per cell. `air` and `vapor` are mass densities in units where ambient air = RHO_AIR
 * (so a cell of ambient air holds air = RHO_AIR, vapor = 0). Liquid and solid cells hold no gas.
 */
export interface GasState {
  air: Float32Array;
  vapor: Float32Array;
  /** Temperature, °C, for every cell (solid, liquid and gas). This is the same array as Thermo.T. */
  T: Float32Array;
  /** Gas mass that couldn't be placed when a cell turned liquid, kept so it isn't lost (per cell, [air, vapor]). */
  pendingAir: Float32Array;
  pendingVapor: Float32Array;
}

/** Liquid fields the solver needs, computed by the integration layer from particles each substep. */
export interface LiquidFields {
  /** Mass density of the liquid in each liquid cell (water 1, oil 0.7, wax 0.9, adjusted for temperature and silt). */
  rho: Float32Array;
  /** Particle density per cell (particle count, bilinear), for volume-drift compensation. */
  density: Float32Array;
  /** Rest particle density (particles per cell at rest). */
  restDensity: number;
}

export interface ProjectOptions {
  dt: number;
  /** If true, the top interior row (j = 1) is open atmosphere: Dirichlet p = P0. */
  openTop: boolean;
  /** Max PCG iterations and relative tolerance. */
  maxIters: number;
  tolerance: number;
  /** Strength of liquid volume-drift compensation (0 disables), as in the classic solver. */
  driftCompensation: number;
}

export interface ProjectResult {
  iterations: number;
  residual: number;
}

/**
 * A: pressure solver (src/sim2/solver.ts).
 * Given the velocity field after body forces (u*, v*), solve the unified variable-density, compressible-gas /
 * incompressible-liquid pressure equation and apply the pressure gradient to u, v in place.
 * Writes the solved pressure (absolute, same units as P0) into `pressureOut` for every non-solid cell
 * (solid cells: 0). Must not allocate per call beyond first use (cache work arrays).
 */
export type ProjectFn = (grid: MacGrid, gas: GasState, liquid: LiquidFields, opts: ProjectOptions, pressureOut: Float32Array) => ProjectResult;

/** Equation-of-state pressure of a gas cell. */
export function gasPressure(air: number, vapor: number, T: number): number {
  return (P0 / RHO_AIR) * (air + vapor / VAPOR_MOLAR_RATIO) * ((T + 273.15) / (T_AMBIENT + 273.15));
}

/** Saturation vapor pressure of water at temperature T (°C): equals P0 at 100 °C. */
export function psat(T: number): number {
  return P0 * Math.exp(4895 * (1 / 373.15 - 1 / (T + 273.15)));
}

/** Vapor mass density in equilibrium (saturated) at temperature T: inverse of the vapor term of gasPressure. */
export function saturatedVapor(T: number): number {
  return psat(T) * VAPOR_MOLAR_RATIO * RHO_AIR / P0 * ((T_AMBIENT + 273.15) / (T + 273.15));
}

/**
 * B: gas transport (src/sim2/gas.ts).
 */
export interface GasTransport {
  /**
   * Called after cells were (re)classified. For every cell that changed GAS -> LIQUID or GAS -> SOLID, move its
   * air/vapor mass conservatively into nearby gas cells (or into pending if none is reachable). For cells that
   * changed LIQUID -> GAS, start them empty (near-vacuum) but release any pending gas there first.
   * Cells that changed SOLID -> GAS (an erased wall, burnt wood, melted ice) are filled with ambient air: this
   * deliberately adds mass, so conservation checks should avoid levels where solids disappear.
   */
  remap(grid: MacGrid, gas: GasState, prevType: Int32Array): void;
  /** Conservative flux-form advection of air, vapor (gas cells only) and T (all non-solid cells) with u, v. */
  advect(grid: MacGrid, gas: GasState, dt: number): void;
  /**
   * Semi-Lagrangian advection of face velocities that lie between two gas cells (or gas and open boundary).
   * Faces touching liquid are left alone (FLIP owns them).
   */
  advectVelocity(grid: MacGrid, dt: number): void;
  /** Hold the top interior row at ambient air when the level is open to the sky. */
  applyAtmosphere(grid: MacGrid, gas: GasState, openTop: boolean): void;
  /** Total air and vapor mass (including pending), for conservation checks. */
  totals(gas: GasState): { air: number; vapor: number };
}

/**
 * C: phase change (src/sim2/phase.ts).
 * Evaporation / condensation / boiling between liquid water particles and the vapor field, with latent heat.
 */
export interface PhaseContext {
  grid: MacGrid;
  gas: GasState;
  /** Solved pressure from the last projection (absolute). */
  pressure: Float32Array;
  /** Particle access (the FLIP particle store of src/sim/fluid.ts). */
  particles: {
    /** Live: changes as particles are added or removed. */
    count: number;
    pos: Float32Array;
    vel: Float32Array;
    kind: Uint8Array; // 0 water, 1 oil, 2 wax; only water (0) evaporates
    temp: Float32Array;
    silt: Float32Array;
    add(x: number, y: number, vx: number, vy: number, kind: number, temp: number, silt: number): boolean;
    /** Removes particle k by swapping the last particle into its slot. */
    remove(k: number): void;
  };
  /** Per-cell fractional accumulators owned by the phase module (allocated by it on first use is fine). */
  dt: number;
  /** Silt left behind by evaporated water, per cell (the sediment system collects it). */
  residue: Float32Array;
  /** Rest particle density (particles per cell): one particle's mass is 1 / restDensity. */
  restDensity: number;
}

export type PhaseChangeFn = (ctx: PhaseContext) => void;
