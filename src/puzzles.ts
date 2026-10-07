import { OIL, WATER, WAX } from './sim/fluid';
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
    name: '2c. Hero\'s Fountain',
    desc: 'Get water into the marked area, higher than the faucet. No fire, no steam: just water, walls, and a sealed tank of water.',
    puzzle: {
      goal: { zone: { i0: 104, j0: 10, i1: 118, j1: 24 }, kind: WATER, amount: 150, label: '150 water up high' },
      tools: { wall: Infinity },
      hint: 'Falling water can squeeze trapped air, and squeezed air pushes on whatever water it touches.',
      noBuild: [{ i0: 17, j0: 28, i1: 26, j1: 36 }], // around the pipe
    },
    build: b => {
      // A sealed tank full of water, with a port in its roof (left) and a port low in its right side.
      b.solid(68, 42, 71, 62); b.solid(91, 42, 94, 56); b.solid(91, 59, 94, 62); b.solid(68, 61, 94, 62);
      b.solid(68, 42, 71, 43); b.solid(74, 42, 94, 43);
      b.water(72, 44, 90, 60);
      b.drain(1, 88, 158, 88);
      b.faucet(40, 70, 4, 60, true, WATER);
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
    desc: 'Oil and water pour from the right. Hold only oil in the marked area on the left.',
    puzzle: {
      goal: { zone: { i0: 20, j0: 56, i1: 34, j1: 85 }, kind: OIL, amount: 150, minPurity: 0.85, label: '150 oil, at least 85% pure' },
      tools: { wall: Infinity },
      hint: 'Oil floats on water. In a tank whose water can only leave from the bottom, the oil collects on top, and whatever spills over the rim is oil.',
      noBuild: [{ i0: 55, j0: 0, i1: 66, j1: 12 }], // around the pipes
    },
    build: b => {
      b.drain(1, 88, 158, 88);
      b.faucet(116, 6, 4, 50, true, WATER);
      b.faucet(124, 6, 4, 50, true, OIL);
    },
  },
  {
    name: '4a. Separator',
    desc: 'Oil and water pour together from one spout. Get the oil into the left area and the water into the right one.',
    puzzle: {
      goal: { zone: { i0: 14, j0: 62, i1: 32, j1: 85 }, kind: OIL, amount: 150, minPurity: 0.85, label: '150 oil on the left, 85% pure' },
      also: [{ zone: { i0: 126, j0: 62, i1: 144, j1: 85 }, kind: WATER, amount: 250, minPurity: 0.85, label: '250 water on the right, 85% pure' }],
      noBuild: [{ i0: 74, j0: 0, i1: 85, j1: 12 }], // around the pipes
      tools: { wall: Infinity },
      hint: 'Let the mixture settle in a tank first. Water is heavier, so it can be drawn off from the bottom while the oil leaves over the top.',
    },
    build: b => {
      b.drain(1, 88, 158, 88);
      b.faucet(154, 6, 4, 50, true, WATER);
      b.faucet(160, 6, 4, 50, true, OIL);
    },
  },
  {
    name: '4c. Oil Lamp',
    desc: 'An oil lamp: oil floats on water in a sealed tank, and a wick hangs in its neck, out of reach of the oil. Warm the kettle above it to 60°.',
    puzzle: {
      goal: { zone: { i0: 40, j0: 20, i1: 50, j1: 29 }, kind: WATER, amount: 150, minTemp: 60, label: 'Kettle water (150+) at 60°' },
      tools: { wall: Infinity, fire: 0.4 },
      hint: 'Water sinks under oil, so adding water lifts the oil. Watch where the oil can escape before it reaches the wick.',
      noBuild: [{ i0: 116, j0: 0, i1: 125, j1: 10 }], // around the pipe
    },
    build: b => {
      // Lamp tank: water below, a layer of oil on top. Roof openings: the neck (with the wick) and a fill hole.
      b.solid(28, 48, 29, 82); b.solid(61, 48, 62, 82); b.solid(28, 81, 62, 82);
      b.solid(28, 48, 43, 49); b.solid(47, 48, 56, 49); b.solid(60, 48, 62, 49);
      b.water(30, 66, 60, 80);
      b.oil(30, 56, 60, 65);
      // Neck, and a wood wick whose bottom sits well above the oil.
      b.solid(42, 38, 43, 49); b.solid(47, 38, 48, 49);
      b.wood(45, 34, 45, 42);
      // Kettle above the wick.
      b.solid(38, 18, 39, 31); b.solid(51, 18, 52, 31); b.solid(38, 30, 52, 31);
      b.water(40, 22, 50, 29);
      b.drain(1, 88, 158, 88);
      b.faucet(240, 6, 4, 80, true, WATER);
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
    name: '5c. Muddy Still',
    desc: 'Muddy water pours from the left. Get perfectly clean water into the marked area on the right.',
    puzzle: {
      goal: { zone: { i0: 122, j0: 66, i1: 142, j1: 85 }, kind: WATER, amount: 150, maxSilt: 0.02, label: '150 water, under 2% dirt' },
      tools: { wall: Infinity, wood: Infinity, fire: 0.4 },
      hint: 'Settling is too slow to get water this clean. When water boils away, it leaves its dirt behind.',
      noBuild: [{ i0: 17, j0: 0, i1: 26, j1: 10 }], // around the pipe
    },
    build: b => {
      b.drain(1, 88, 158, 88);
      b.faucet(40, 6, 4, 60, true, WATER, 0.9);
    },
  },
  {
    name: '5d. Fire Bomb',
    desc: 'Six bundles of wood sit on ledges around the room. Burn every last one, with a single spark.',
    puzzle: {
      goal: { zone: { i0: 1, j0: 1, i1: 158, j1: 87 }, kind: WATER, amount: 176, burn: true, label: 'Burn all the wood (176 cells)' },
      tools: { wall: Infinity, oil: Infinity, water: Infinity, ice: Infinity, wax: Infinity, fire: 0.4 },
      noBuild: [{ i0: 1, j0: 1, i1: 32, j1: 87 }, { i0: 126, j0: 1, i1: 158, j1: 87 }], // both sides, around the bundles
      hint: 'Burning oil spreads fire wherever it flows. And water hitting burning oil flashes to steam and throws the flaming oil around.',
    },
    build: b => {
      // Bundles on little stone ledges: three on the left, three on the right.
      b.solid(8, 30, 16, 30); b.wood(9, 26, 15, 29);
      b.solid(20, 55, 28, 55); b.wood(21, 51, 27, 54);
      b.solid(6, 78, 14, 78); b.wood(7, 74, 13, 77);
      b.solid(140, 22, 150, 22); b.wood(141, 18, 149, 21);
      b.solid(128, 48, 136, 48); b.wood(129, 44, 135, 47);
      b.solid(144, 72, 152, 72); b.wood(145, 68, 151, 71);
      b.drain(1, 88, 158, 88);
    },
  },
  {
    name: '6. Steam Pump',
    desc: 'A sealed boiler with one hole in its side, and a cup far above it. Get the boiler\'s water into the cup.',
    puzzle: {
      goal: { zone: { i0: 120, j0: 12, i1: 141, j1: 28 }, kind: WATER, amount: 120, label: 'Lift 120 water into the high cup' },
      tools: { wall: Infinity, fire: 0.4 },
      hint: 'Steam pressure pushes on whatever it can reach. If the pipe starts above the water, steam just escapes up it; feed the pipe from below the waterline.',
    },
    build: b => {
      // Sealed boiler, half full, with a hole high in its right wall.
      b.solid(50, 40, 90, 41); b.solid(50, 61, 90, 62); b.solid(50, 40, 51, 62); b.solid(89, 40, 90, 62);
      b.open(89, 42, 90, 44);
      b.water(52, 48, 88, 60);
      // Firebox: logs soaked in an oil pool.
      b.solid(50, 64, 51, 72); b.solid(89, 64, 90, 72); b.solid(50, 71, 90, 72);
      b.soakedWood(54, 67, 86, 68, 2);
      b.oil(52, 69, 88, 70);
      // The high cup.
      b.solid(118, 12, 119, 30); b.solid(142, 12, 143, 30); b.solid(118, 29, 143, 30);
      b.drain(1, 88, 158, 88);
    },
  },
  {
    name: '6a. Water Bridge',
    desc: 'The same tanks, but nothing connects the boiler to the oil.',
    puzzle: {
      goal: { zone: { i0: 120, j0: 32, i1: 139, j1: 40 }, kind: OIL, amount: 120, minPurity: 0.85, label: '120 oil in the cup, at least 85% pure' },
      tools: { wall: Infinity, fire: 0.4 },
      hint: 'Build a sealed pipe from the boiler to the bottom of the oil tank. Start it below the boiler\'s waterline, or the steam will just escape through it.',
    },
    build: b => { oilPress(b, { waterPipe: false, crack: false, riser: true }); b.drain(1, 88, 158, 88); },
  },
  {
    name: '7. Casting',
    desc: 'Hot molten wax pours from the left. Cast the statue: fill the marked shape with solid wax.',
    puzzle: {
      goal: {
        zone: { i0: 62, j0: 52, i1: 97, j1: 85 }, kind: WAX, amount: 677, maxExtra: 60,
        label: 'Fill the statue with solid wax (677 of 752 cells)',
        // A small seated Buddha: top knot, head, shoulders, arms beside the body, hands in the lap, crossed legs.
        shape: [
        '..............########..............',
        '..............########..............',
        '............############............',
        '............############............',
        '..........################..........',
        '..........################..........',
        '..........################..........',
        '..........################..........',
        '..........################..........',
        '..........################..........',
        '............############............',
        '............############............',
        '..............########..............',
        '..............########..............',
        '......########################......',
        '......########################......',
        '....############################....',
        '....############################....',
        '..######....############....######..',
        '..######....############....######..',
        '..######....############....######..',
        '..######....############....######..',
        '..######....############....######..',
        '..######....############....######..',
        '....############################....',
        '....############################....',
        '..################################..',
        '..################################..',
        '####################################',
        '####################################',
        '####################################',
        '####################################',
        '..################################..',
        '..################################..',
        ],
      },
      tools: { wall: Infinity, wood: Infinity, fire: 0.4 },
      hint: 'Wax sets as it cools. Build a mold around the shape with a channel into the top, and leave the air a way out as the wax fills it.',
      noBuild: [{ i0: 12, j0: 0, i1: 21, j1: 10 }], // around the pipe
    },
    build: b => {
      b.solid(52, 86, 108, 87); // plinth under the statue
      b.drain(1, 88, 158, 88);
      b.faucet(30, 6, 4, 40, true, WAX, 0, 290);
    },
  },
  {
    name: '7a. Pawn',
    desc: 'A block of wax sits on a shelf. Melt it and cast a chess pawn: fill the marked shape with solid wax.',
    puzzle: {
      goal: {
        zone: { i0: 74, j0: 71, i1: 85, j1: 85 }, kind: WAX, amount: 95, maxExtra: 15,
        label: 'Fill the pawn with solid wax (95 of 106 cells)',
        // A chess pawn.
        shape: [
        '....####....',
        '...######...',
        '..########..',
        '..########..',
        '...######...',
        '....####....',
        '..########..',
        '....####....',
        '....####....',
        '...######...',
        '...######...',
        '..########..',
        '.##########.',
        '############',
        '############',
        ],
      },
      tools: { wall: Infinity, wood: Infinity, fire: 0.4 },
      hint: 'Wax melts above 60° and burns above 300°. A wood fire next to the block melts it without setting it alight, if you keep the flames off the wax.',
    },
    build: b => {
      b.solid(16, 56, 44, 57); // shelf
      b.wax(20, 40, 40, 55);   // the wax block
      b.solid(64, 86, 98, 87); // plinth under the statue
      b.drain(1, 88, 158, 88);
    },
  },
  {
    name: '8. Meltwater',
    desc: 'A block of ice sits on a shelf, and hot water pours from the left. Fill the marked area with cold water.',
    puzzle: {
      goal: { zone: { i0: 120, j0: 66, i1: 140, j1: 85 }, kind: WATER, amount: 300, maxTemp: 25, label: '300 water at 25° or colder' },
      tools: { wall: Infinity },
      hint: 'Melting ice soaks up a lot of heat. Water that has run over enough ice comes off cold.',
      noBuild: [{ i0: 12, j0: 0, i1: 21, j1: 10 }], // around the pipe
    },
    build: b => {
      b.solid(56, 71, 96, 72); // shelf
      b.ice(60, 46, 92, 70);
      b.drain(1, 88, 158, 88);
      b.faucet(30, 6, 4, 50, true, WATER, 0, 90);
    },
  },
];
