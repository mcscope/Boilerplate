import { Fluid, OIL, WATER, WAX } from './sim/fluid';
import { CELL_OF_MUD, Sediment } from './sim/sediment';
import { AMBIENT, ICE, MUD, NONE, STEAM_VAPOR, STONE, Thermo, WAX_SOLID, WOOD, WOOD_FUEL } from './sim/thermo';
import { UnifiedFluid } from './sim2/unified';

/** Screen is W×H pixels; the simulation grid uses CELL×CELL pixel cells. */
export const W = 320;
export const H = 180;
export const CELL = 2;
export const NX = W / CELL;
export const NY = H / CELL;
const MAX_PARTICLES = 40000;

/** Which physics engine a World runs: the classic FLIP + gas-region model, or the unified air/liquid solver. */
export type Physics = 'classic' | 'unified';

export interface Emitter {
  x: number; // px, left edge of the nozzle
  y: number;
  w: number;
  speed: number; // px/s, downward
  on: boolean;
  kind: number; // WATER or OIL
  silt: number; // 0..1 suspended silt (muddy water)
  acc: number;
}

export interface Rect { i0: number; j0: number; i1: number; j1: number }

export interface Level {
  name: string;
  desc: string;
  build: (b: Builder) => void;
  puzzle?: Puzzle;
}

/** A goal beaker: a zone that must hold enough of one liquid, optionally pure and clear, for a moment. */
export interface Goal {
  zone: Rect;
  kind: number; // WATER or OIL
  amount: number; // particles
  minPurity?: number; // fraction of the liquid in the zone that must be `kind`
  maxSilt?: number; // dirt allowed: suspended silt plus anything settled in the zone, per unit of liquid
  minTemp?: number; // average temperature required, °C
  label: string;
}

export interface Puzzle {
  goal: Goal;
  /** Tools the player may use, with budgets: cells for materials, seconds for Fire / Chill. */
  tools: Record<string, number>;
  hint: string;
  /** Areas where the player may not build. */
  noBuild?: Rect[];
}

export interface GoalStatus {
  amount: number;
  purity: number;
  silt: number;
  temp: number;
  met: boolean;
  held: number; // seconds the goal has been met continuously
  solved: boolean;
}

const HOLD_TO_WIN = 2;

/** Level-authoring helpers, all in cell coordinates (inclusive rects). */
export class Builder {
  constructor(private world: World) {}
  solid(i0: number, j0: number, i1: number, j1: number) { this.fill(i0, j0, i1, j1, STONE); }
  open(i0: number, j0: number, i1: number, j1: number) { this.fill(i0, j0, i1, j1, NONE); }
  ice(i0: number, j0: number, i1: number, j1: number) { this.fill(i0, j0, i1, j1, ICE); }
  wax(i0: number, j0: number, i1: number, j1: number) { this.fill(i0, j0, i1, j1, WAX_SOLID); }
  mud(i0: number, j0: number, i1: number, j1: number) { this.fill(i0, j0, i1, j1, MUD); }
  wood(i0: number, j0: number, i1: number, j1: number) { this.fill(i0, j0, i1, j1, WOOD); }
  /** Wood pre-soaked with liquid fuel (particles per cell), like a candle wick that's been dipped in wax. */
  soakedWood(i0: number, j0: number, i1: number, j1: number, soak: number) {
    this.fill(i0, j0, i1, j1, WOOD);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.world.thermo.soak[i + j * NX] = soak;
  }
  moltenWax(i0: number, j0: number, i1: number, j1: number) { this.liquid(i0, j0, i1, j1, WAX, 70); }
  private fill(i0: number, j0: number, i1: number, j1: number, mat: number) {
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.world.setCell(i, j, mat);
  }
  water(i0: number, j0: number, i1: number, j1: number, temp = AMBIENT) { this.liquid(i0, j0, i1, j1, WATER, temp); }
  oil(i0: number, j0: number, i1: number, j1: number, temp = AMBIENT) { this.liquid(i0, j0, i1, j1, OIL, temp); }
  private liquid(i0: number, j0: number, i1: number, j1: number, kind: number, temp = AMBIENT) {
    const f = this.world.fluid, sp = 2 * f.radius;
    for (let y = j0 * CELL + f.radius; y < (j1 + 1) * CELL; y += sp)
      for (let x = i0 * CELL + f.radius; x < (i1 + 1) * CELL; x += sp) f.addParticle(x, y, 0, 0, kind, temp);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.world.thermo.T[i + j * NX] = temp;
  }
  /** Set the temperature of solid cells (e.g. a hot plate). */
  heat(i0: number, j0: number, i1: number, j1: number, temp: number) {
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.world.thermo.T[i + j * NX] = temp;
  }
  faucet(x: number, y: number, w = 6, speed = 150, on = true, kind = WATER, silt = 0) {
    this.world.emitters.push({ x, y, w, speed, on, kind, silt, acc: 0 });
  }
  drain(i0: number, j0: number, i1: number, j1: number) {
    this.world.drains.push({ i0, j0, i1, j1 });
  }
}

