import { OIL, WATER } from './sim/fluid';
import { Builder, Level } from './world';

/**
 * The puzzle campaign. Each puzzle has locked terrain, a goal beaker, and a small budget of tools
 * (cells of material, seconds of fire). Puzzles start paused: build, then press Play.
 */

/**
 * Shared layout for the Oil Press puzzles: a sealed boiler over a firebox, a sealed oil tank, and a cup.
 * Steam pressure pushes the boiler's water through a pipe into the bottom of the oil tank, which lifts the oil
 * up a riser from the top of the tank and into the cup. Steam can't get to the oil, and condensing can't move it.
 */
function oilPress(b: Builder, opts: { waterPipe: boolean; crack: boolean; riser: boolean }) {
  // Boiler
  b.solid(20, 40, 50, 41); b.solid(20, 63, 50, 64); b.solid(20, 40, 21, 64); b.solid(49, 40, 50, 64);
  b.water(22, 48, 48, 62);
  if (opts.crack) b.open(30, 40, 32, 41);
  // Firebox: a stack of logs, with a little oil soaked into the bottom one to help it catch.
  b.solid(20, 66, 21, 76); b.solid(49, 66, 50, 76); b.solid(20, 75, 50, 76);
  b.wood(24, 68, 46, 69); b.wood(26, 71, 44, 72);
  b.soakedWood(24, 73, 46, 74, 1);
  // Sealed oil tank, full of oil.
  b.solid(84, 44, 112, 45); b.solid(84, 63, 112, 64); b.solid(84, 44, 85, 64); b.solid(111, 44, 112, 64);
  b.oil(86, 46, 110, 62);
  // The cup; its left rim sits just below the crossover pipe, so oil spills over it.
  b.solid(118, 32, 119, 42); b.solid(140, 26, 141, 42); b.solid(118, 41, 141, 42);
  b.open(84, 58, 85, 60); // inlet low on the oil tank's left
  b.open(106, 44, 108, 45); // outlet in the oil tank's lid
  if (opts.waterPipe) {
    // From near the bottom of the boiler, out through its wall, along, and in at the bottom of the oil tank.
    b.open(49, 58, 50, 60);
    b.solid(51, 57, 83, 57); b.solid(51, 61, 83, 61);
  } else b.open(49, 43, 50, 45); // the boiler's only opening is high in its side, above the water
  if (opts.riser) {
    // From the top of the oil tank, up, and over into the cup.
    b.solid(105, 28, 105, 43); b.solid(109, 30, 109, 43);
    b.solid(105, 27, 121, 27); b.solid(110, 31, 117, 31);
  } else b.open(111, 58, 112, 60); // a second outlet, low on the oil tank's right
}

