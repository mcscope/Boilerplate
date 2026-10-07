# Boilerplate: Puzzle Campaign Design

## How a puzzle works

- **Fixed world.** Each puzzle has locked terrain (level stone and other level-made solids can't be erased), a source (faucet, tank, block of material) and a **goal**. Some areas are no-build zones.
- **Unlimited materials.** Walls and any other granted building materials are unlimited. How many you use is the score, not a constraint, because scarce materials were frustrating. Puzzles are constrained by space and physics instead. The one rationed resource is **fire**: 2 seconds per puzzle, enough to light things but not to cook them with the torch.
- **Goals** are drawn in the world, and each must hold for 2 seconds:
  - an amount of a liquid in a zone, optionally with purity, dirt and temperature limits
  - a zone filled with settled mud
  - a shape cast in solid wax
  - all the wood burned
  - several goals at once
- **Two modes.**
  - **Locked:** build while paused; once it runs, building is locked until Reset.
  - **Live:** edit while it runs.
- **Rules for every puzzle:**
  - It must not solve itself if the player does nothing.
  - The description states the situation and the goal only; how the physics works goes in the hidden hint.
  - Hints never contain a specific player's solution.
- **No Chill.** The game doesn't have a cooling tool. Cold comes from physics: ice, melting, ambient air.

---

## How the chapters are organized

**Each number is one physical principle.** The plain-numbered puzzle is the cleanest demonstration of that principle. Lettered puzzles (*a*, *b*, *c*) are harder versions of it, or combine it with a principle from an earlier chapter. So a player who has solved chapter *n* understands one more piece of physics, and later chapters can assume it.

The order goes from things you can see directly toward hidden quantities:
1. **Motion:** where water goes when it falls and flows.
2. **Pressure:** what water and air push on.
3. **Suspension:** what water carries.
4. **Density:** what floats on what.
5. **Heat:** what temperature changes.
6. **Combustion:** what burns.
7. **Steam pressure:** what heat can push.
8. **Solidification:** what liquids become when they cool.
9. **Mixtures (advanced):** pulling apart liquids that mix.

## The chapters

### 1. Momentum: water moves
Water falls, flows down slopes and carries speed. Walls shape where it goes.
- **1. First Pour:** build a chute from the faucet to the beaker.
- **1b. Long Shot:** you can't build near the target, so the water has to leave a ramp fast enough to fly across.

### 2. Pressure: water and air push
Liquid finds its level (connected vessels, siphons), and air is a real gas that compresses and pushes back.
- **2. Same Level:** connected vessels: water rises on the far side of a U-tube.
- **2b. Over the Top:** a siphon carries water over a rim higher than the beaker.
- **2c. Overpressure:** the beaker is out of reach; seal a tall column of water into a chamber so its pressure pushes water up and over.

### 3. Suspension: water carries mud
Fast water carries silt; calm water drops it, and it builds up as mud.
- **3. Clear Water:** settle muddy water until it's clean enough.
- **3b. Muddy Waters:** the same, with harder space and flow.
- **3c. Mud Pit:** the reverse: collect the silt to fill a shaft with solid mud.

### 4. Density: oil floats
Liquids layer by density, so a tank can sort them, and whatever floats on top can be lifted.
- **4. Skimmer:** collect only oil from a mixed stream.
- **4a. Separator:** send oil one way and water the other.
- **4c. Oil Lamp:** pour water in under oil to lift the oil to a wick, then burn it to heat a kettle. Combines density with heat (ch. 5).

### 5. Heat: boiling and condensing
Fire heats, water boils, and steam condenses on cool surfaces.
- **5. Kindling:** a wood fire under a pot.
- **5b. Still:** boil, then catch the condensed steam in another beaker.
- **5c. Muddy Still:** distillation leaves the dirt behind. Combines heat with suspension (ch. 3).

### 6. Combustion: fire spreads
Fire travels along fuel and through the air. One spark has to reach everything.
- **6. Fire Bomb:** burn six scattered wood bundles with a single ignition. Burning oil, and the steam blast of water hitting burning oil, can carry the fire.

### 7. Steam pressure: heat pushes
Steam in a sealed space builds pressure and does work.
- **7. Steam Pump:** steam pressure pushes water up and out of a sealed boiler.
- **7a. Water Bridge:** steam pushes water, and that water pushes oil up a riser. Combines pressure with density (ch. 2 and 4).

### 8. Solidification: liquids set into shapes
Molten wax flows while hot and sets where it cools, so molds shape it.
- **8. Casting:** hot molten wax pours in; build a mold and cast a small statue.
- **8a. Pawn:** melt a wax block with a wood fire, without setting it alight, and cast a pawn.

### 9. Mixtures (advanced)
Liquids that mix can still be pulled apart by how readily each one boils. Builds on heat (ch. 5).
- **9. Column Still:** concentrate alcohol out of a mash. A pot still only gets partway; a tall column where vapor partly condenses and drips back makes it stronger with each stage. Alcohol vapor is flammable.

---

## Backlog, by chapter

Ideas not built yet, filed where they would teach.

- **Ch. 2, Pressure**
  - **The Greedy Cup:** build a Pythagorean cup that holds water back, then delivers it all at once.
  - **Air Lock:** fill a sealed bottle; the trapped air needs a vent.
  - **Diving Bell:** keep a zone dry underwater with trapped air. Needs a "keep dry" goal.
- **Ch. 3, Suspension**
  - **Dig a Channel:** a fast, narrow jet erodes a mud bank.
  - **Self-Building Dam:** silt seals a gap until the water rises to an outlet.
  - **Flash Flood:** in Locked mode, a mud dam that fails under pressure releases a surge.
  - **Levee:** keep a zone dry with mud alone.
- **Ch. 6, Combustion**
  - **Long Fuse:** one spark in a corner, a target across the map.
  - **Smother:** stop a creeping oil fire without water.
- **Ch. 7, Steam pressure**
  - **Relief Valve:** a wax plug melts at the right moment and acts as a safety valve.
  - **Geyser:** a heated U-trap that pulses on its own.
  - **Steam Siphon:** steam fills a hose, condenses, and the vacuum starts the siphon.
- **Ch. 8, Solidification**
  - **Wax Seal:** melt wax above a crack so it runs in and seals it.
  - **Hourglass:** a wax plug as a timer.
  - **Floating Lid:** molten wax sets into an insulating lid on hot water.
- **Latent heat (no chapter yet)**
  - **Thaw:** melt an ice plug with heat routed from far away.
- **Dropped:** anything needing Chill (Freeze the Leak, Ice Sculpture, Cold Snap); Meltwater (cut 2026-10-07 after playtest).

### Ch. 10 and later: machines (once rigid bodies exist)
Moving solids open a new layer: float valves, bucket seesaws, piston engines, water wheels, wax thermostats, and the lava lamp. See [rigid-bodies.md](rigid-bodies.md).