export class World {
  readonly physics: Physics;
  readonly fluid: Fluid;
  readonly thermo: Thermo;
  readonly sediment: Sediment;
  /** The unified fluid (same object as `fluid`), or null in classic mode. */
  readonly unified: UnifiedFluid | null;
  emitters: Emitter[] = [];
  drains: Rect[] = [];
  solidVersion = 0;
  time = 0;
  level: Level | null = null;
  /** Solids that came with the level: the player can't paint over or erase them (physics still can). */
  locked = new Uint8Array(NX * NY);
  /**
   * The material the player placed in each cell (NONE if they didn't). In puzzles, Erase only removes cells that
   * still hold what the player put there, not level terrain or anything physics made (settled mud, frozen ice).
   */
  playerMat = new Uint8Array(NX * NY);
  goal: GoalStatus = { amount: 0, purity: 0, silt: 0, temp: 0, met: false, held: 0, solved: false };

  constructor(physics: Physics = 'classic') {
    this.physics = physics;
    const unified = physics === 'unified' ? new UnifiedFluid(NX, NY, CELL, MAX_PARTICLES) : null;
    this.unified = unified;
    this.fluid = unified ?? new Fluid(NX, NY, CELL, MAX_PARTICLES);
    this.thermo = new Thermo(this.fluid);
    this.sediment = new Sediment(this.fluid, this.thermo);
    if (unified) {
      unified.attachTemperature(this.thermo.T, this.thermo.residue);
      this.thermo.unified = true;
      this.thermo.vaporSink = (x, y, r, amount, temp) => { unified.addVapor(x, y, r, amount, temp); };
    }
  }

  load(level: Level) {
    this.level = level;
    this.fluid.s.fill(1);
    this.fluid.sealBorder();
    this.fluid.clearParticles();
    this.thermo.reset();
    this.sediment.reset();
    for (let c = 0; c < NX * NY; c++) if (this.fluid.s[c] === 0) this.thermo.mat[c] = STONE;
    this.emitters = [];
    this.drains = [];
    this.time = 0;
    level.build(new Builder(this));
    for (let c = 0; c < NX * NY; c++) this.locked[c] = this.fluid.s[c] === 0 ? 1 : 0;
    this.playerMat.fill(NONE);
    this.fluid.refreshFields();
    this.goal = { amount: 0, purity: 0, silt: 0, temp: 0, met: false, held: 0, solved: false };
    this.solidVersion++;
  }

  /** Set one cell's solid material (NONE / STONE / ICE). The border always stays stone. */
  setCell(i: number, j: number, mat: number) {
    if (i <= 0 || j <= 0 || i >= NX - 1 || j >= NY - 1) return;
    const c = i + j * NX;
    this.fluid.setSolid(i, j, mat !== NONE);
    this.thermo.mat[c] = mat;
    this.thermo.fuel[c] = mat === WOOD ? WOOD_FUEL : 0;
    this.sediment.placed(c, mat === MUD);
    this.thermo.soak[c] = 0;
    this.thermo.wet[c] = 0;
    this.thermo.burning[c] = 0;
    if (mat === ICE) this.thermo.T[c] = Math.min(this.thermo.T[c], -15);
    else if (mat === NONE && this.thermo.T[c] < AMBIENT - 30) this.thermo.T[c] = AMBIENT;
  }

