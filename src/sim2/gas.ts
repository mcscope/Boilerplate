// STUB: owned by workstream B (gas transport). Replace with the real implementation; keep the exported names.
import { GasState, GasTransport, MacGrid } from './types';

export const gasTransport: GasTransport = {
  remap(grid: MacGrid, gas: GasState, prevType: Int32Array) { void grid; void gas; void prevType; },
  advect(grid: MacGrid, gas: GasState, dt: number) { void grid; void gas; void dt; },
  advectVelocity(grid: MacGrid, dt: number) { void grid; void dt; },
  applyAtmosphere(grid: MacGrid, gas: GasState, openTop: boolean) { void grid; void gas; void openTop; },
  totals(gas: GasState) { let air = 0, vapor = 0; for (let c = 0; c < gas.air.length; c++) { air += gas.air[c]; vapor += gas.vapor[c]; } return { air, vapor }; },
};
