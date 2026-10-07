// STUB: owned by workstream A (pressure solver). Replace with the real implementation; keep the exported names.
import { GasState, LiquidFields, MacGrid, ProjectOptions, ProjectResult } from './types';

export function project(grid: MacGrid, gas: GasState, liquid: LiquidFields, opts: ProjectOptions, pressureOut: Float32Array): ProjectResult {
  void grid; void gas; void liquid; void opts;
  pressureOut.fill(0);
  return { iterations: 0, residual: 0 };
}