  /**
   * Paint a solid material (or NONE to erase) in a disk (pixel coords), skipping the level's locked cells and
   * stopping after `budget` new cells. Liquid inside new solid is removed. Returns how many cells were placed,
   * and how many of each material were erased (for refunds).
   */
  paintSolid(x: number, y: number, r: number, mat: number, budget = Infinity) {
    const f = this.fluid;
    const ci = x / CELL, cj = y / CELL, rc = r / CELL;
    let placed = 0;
    const erased: number[] = [];
    for (let j = Math.floor(cj - rc); j <= Math.ceil(cj + rc); j++)
      for (let i = Math.floor(ci - rc); i <= Math.ceil(ci + rc); i++) {
        if ((i + 0.5 - ci) ** 2 + (j + 0.5 - cj) ** 2 > rc * rc) continue;
        if (i <= 0 || j <= 0 || i >= NX - 1 || j >= NY - 1) continue;
        const c = i + j * NX, old = this.thermo.mat[c];
        if (this.locked[c] || old === mat || this.inNoBuild(i, j)) continue;
        if (mat !== NONE) {
          if (placed >= budget) continue;
          placed++;
          this.playerMat[c] = mat;
        } else {
          if (this.level?.puzzle && this.playerMat[c] !== old) continue; // not the player's to erase
          erased[old] = (erased[old] ?? 0) + 1;
          this.playerMat[c] = NONE;
        }
        this.setCell(i, j, mat);
      }
    if (mat !== NONE) f.removeWhere((px, py) => f.solidAt(px, py));
    this.solidVersion++;
    return { placed, erased };
  }

  pour(x: number, y: number, r: number, kind = WATER, silt = 0) {
    const f = this.fluid, sp = 2 * f.radius;
    for (let py = y - r; py <= y + r; py += sp)
      for (let px = x - r; px <= x + r; px += sp)
        if ((px - x) ** 2 + (py - y) ** 2 <= r * r) f.addParticle(px + (Math.random() - 0.5) * 0.2, py, 0, 0, kind, 20, silt);
  }

  steam(x: number, y: number, r: number) {
    if (this.unified) {
      // Same amount as the classic tool's puffs, as vapor mass in the gas field.
      this.unified.addVapor(x, y, r, Math.ceil(r) * STEAM_VAPOR, 115);
      return;
    }
    for (let n = 0; n < Math.ceil(r); n++) {
      const a = Math.random() * Math.PI * 2, d = Math.random() * r;
      this.thermo.addSteam(x + Math.cos(a) * d, y + Math.sin(a) * d, 0, -10, 115);
    }
  }

  sponge(x: number, y: number, r: number) {
    this.fluid.removeWhere((px, py) => (px - x) ** 2 + (py - y) ** 2 <= r * r);
  }

  step(dt: number) {
    const f = this.fluid, sp = 2 * f.radius;
    for (const e of this.emitters) {
      if (!e.on) continue;
      e.acc += e.speed * dt;
      while (e.acc >= sp) {
        e.acc -= sp;
        for (let x = e.x + f.radius; x < e.x + e.w; x += sp) f.addParticle(x + (Math.random() - 0.5) * 0.3, e.y + e.acc, 0, e.speed, e.kind, 20, e.silt);
      }
    }
    const changes = this.thermo.solidChanges;
    this.thermo.preStep();
    f.step(dt);
    this.thermo.step(dt);
    this.sediment.step(dt);
    if (this.thermo.solidChanges !== changes) this.solidVersion++;
    this.updateGoal(dt);
    for (const d of this.drains) {
      const x0 = d.i0 * CELL, y0 = d.j0 * CELL, x1 = (d.i1 + 1) * CELL, y1 = (d.j1 + 1) * CELL;
      f.removeWhere((px, py) => px >= x0 && px < x1 && py >= y0 && py < y1);
    }
    this.time += dt;
  }