export const PUZZLES: Level[] = [
  {
    name: '1. First Pour',
    desc: 'The faucet pours straight down the drain. Build a chute to catch the water and carry it into the beaker.',
    puzzle: {
      goal: { zone: { i0: 112, j0: 56, i1: 128, j1: 84 }, kind: WATER, amount: 400, label: 'Fill the beaker with 400 water' },
      tools: { wall: Infinity },
      hint: 'Water runs downhill along any surface. A long, gentle slope works.',
    },
    build: b => {
      b.solid(110, 56, 111, 86); b.solid(129, 56, 130, 86); b.solid(110, 85, 130, 86);
      b.drain(1, 88, 158, 88);
      b.faucet(36, 6, 6, 140, true, WATER);
    },
  },
  {
    name: '1b. Long Shot',
    desc: 'Same idea, but you can\'t build anywhere on the right half.',
    puzzle: {
      goal: { zone: { i0: 100, j0: 56, i1: 125, j1: 84 }, kind: WATER, amount: 400, label: 'Fill the beaker with 400 water' },
      tools: { wall: Infinity },
      hint: 'A long steep drop builds speed. A ski-jump lip at the end throws the water up and across.',
      noBuild: [{ i0: 80, j0: 1, i1: 158, j1: 88 }],
    },
    build: b => {
      b.solid(98, 56, 99, 86); b.solid(126, 56, 127, 86); b.solid(98, 85, 127, 86);
      b.drain(1, 88, 158, 88);
      b.faucet(36, 6, 6, 140, true, WATER);
    },
  },
  {
    name: '2. Same Level',
    desc: 'A full tank drains through a pipe along the floor, but the beaker is up high.',
    puzzle: {
      goal: { zone: { i0: 112, j0: 40, i1: 133, j1: 84 }, kind: WATER, amount: 300, label: 'Fill the high beaker with 300 water' },
      tools: { wall: Infinity },
      hint: 'Water in connected vessels rises to the same level. Build a sealed upright pipe at the end of the floor pipe; its top must be lower than the water in the tank.',
    },
    build: b => {
      // Tall tank, its outlet low on the right into a pipe along the floor.
      b.solid(8, 6, 10, 72); b.solid(39, 6, 41, 60); b.solid(8, 70, 41, 72);
      b.solid(41, 61, 100, 63); // pipe ceiling
      b.solid(41, 70, 108, 72); // pipe floor (runs a little past the pipe's open end)
      b.water(11, 12, 38, 69);
      // High beaker
      b.solid(110, 40, 111, 86); b.solid(134, 40, 135, 86); b.solid(110, 85, 135, 86);
      b.drain(1, 88, 158, 88);
    },
  },
  {
    name: '2b. Over the Top',
    desc: 'Same tank, but now the beaker needs far more water.',
    puzzle: {
      goal: { zone: { i0: 112, j0: 40, i1: 133, j1: 84 }, kind: WATER, amount: 1200, label: 'Fill the high beaker with 1200 water' },
      tools: { wall: Infinity },
      hint: 'Only so much water will ever rise above the rim. A siphon (a sealed pipe over the rim and down into the beaker) keeps pulling water once it is full, even after the tank drops below the rim.',
    },
    build: b => {
      b.solid(8, 6, 10, 72); b.solid(39, 6, 41, 60); b.solid(8, 70, 41, 72);
      b.solid(41, 61, 100, 63);
      b.solid(41, 70, 108, 72);
      b.water(11, 12, 38, 69);
      b.solid(110, 40, 111, 86); b.solid(134, 40, 135, 86); b.solid(110, 85, 135, 86);
      b.drain(1, 88, 158, 88);
    },
  },
  {
    name: '3. Clear Water',
    desc: 'Muddy water pours onto a short stone shelf. Hold a pool of clear water in the marked area at its right end.',
    puzzle: {
      goal: { zone: { i0: 86, j0: 60, i1: 105, j1: 77 }, kind: WATER, amount: 300, maxSilt: 0.1, label: '300 water, under 10% dirt (none settled in the area)' },
      tools: { wall: Infinity },
      hint: 'Silt only drops out of calm water. Wall the shelf into a pond: let the water sit a while upstream, and only the clear top layer spill on into your pool.',
    },
    build: b => {
      b.solid(40, 78, 106, 80); // a short shelf; the goal area sits on its right end
      b.drain(1, 88, 158, 88);
      b.faucet(96, 6, 4, 110, true, WATER, 0.9);
    },
  },
  {
    name: '3b. Muddy Waters',
    desc: 'Muddy water pours straight down onto the marked area. Hold clear water there.',
    puzzle: {
      goal: { zone: { i0: 72, j0: 70, i1: 89, j1: 86 }, kind: WATER, amount: 300, maxSilt: 0.1, label: '300 water, under 10% dirt (none settled in the area)' },
      tools: { wall: Infinity },
      hint: 'Catch the stream before it reaches the beaker and lead it into a tank of your own. Let the silt settle there, and let only the clear top spill over into the beaker.',
    },
    build: b => {
      // No beaker: the marked area is where your own container has to hold the clear water.
      b.drain(1, 88, 158, 88);
      b.faucet(158, 6, 2, 80, true, WATER, 0.9);
    },
  },
  {
    name: '3c. Mud Pit',
    desc: 'Muddy water pours from the faucet. Fill the tall marked shaft with solid mud.',
    puzzle: {
      // The shaft is 6 cells wide and 36 tall (216 cells); 90% of it has to be mud.
      goal: { zone: { i0: 112, j0: 50, i1: 117, j1: 85 }, kind: WATER, amount: 195, mud: true, label: 'Fill the shaft with mud (195 of 216 cells)' },
      tools: { wall: Infinity },
      hint: 'Mud only builds up where silty water sits still. Water plunging straight in keeps the silt stirred up; let it calm down in the shaft and let the cleared water spill away.',
    },
    build: b => {
      b.solid(100, 86, 130, 87); // ground under the shaft
      b.drain(1, 88, 158, 88);
      b.faucet(40, 6, 4, 110, true, WATER, 0.9);
    },
  },
  {
    name: '4. Skimmer',
    desc: 'Oil and water pour into a tank. Hold only oil in the marked area on the left.',
    puzzle: {
      goal: { zone: { i0: 20, j0: 56, i1: 34, j1: 85 }, kind: OIL, amount: 150, minPurity: 0.85, label: '150 oil, at least 85% pure' },
      tools: { wall: Infinity },
      hint: 'Oil floats. If the water had to climb before it could leave, the tank would fill, and the oil on top would spill over the left lip.',
    },
    build: b => {
      // Separator tank: low left wall with a lip (oil spills here), tall right wall with an outlet at the bottom.
      b.solid(40, 46, 41, 80); b.solid(30, 46, 41, 46);
      b.solid(79, 30, 80, 71); b.solid(40, 79, 120, 80);
      // No oil beaker: the marked area under the lip is where your container has to hold the oil.
      // Outlet channel to a drain.
      b.drain(100, 78, 119, 78);
      b.drain(1, 88, 158, 88);
      b.faucet(116, 6, 4, 100, true, WATER);
      b.faucet(124, 6, 4, 100, true, OIL);
    },
  },
  {
    name: '5. Kindling',
    desc: 'Warm the pot of water to 70°.',
    puzzle: {
      goal: { zone: { i0: 61, j0: 46, i1: 99, j1: 62 }, kind: WATER, amount: 500, minTemp: 70, label: 'Pot of water (500+) at 70°' },
      tools: { wood: Infinity, fire: 0.4 },
      hint: 'Your torch has only a moment of fuel; wood burns much longer. Stack it under the pot, leaving gaps for air, then light it.',
    },
    build: b => {
      b.solid(40, 82, 120, 84); // hearth
      // Pot on stone legs
      b.solid(58, 46, 60, 64); b.solid(100, 46, 102, 64); b.solid(58, 63, 102, 64);
      b.solid(58, 65, 59, 81); b.solid(101, 65, 102, 81);
      b.water(61, 50, 99, 62);
    },
  },
  {
    name: '5b. Still',
    desc: 'The same pot of water, but the water has to end up in the other beaker.',
    puzzle: {
      goal: { zone: { i0: 122, j0: 62, i1: 138, j1: 84 }, kind: WATER, amount: 200, label: 'Collect 200 water in the right beaker' },
      tools: { fire: 0.4, wall: Infinity },
      hint: 'Light the logs and boil it. Steam rises and slides up along the underside of a sloped roof, and turns back into water once it gets far enough from the heat to cool.',
    },
    build: b => {
      b.solid(26, 82, 94, 84); // hearth
      // Pot on stone legs
      b.solid(36, 46, 38, 64); b.solid(80, 46, 82, 64); b.solid(36, 63, 82, 64);
      b.solid(36, 65, 37, 81); b.solid(81, 65, 82, 81);
      b.water(39, 50, 79, 62);
      // Logs already stacked under the pot
      b.wood(40, 79, 78, 81); b.wood(48, 74, 70, 75);
      // The other beaker
      b.solid(120, 60, 121, 86); b.solid(139, 60, 140, 86); b.solid(120, 85, 140, 86);
      b.drain(1, 88, 158, 88);
    },
  },
  {
    name: '6. Oil Press',
    desc: 'Get oil from the sealed tank up into the cup. There is a boiler next door.',
    puzzle: {
      goal: { zone: { i0: 120, j0: 32, i1: 139, j1: 40 }, kind: OIL, amount: 120, minPurity: 0.85, label: '120 oil in the cup, at least 85% pure' },
      tools: { wall: Infinity, fire: 0.4 },
      hint: 'Oil won\'t boil, so it has to be pushed. Steam pressure can push the boiler\'s water into the oil tank, and the water lifts the oil, but only if the steam can\'t escape.',
    },
    build: b => { oilPress(b, { waterPipe: true, crack: true, riser: true }); b.drain(1, 88, 158, 88); },
  },
  {
    name: '6b. Water Bridge',
    desc: 'The same tanks, but nothing connects the boiler to the oil.',
    puzzle: {
      goal: { zone: { i0: 120, j0: 32, i1: 139, j1: 40 }, kind: OIL, amount: 120, minPurity: 0.85, label: '120 oil in the cup, at least 85% pure' },
      tools: { wall: Infinity, fire: 0.4 },
      hint: 'Build a sealed pipe from the boiler to the bottom of the oil tank. Start it below the boiler\'s waterline, or the steam will just escape through it.',
    },
    build: b => { oilPress(b, { waterPipe: false, crack: false, riser: true }); b.drain(1, 88, 158, 88); },
  },
  {
    name: '6c. Skim the Top',
    desc: 'The tanks are connected, but there is no way out of the oil tank.',
    puzzle: {
      goal: { zone: { i0: 120, j0: 32, i1: 139, j1: 40 }, kind: OIL, amount: 120, minPurity: 0.85, label: '120 oil in the cup, at least 85% pure' },
      tools: { wall: Infinity, fire: 0.4 },
      hint: 'Water comes in at the bottom of the oil tank and pushes the oil up. Draw your pipe from the top of the tank, or you will get water instead of oil.',
    },
    build: b => { oilPress(b, { waterPipe: true, crack: false, riser: false }); b.drain(1, 88, 158, 88); },
  },
];
