# Unified Physics: air as a real fluid

## Why

The liquid is real physics (FLIP particles + pressure projection). The air is not simulated: it's bookkeeping
layered on top, and each symptom got its own patch:

- uniform-pressure "regions"
- gas shuffling and deletion when liquid fills a cell
- bubble venting by face counting
- tiny voids treated as liquid
- a pressure cap
- injected flash expansion
- a separate steam particle system with sliding and condensing rules
- a buoyancy assist

The patches interact: fixing the dome broke the siphon. We replace all of it with one consistent model
where those behaviors **emerge**.

## The model

One MAC grid (same 160×90, h = 2 px, same face conventions as `src/sim/fluid.ts`). Every non-solid cell is either
**liquid** (has FLIP particles) or **gas**. The velocity field `u, v` covers both.

**Gas state per cell** (grid fields, Eulerian):

- `air`: mass density of air (1 = ambient air density ρa0 at 20 °C)
- `vapor`: mass density of water vapor, in the same units
- `T`: temperature, °C. This is the same array as `Thermo.T`, shared by solids, liquid and gas.

**Equation of state (ideal gas, two species):**

```
p = P0 * ((air + vapor / 0.622) / 1) * (T + 273.15) / (20 + 273.15)
```

`P0` = atmospheric pressure = 60000 px²/s² (in water-density units, same as the classic `AIR_STIFFNESS`).
The real air/water density ratio is 1/830. We use **ρa0 = 0.02** (exaggerated for stability), so a cell of
ambient air has mass density 0.02 and the liquid has density 1 (oil 0.7, wax 0.9).

**One pressure projection for everything** (variable density, compressible gas, incompressible liquid). Per
non-solid cell c, unknown pressure p:

```
Σ_faces open_f · (Δt / (ρ_f h²)) · (p_nb − p_c)  −  α_c (p_c − p*_c)  =  div(u*)_c / h  (− drift term in liquid)
α_c = 0 for liquid cells;  α_c = 1 / (Δt · γ · max(p*_c, p_min)) for gas cells (γ = 1.4)
```

- `p*_c` is the equation-of-state pressure from the advected gas state.
- `ρ_f` is the face density, averaged from the two cells (liquid: particle-mass density; gas: air + vapor).
- Velocity update: `u_f −= Δt/(ρ_f h)·(p_nb − p_c)`.
- Solve with preconditioned conjugate gradient (Jacobi or incomplete-Cholesky preconditioner).
- Solid faces: Neumann (no flow).
- **Atmosphere:** if the level has `openTop`, the top interior row is Dirichlet `p = P0`, and gas there is reset
  to ambient each step. Gas can flow in and out.

**Gravity acts on every face.** Buoyancy then emerges from the variable-density projection: light gas rises
through heavy liquid, oil rises through water, hot gas rises.

**Gas transport** is conservative (flux-form, donor-cell upwind with CFL substeps) for `air` and `vapor`, so mass
is conserved exactly. `T` is advected too, and gas-face velocities are advected semi-Lagrangian. When a cell
changes phase:

- **Gas → liquid:** its gas mass is pushed conservatively into neighboring gas cells. It's never deleted while
  any gas neighbor exists within a few cells; otherwise it's held as a pending bubble mass that re-emerges.
- **Liquid → gas:** the cell starts with zero gas, a near-vacuum. The compressible solve plus advection fill
  it from its neighbors. This is what holds a siphon together.

**Phase change is mass and energy transfer, not rules.**

- **Saturation pressure:** `psat(T) = P0 · exp(4895 · (1/373.15 − 1/(T + 273.15)))`, so water boils at 100 °C at
  P0, and later under higher pressure.
- **Evaporation and condensation** at liquid/gas interfaces and in gas cells: the rate ∝ `psat(T) − p_vapor`.
  Mass moves between liquid particles (whole particles via a per-cell fractional accumulator) and `vapor`.
  Latent heat goes in or out of `T`.
- **Boiling:** a liquid cell with `T ≥ T_sat(p_local)` converts liquid to vapor, **limited by available heat**
  (latent heat ≈ 540 °C-equivalents per unit mass). A converted cell becomes gas with high vapor density, and
  the projection expands it. Bubbles, bursts and pressure-cooker behavior emerge.
- **No steam particles:** steam is the `vapor` field. The renderer draws it as mist.