  inNoBuild(i: number, j: number) {
    for (const r of this.level?.puzzle?.noBuild ?? []) if (i >= r.i0 && i <= r.i1 && j >= r.j0 && j <= r.j1) return true;
    return false;
  }

  private updateGoal(dt: number) {
    const goal = this.level?.puzzle?.goal;
    if (!goal) return;
    const f = this.fluid, z = goal.zone;
    let mine = 0, all = 0, silt = 0, temp = 0;
    for (let k = 0; k < f.count; k++) {
      const i = f.pos[2 * k] / CELL, j = f.pos[2 * k + 1] / CELL;
      if (i < z.i0 || i >= z.i1 + 1 || j < z.j0 || j >= z.j1 + 1) continue;
      all++;
      if (f.kind[k] !== goal.kind) continue;
      mine++;
      silt += f.silt[k];
      temp += f.temp[k];
    }
    // Dirt that has settled inside the zone counts too: a beaker that settles muddy water itself isn't clean.
    if (goal.maxSilt !== undefined) {
      for (let j = z.j0; j <= z.j1; j++) for (let i = z.i0; i <= z.i1; i++) {
        const c = i + j * NX;
        silt += this.sediment.deposit[c] + (this.thermo.mat[c] === MUD ? CELL_OF_MUD : 0);
      }
    }
    const g = this.goal;
    g.amount = mine;
    g.purity = all ? mine / all : 0;
    g.silt = mine ? silt / mine : 0;
    g.temp = mine ? temp / mine : 0;
    g.met = mine >= goal.amount && (goal.minPurity === undefined || g.purity >= goal.minPurity)
      && (goal.maxSilt === undefined || g.silt <= goal.maxSilt)
      && (goal.minTemp === undefined || g.temp >= goal.minTemp);
    g.held = g.met ? g.held + dt : 0;
    if (g.held >= HOLD_TO_WIN) g.solved = true;
  }

  /** Number of particles inside a cell rect: handy for goals and tests. */
  countIn(r: Rect) {
    const f = this.fluid;
    let n = 0;
    for (let k = 0; k < f.count; k++) {
      const i = f.pos[2 * k] / CELL, j = f.pos[2 * k + 1] / CELL;
      if (i >= r.i0 && i < r.i1 + 1 && j >= r.j0 && j < r.j1 + 1) n++;
    }
    return n;
  }
}

// ---- Levels ----

/** Cup interior, used by tests to measure how much water the cup holds. */
export const CUP_INTERIOR: Rect = { i0: 47, j0: 28, i1: 100, j1: 69 };

