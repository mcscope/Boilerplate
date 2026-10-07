# Boilerplate

A pixel-art physics puzzle game for the browser, about water, pressure, heat and phase changes.

Each puzzle gives you a faucet, a goal zone and a few materials. Build siphons, chutes, settling tanks and
steam-driven pumps to get the right liquid to the right place. Nothing is scripted: the solutions come out of
a real fluid and heat simulation.

## What's simulated

- **Water and oil:** FLIP particle liquid with real pressure, so siphons, U-tubes and the Pythagorean cup all
  work. Oil floats, and the liquids have surface tension.
- **Air and steam:** air is a compressible gas solved together with the liquid in a
  single pressure solve. Sealed pockets push back, and steam pressure can drive water uphill.
- **Heat:** conduction, boiling and condensation with latent heat, freezing and melting, and hot-air lift.
- **Fire:** oil, wax and wood burn above their flash points. Porous wood soaks up fuel, so a thin stick works as
  a wick. Grease fires flare when water hits burning oil.
- **Mud:** silt rides in fast water, settles where it's calm and builds up as mud. Mud erodes, seeps, slumps,
  and dams fail under water pressure.
- **Ice and wax:** phase changes with latent heat; wax melts, flows and sets again.

## Puzzles

Twelve puzzles in pairs: a simple version and a harder one (*b*, *c*). They cover pouring, connected
vessels, siphons, settling muddy water, skimming oil, fire and stills, and steam pumps. There's also a
**Playground** of open sandbox scenes: Pythagorean cup, siphon, steam boiler, grease fire, lava lamp,
candles, campfire, frozen pipe, washout, mud dams and more.

- **Building materials are unlimited.** How much you use is your score, and personal bests are saved in your
  browser.
- **Two difficulty modes:**
  - **Locked:** build while paused; once it's running, building is locked until Reset.
  - **Live:** edit while it runs.
- **Hints** are hidden until you ask for one.

## Controls

| | Desktop | Phone (landscape) |
|---|---|---|
| Draw with the tool | Left-drag | Drag with one finger |
| Opposite tool (Wall↔Erase, Water↔Sponge, Fire↔Chill) | Right-drag | Pick it from the dock |
| Play / pause | Space | ▶ in the dock |
| Reset | R | ⟲ in the dock |
| Step one frame | . | ☰ → Step |
| Tools | Letter keys (shown on the buttons) | Icons in the dock |
| Brush size | 1–4 | Dot button in the dock |
| Pressure / temperature view | P / T | ☰ menu |

On phones, the game runs in landscape. The dock sits on the right, and everything else (level info, hints,
views, the puzzle list) lives in the ☰ drawer.

## Running it

Requires Node 18+.

```sh
npm install
npm run dev        # dev server at http://localhost:5173
npm run build      # static site in dist/
```

The build is a static site with relative paths, so `dist/` works from any URL path on any static host.
`npm run package` also wraps it as a drop-in Flask blueprint; see [DEPLOY.md](DEPLOY.md).

### Tests

```sh
npm run test:physics   # physics scenarios: siphon, boiler, settling, ...
npm run test:puzzles   # every puzzle: reference solutions solve it, doing nothing doesn't
npm run typecheck:tests
```

`test:puzzles` accepts `--only=<name>`, `--seed=<n>`, `--jobs=<n>` and `--strict`.

## How it's built

TypeScript and Vite, no framework. The world is a 160×90 grid at 2 px per cell, drawn to a canvas and scaled up
crisply.

| Path | What's there |
|---|---|
| `src/sim/fluid.ts` | FLIP/PIC liquid particles on a staggered MAC grid: transfer, separation, cohesion, density |
| `src/sim/thermo.ts` | Temperature, materials (stone, ice, wax, mud, wood, heater), burning, melting |
| `src/sim/sediment.ts` | Silt transport, settling, erosion, seepage and slumping |
| `src/sim2/` | The engine: a single PCG pressure solve (MIC(0) preconditioned) for incompressible liquid and compressible gas, gas advection, and evaporation and condensation |
| `src/world.ts` | The world: wiring the simulations together, building tools, goals, playground levels |
| `src/puzzles.ts` | The puzzle campaign |
| `src/render.ts` | Pixel-art renderer and effects |
| `src/ui/pixel.ts` | Generated pixel-art UI frames and icons |
| `src/main.ts` | UI, input (mouse, touch, pen), levels, personal bests |
| `design/` | Design notes: puzzles, unified physics, rigid bodies, mobile release |

Air is simulated as a real compressible gas, solved in the same pressure solve as the liquid, so sealed pockets push back, vacuums pull, and steam builds pressure.

### Roadmap

- **Rigid bodies:** movable, rotating solids (floats, valves, lava-lamp blobs). See
  [design/rigid-bodies.md](design/rigid-bodies.md).
- **Mobile release:** undo, pinch-zoom, a magnifier, and more puzzles. See
  [design/mobile-release.md](design/mobile-release.md).