**What stays as is:** FLIP particles (integrate, separate, cohesion, P2G/G2P), the solid materials and their
melting, freezing and burning (`Thermo`), and mud (`Sediment`). Fire's heat goes into `T` as today.

## What gets deleted when the flag is on

Regions and `regionGauge`, bubble venting, the "tiny void = liquid" rule, `MAX_GAUGE`, `expansion` and flash
expansion, steam particles (`Thermo.steamCount` and related), `extraGas`, and the buoyancy assist (kept behind
an option, off by default).

## Feature flag

- **UI:** header toggle **Physics: Classic | Unified (beta)**. It's persisted in `localStorage` (wrapped in
  try/catch), and switching reloads the current level.
- **URL:** `?physics=unified` forces it on.
- `World` constructs either the classic `Fluid` or `UnifiedFluid`.
- The classic engine stays the default and must keep working unchanged.

## Code layout and ownership (parallel work)

| Area | Files (owner edits only these) | Delivers |
|---|---|---|
| **A. Pressure solver** | `src/sim2/solver.ts` | `project(...)` per `src/sim2/types.ts`: assemble + PCG solve, velocity update, pressure field out |
| **B. Gas transport** | `src/sim2/gas.ts` | conservative advection of air/vapor/T, semi-Lagrangian gas-velocity advection, phase-change remap, atmosphere boundary |
| **C. Phase change** | `src/sim2/phase.ts` | psat, evaporation/condensation/boiling with latent heat, liquid particles ↔ vapor mass |
| **D. Integration + UI** | `src/sim2/unified.ts`, and the small necessary edits to `src/sim/fluid.ts` (`private` → `protected`), `src/sim/thermo.ts` (skip steam/boil when unified), `src/world.ts`, `src/main.ts`, `src/render.ts`, `src/style.css` | `UnifiedFluid extends Fluid`; the flag; vapor and pressure rendering; stubs so the app runs before A–C land |
| **E. Validation** | `tests/**`, `package.json` scripts | `npm run test:physics` and `npm run test:puzzles`: canonical scenarios with pass/fail metrics against both engines, plus the puzzle harness moved into the repo |

The shared contract is `src/sim2/types.ts`. An agent that needs a change there notes it in its report rather
than editing it, so the others aren't broken.

## Unified step (owned by D, calling A–C)

1. `integrate` particles (gravity), `separate`, `cohere` (inherited).
2. Save gas-face velocities; P2G (`transfer(true)`); on faces with no particle weight, restore the advected gas
   velocity.
3. `updateDensity` → liquid density per cell; classify cells; **B** remaps gas for cells that changed phase.
4. Gravity on all faces (liquid faces already have it from particles).
5. **A** `project` (with the gas state's EOS pressure and atmosphere settings).
6. G2P (`transfer(false)`).
7. **B** advect gas mass/T and gas velocities with the projected velocity field.
8. **C** phase change.

## Validation scenarios (E)

Each scenario reports a metric with a pass threshold. All of them run against Unified; Classic runs where
meaningful, for comparison.

1. **Hydrostatic rest:** a tank of still water stays still (max speed < 5 px/s after settling).
2. **U-tube:** levels equalize within 1 cell.
3. **Siphon:** the high tank drains below 50% within 20 s (the classic engine currently fails this).
4. **Pythagorean cup:** fills, then drains to residue.
5. **Bubble rise:** a pocket of air released at the bottom of a water column reaches the surface.
6. **Syringe:** a sealed air pocket under a water column compresses in proportion (P·V within 10%).
7. **Hero's fountain:** water rises above its source level.
8. **Boiling pot:** water heated from below boils, vapor rises, and the pot's water decreases; vapor condenses
   on a cold ceiling.
9. **Sealed boiler:** pressure rises and pushes water up an outlet pipe.
10. **Oil floats:** oil starting under water ends up on top.
11. **Mass conservation:** total liquid + vapor + air mass is conserved within 1% in a closed box over 30 s.
12. **Puzzle harness:** every puzzle stays unsolved with no input, and is solved by its reference solution.

## Performance target

≤ 12 ms/frame at 6k particles in Node for the unified step. The PCG solve covers all ~14k cells.
If it's over budget, follow-ups are a red-black multigrid preconditioner, then a Web Worker or WebAssembly.