export const LEVELS: Level[] = [
  {
    name: 'Pythagorean Cup',
    desc: 'Fill it past the hidden crest and a siphon inside the column drains the whole cup through its base.',
    build: b => {
      // Cup
      b.solid(44, 28, 46, 72);
      b.solid(113, 28, 115, 72);
      b.solid(44, 70, 115, 72);
      // Siphon column against the right wall: inlet at the bottom left, up, over the crest, down through the base.
      b.solid(101, 38, 112, 69);
      b.open(103, 41, 110, 43); // crest bend
      b.open(103, 44, 105, 69); // rising leg
      b.open(108, 44, 110, 72); // falling leg, through the cup floor
      b.open(101, 66, 102, 69); // inlet
      // Basin below
      b.solid(28, 86, 131, 88);
      b.solid(28, 74, 30, 88);
      b.solid(129, 74, 131, 88);
      b.drain(90, 85, 128, 85);
      b.faucet(140, 10);
    },
  },
  {
    name: 'U-Tube',
    desc: 'Water poured into one side rises to the same level in the other.',
    build: b => {
      b.solid(40, 20, 120, 80);
      b.open(46, 20, 54, 72); // left leg
      b.open(106, 20, 114, 72); // right leg
      b.open(46, 66, 114, 72); // bottom bend
      b.faucet(96, 6, 6, 150);
    },
  },
  {
    name: 'Siphon',
    desc: 'A primed hose over a wall drains the high tank into the low one.',
    build: b => {
      // High tank (left) and low tank (right)
      b.solid(10, 30, 12, 62); b.solid(10, 60, 60, 62); b.solid(58, 22, 60, 62);
      b.solid(80, 50, 82, 88); b.solid(80, 86, 150, 88); b.solid(148, 50, 150, 88);
      // Hose: outer walls, then inner walls, leaving a 3-cell channel from deep in the left tank,
      // over the left tank's wall, and down into the right tank.
      b.solid(40, 12, 94, 14); b.solid(40, 15, 42, 52); b.solid(92, 15, 94, 76);
      b.solid(46, 19, 88, 21); b.solid(46, 22, 48, 52); b.solid(86, 22, 88, 76);
      b.water(13, 34, 57, 59);
      b.water(43, 15, 45, 52); b.water(46, 15, 88, 18); b.water(89, 15, 91, 76); // primed
    },
  },
  {
    name: 'Oil & Water',
    desc: 'Oil floats on water. Pour more from the faucet, then set the slick alight with the Fire tool.',
    build: b => {
      b.solid(30, 36, 32, 82); b.solid(128, 36, 130, 82); b.solid(30, 80, 130, 82);
      b.water(33, 60, 127, 79);
      b.oil(33, 54, 127, 59);
      b.faucet(150, 6, 6, 120, false, OIL);
    },
  },
  {
    name: 'Steam Boiler',
    desc: 'Light the oil under the sealed boiler with the Fire tool. Steam pressure builds and forces water up the pipe into the cup.',
    build: b => {
      // Sealed boiler, half full of water.
      b.solid(50, 40, 90, 41); b.solid(50, 61, 90, 62); b.solid(50, 40, 51, 62); b.solid(89, 40, 90, 62);
      b.water(52, 48, 88, 60);
      // Outlet pipe: dips below the waterline inside the boiler, rises through the lid, runs right, and drops into a cup.
      b.solid(79, 30, 79, 57); b.solid(83, 35, 83, 57); b.open(80, 40, 82, 41);
      b.solid(79, 30, 121, 31); b.solid(83, 35, 117, 35);
      b.solid(117, 35, 117, 44); b.solid(121, 30, 121, 44);
      // Cup
      b.solid(106, 48, 107, 72); b.solid(132, 48, 133, 72); b.solid(106, 71, 133, 72);
      // Oil tray under the boiler.
      b.solid(50, 64, 51, 72); b.solid(89, 64, 90, 72); b.solid(50, 71, 90, 72);
      b.oil(52, 66, 88, 70);
    },
  },
  {
    name: 'Grease Fire',
    desc: 'A pan of oil, already burning. Turn on the faucet (G) and see why you never throw water on a grease fire.',
    build: b => {
      // Pan on a hot stone stove.
      b.solid(60, 66, 61, 76); b.solid(100, 66, 101, 76); b.solid(60, 75, 101, 76);
      b.solid(56, 77, 105, 80);
      b.heat(56, 75, 105, 80, 400);
      b.oil(62, 66, 99, 74, 320);
      b.faucet(150, 6, 4, 120, false, WATER);
    },
  },
  {
    name: 'Candles',
    desc: 'Wax only burns as vapor. Left: a candle whose wick is a thin wooden stick. Light the tip with a quick touch of Fire: it melts a pool, draws the wax up its grain, and keeps burning. Right: a bare block of wax. Try lighting that.',
    build: b => {
      b.solid(20, 78, 140, 80);
      // Candle: a thin, pre-waxed wooden stick running down through the wax.
      b.wax(40, 50, 52, 77);
      b.soakedWood(46, 46, 46, 72, 1);
      // Bare wax block, no wick.
      b.wax(100, 50, 112, 77);
    },
  },
  {
    name: 'Campfire',
    desc: 'A pot of water over a stack of logs. Light the end of a log with the Fire tool: the logs catch one after another and the pot boils. Pour water on it to put it out.',
    build: b => {
      // Stone hearth with a log pile
      b.solid(50, 82, 110, 84);
      b.wood(56, 78, 104, 81); b.wood(60, 74, 100, 77); b.wood(66, 70, 94, 73);
      // Pot on stone legs
      b.solid(58, 50, 60, 64); b.solid(100, 50, 102, 64); b.solid(58, 63, 102, 64);
      b.solid(58, 65, 59, 70); b.solid(101, 65, 102, 70);
      b.water(61, 54, 99, 62);
      b.faucet(140, 6, 4, 110, false, WATER);
    },
  },
  {
    name: 'Frozen Pipe',
    desc: 'An ice plug blocks the drain. Melt it with the Fire tool (or freeze things with Chill).',
    build: b => {
      // Tank with a drain pipe in its floor.
      b.solid(20, 20, 22, 52); b.solid(58, 20, 60, 52); b.solid(20, 50, 60, 52);
      b.open(39, 50, 41, 52);
      b.solid(37, 53, 38, 70); b.solid(42, 53, 43, 70);
      b.ice(39, 52, 41, 58);
      b.water(23, 24, 57, 49);
      // Cup below.
      b.solid(25, 74, 26, 87); b.solid(54, 74, 55, 87); b.solid(25, 86, 55, 87);
    },
  },
  {
    name: 'Settling Basin',
    desc: 'Muddy water pours in. Where it runs calm, silt settles out and builds up as mud behind the low wall; clearer water spills on into the beaker. Fast water erodes mud.',
    build: b => {
      // Long basin: water passes over a low inner wall that traps settling mud, then over the end weir into a beaker.
      b.solid(14, 44, 16, 80); b.solid(14, 78, 132, 80); b.solid(130, 60, 132, 80);
      b.solid(130, 60, 139, 60); // spout lip so the overflow clears the wall and lands in the beaker
      b.solid(60, 66, 61, 77); // inner wall: mud settles behind it
      b.mud(90, 70, 110, 77); // a mud bank in the stream
      // Beaker
      b.solid(136, 66, 137, 86); b.solid(154, 66, 155, 86); b.solid(136, 86, 155, 86);
      b.drain(1, 88, 158, 88); // anything that spills onto the floor
      b.faucet(40, 6, 4, 110, true, WATER, 0.9);
    },
  },
  {
    name: 'Washout',
    desc: 'Clear water fills a reservoir behind a mud dam. When it overtops, the flow cuts a notch, washes the dam out, and scours a channel down the mud slope, turning brown as it picks up silt.',
    build: b => {
      // Reservoir held back by a mud dam.
      b.solid(4, 12, 6, 44); b.solid(4, 42, 64, 44);
      b.mud(52, 22, 64, 41);
      // Mud hillside below the dam, sloping down to a pool, on a stone base.
      for (let i = 65; i <= 140; i++) {
        const top = Math.round(44 + (i - 65) * 0.42);
        b.mud(i, top, i, 80);
      }
      b.solid(60, 81, 158, 83); b.solid(156, 60, 158, 83);
      b.drain(141, 80, 155, 80);
      b.faucet(30, 6, 4, 110, true, WATER, 0);
    },
  },
  {
    name: 'Mud Dams',
    desc: 'A reservoir between a thin mud dam (left) and a thick one (right). Water soaks in and seeps through: watch the dams darken, the thin one start dripping first, and soaked faces slump into the water.',
    build: b => {
      b.solid(10, 70, 150, 72);
      b.mud(48, 34, 51, 69); // thin dam
      b.mud(108, 34, 119, 69); // thick dam
      b.water(52, 38, 107, 69);
    },
  },
  {
    name: 'Sandbox',
    desc: 'An empty room. Draw walls, pour water.',
    build: b => {
      b.solid(1, 84, NX - 2, NY - 2);
    },
  },
];
