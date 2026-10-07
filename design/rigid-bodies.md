# Rigid Bodies: solids that move (Unified engine)

## Goal

Ice, wax, wood (and later machine parts) can exist as **loose objects**: rigid pixel shapes that translate,
rotate, collide, rest and stack, and are pushed by the fluid. Floating and sinking come from real buoyancy (the
pressure of the surrounding liquid and gas), not a rule. Melting, freezing and burning edit these objects
cell by cell.

What this makes possible:

- **Lava lamp:** set wax becomes a blob that sinks to the heater, melts, and rises again as liquid.
- **Floating ice:** ice floats about 90% submerged in water.
- **Wood:** logs float and roll.
- **Later:** floats on levers, pistons, buckets that tip, water wheels.

## Representation

```
Body {
  id
  cells: local grid (w × h) of material codes (NONE / ICE / WAX_SOLID / WOOD / STONE…) + per-cell state
         (temperature, melt progress, fuel, soak, wet), cell size = grid cell size h
  com (x, y) px, angle θ, velocity (vx, vy), angular velocity ω
  mass, inertia (from cells × material density), local COM offset
  sleeping, contact cache
}
```

- **Material densities** (water = 1): ice 0.9, wood 0.6, wax 0.9 when solid (denser than lamp oil when cool),
  stone 2.5.
- **Mass and inertia** are recomputed whenever cells are added or removed. A body that becomes disconnected
  splits into connected components.
- **Static terrain** keeps working exactly as now (`Thermo.mat` + `Fluid.s`). A body is a separate object,
  *rasterized* into the grid every substep.

## Per substep (inside UnifiedFluid.step)

1. **Rasterize bodies.** For each grid cell in a body's bounding box, inverse-transform the cell center into
   body-local coordinates; if it hits a body cell, mark the grid cell solid and record `bodyId` and material.
   Particles inside newly covered cells are pushed out (existing `pushOut`).
2. **Moving boundary.** For each face between a body cell and a non-solid cell, set the face velocity to the
   body's velocity at that point (`v + ω × r`, normal component). The solver already leaves solid-adjacent faces
   unchanged and uses them in the divergence, so the body pushes the fluid.
3. **Projection** (unchanged).
4. **Fluid → body.** Sum the pressure force over every exposed body face, `F = p · h · n`, plus the torque
   `r × F`. Add gravity. Buoyancy emerges from the pressure gradient. A light drag term (FLIP has no viscosity)
   damps sloshing.
5. **Integrate** the body's velocity and angle (semi-implicit Euler, substepped). Light bodies in heavy liquid
   are the classic instability of explicit coupling ("added mass"), so start explicit, with damping and a
   velocity clamp. If it isn't stable enough, move to a monolithic or variational solid–fluid coupling (Batty,
   Bertails and Bridson 2007), where body velocity unknowns are added to the pressure solve.
6. **Collisions** against terrain and other bodies:
   - pixel-mask overlap after integration;
   - the contact normal comes from the gradient of the overlapping cells;
   - impulse with restitution (≈ 0.1) and Coulomb friction (μ ≈ 0.5), plus positional correction;
   - bodies at rest go to sleep and wake when touched or when the fluid pushes hard.
7. **Thermal and phase changes:**
   - body cell temperatures are written into `Thermo.T` for the cells the body covers, and read back after the
     thermal step, so conduction, fire and heaters act on bodies naturally;
   - a body cell that melts is removed (spawning liquid particles at its world position), and burnt wood is
     removed;
   - liquid that freezes **next to a body** joins it; next to static terrain, it becomes static (ice on a wall
     stays put); in open liquid, it becomes a **new body**;
   - mass, inertia and connectivity are recomputed after edits.

## Player tools

Placing materials stays **anchored** (static) by default, so building works as it does now. A **Loose** toggle
places the same material as a free body instead. Puzzles can grant either. Erase removes both (in puzzles, only
your own).

## Rendering

Bodies are drawn every frame by sampling their pixel art with the inverse transform: nearest-neighbor, so
rotation stays crisp. They're kept out of the cached static layer.

## Workstreams (parallel, disjoint files)

| | Files | Delivers |
|---|---|---|
| **R1 Body core** | `src/sim2/bodies/body.ts`, `bodies/world.ts` | data structure, mass/inertia/COM, integration, rasterization (bodyId, mat, s), moving-boundary face velocities, splitting, add/remove cell API |
| **R2 Collisions** | `src/sim2/bodies/collide.ts` | body–terrain and body–body contacts, impulses, friction, positional correction, sleeping |
| **R3 Fluid coupling** | `src/sim2/bodies/couple.ts` | pressure force/torque from the projection, drag, stability (substeps / added-mass handling); validation: floating depths, rising/sinking speeds |
| **R4 Phase and heat** | `src/sim2/bodies/phase.ts` + small hooks in `src/sim/thermo.ts` | temperature sync, melting/burning removing cells, freezing joining bodies or creating new ones |
| **R5 Integration, UI, levels** | `src/sim2/unified.ts`, `src/world.ts`, `src/main.ts`, `src/render.ts`, `src/puzzles.ts`, `tests/physics.ts` | wiring the step, Loose toggle, rotated pixel rendering, levels (Lava Lamp revisited, Ice Floes, Log Raft), new test scenarios |

Shared contract: `src/sim2/bodies/types.ts`, written before the agents start.

## Validation scenarios (added to tests/physics.ts)

1. **Wood floats** at about 60% submerged; **ice** at about 90%; **stone sinks**.
2. **A cube released underwater** rises and settles without exploding (stable coupling).
3. **A tilted log** rights itself to its stable floating orientation.
4. **Stacking:** three blocks rest on each other without jitter, then sleep.
5. **A sliding block** on a ramp stops with friction.
6. **Ice melting** in warm water shrinks its body; water that freezes in open space makes a floating body.
7. **Lava lamp:** wax cycles between sinking solid blobs and rising liquid for 2+ minutes.
8. **Momentum:** a body dropped into a tank makes a splash and settles.

## Performance

Up to about 20 bodies with about 400 cells each. Rasterization and collisions are bounding-box limited, so this
should cost under 1 ms per step.
