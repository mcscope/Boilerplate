import { Genome, Stats, breed, deriveStats, makeName, wildGenome } from './genes';

export const TILE = 25;
export const GW = 16;
export const GH = 10;
export const PEN_W = GW * TILE;
export const PEN_H = GH * TILE;
export const PEN_NAMES = ['A', 'B', 'C', 'D'];

export type TileKind = 'floor' | 'wall' | 'spikes' | 'lure' | 'food' | 'door';

export const TILE_INFO: Record<TileKind, { label: string; desc: string }> = {
  floor: { label: 'Erase', desc: 'Clear tiles back to bare floor.' },
  wall: { label: 'Wall', desc: 'Blocks movement.' },
  spikes: { label: 'Spikes', desc: 'Drains energy from anything crossing it. Armor protects.' },
  lure: { label: 'Lure', desc: 'Draws in creatures that can see it (walls block sight) when they are not busy eating or mating.' },
  food: { label: 'Food', desc: 'A food patch. When eaten it regrows after a while (set per pen with the Regrow slider).' },
  door: { label: 'Door', desc: 'One-way door. Click a tile to place it, then click anywhere (any pen) to set where it leads.' },
};

export const REGROW_TIME = 10; // seconds at 1× regrow
const FOOD_ENERGY = 25;
const SENSE = 150;
const LURE_RANGE = 6 * TILE;
const SPIKE_DRAIN = 50; // energy/s, scaled down by armor
const MATURE_AGE = 12;
const MATE_COST = 20;
const CHILD_ENERGY = 30;
const POP_CAP = 400;

export type DeathCause = 'starved' | 'spikes' | 'old age' | 'culled';

export interface Creature {
  id: number;
  name: string;
  genome: Genome;
  stats: Stats;
  gen: number;
  parents: [string, string] | null;
  pen: number;
  x: number;
  y: number;
  angle: number;
  wander: number;
  energy: number;
  age: number;
  lifespan: number;
  mateCooldown: number;
  children: number;
  dead: DeathCause | null;
}

type Pt = { x: number; y: number };
export interface Exit { pen: number; x: number; y: number }

export interface Pen {
  regrow: number; // food regrowth speed multiplier
  radiation: number; // 0..1
  tiles: TileKind[];
  doors: Map<number, Exit>; // door tile index → where it leads
  growth: Float32Array; // per food tile: seconds until it has food again (0 = ready)
  version: number;
  lures: Pt[];
  foods: number[]; // tile indices of food patches
}

export interface Splat { pen: number; x: number; y: number; r: number; color: string; t: number }

let nextId = 1;

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const tileCenter = (i: number): Pt => ({ x: (i % GW) * TILE + TILE / 2, y: Math.floor(i / GW) * TILE + TILE / 2 });

function turnToward(current: number, target: number, maxStep: number) {
  let d = target - current;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return current + Math.max(-maxStep, Math.min(maxStep, d));
}

export class Lab {
  pens: Pen[] = PEN_NAMES.map(() => ({
    regrow: 1, radiation: 0.1, tiles: new Array(GW * GH).fill('floor'), doors: new Map(),
    growth: new Float32Array(GW * GH), version: 0, lures: [], foods: [],
  }));
  creatures: Creature[] = [];
  splats: Splat[] = [];
  time = 0;
  births = 0;
  deaths: Record<DeathCause, number> = { starved: 0, spikes: 0, 'old age': 0, culled: 0 };

  constructor() {
    this.fillRect(0, 6, 3, 9, 6, 'food');
    for (let i = 0; i < 14; i++) this.add(wildGenome(), 0, null, 0, this.randomSpot(0, 4)).age = MATURE_AGE + Math.random() * 30;
  }

  tileIndex(x: number, y: number): number | null {
    const c = Math.floor(x / TILE), r = Math.floor(y / TILE);
    return c < 0 || r < 0 || c >= GW || r >= GH ? null : r * GW + c;
  }

  tileAt(pen: number, x: number, y: number): TileKind | null {
    const i = this.tileIndex(x, y);
    return i === null ? null : this.pens[pen].tiles[i];
  }

  walkable(pen: number, x: number, y: number) {
    const t = this.tileAt(pen, x, y);
    return t !== null && t !== 'wall';
  }

  setTile(pen: number, i: number, kind: TileKind, exit?: Exit) {
    const p = this.pens[pen];
    if (kind === 'door') {
      // A door can't lead onto a wall or another door (that would bounce forever).
      const t = exit && this.tileAt(exit.pen, exit.x, exit.y);
      if (!exit || !t || t === 'wall' || t === 'door') return;
    } else if (p.tiles[i] === kind) return;
    p.tiles[i] = kind;
    if (kind === 'door') p.doors.set(i, exit!);
    else p.doors.delete(i);
    p.growth[i] = 0;
    p.lures = [];
    p.foods = [];
    p.tiles.forEach((t, j) => {
      if (t === 'lure') p.lures.push(tileCenter(j));
      if (t === 'food') p.foods.push(j);
    });
    p.version++;
  }

  /** Fill (or outline, if hollow) the tile rectangle between two corners. */
  fillRect(pen: number, c0: number, r0: number, c1: number, r1: number, kind: TileKind, hollow = false) {
    for (const i of rectCells(c0, r0, c1, r1, hollow)) this.setTile(pen, i, kind);
  }

  /** Closest of `options` within range that `c` has a clear line of sight to. */
  nearestVisible<T extends Pt>(c: Creature, options: T[], range: number): T | null {
    const near = options.map(o => ({ o, d: dist(c, o) })).filter(e => e.d < range).sort((a, b) => a.d - b.d);
    for (const e of near) if (this.canSee(c.pen, c, e.o)) return e.o;
    return null;
  }

  /** True if nothing but open tiles lies on the straight line between two points. */
  canSee(pen: number, a: Pt, b: Pt) {
    const steps = Math.ceil(dist(a, b) / (TILE / 4));
    const tiles = this.pens[pen].tiles;
    for (let k = 1; k < steps; k++) {
      const i = this.tileIndex(a.x + ((b.x - a.x) * k) / steps, a.y + ((b.y - a.y) * k) / steps);
      if (i !== null && tiles[i] === 'wall') return false;
    }
    return true;
  }

  randomSpot(pen: number, margin: number): Pt {
    for (let tries = 0; tries < 30; tries++) {
      const p = { x: margin + Math.random() * (PEN_W - margin * 2), y: margin + Math.random() * (PEN_H - margin * 2) };
      const t = this.tileAt(pen, p.x, p.y);
      if (t === 'floor' || t === 'lure' || t === 'food') return p;
    }
    return { x: PEN_W / 2, y: PEN_H / 2 };
  }

  private add(genome: Genome, gen: number, parents: [string, string] | null, pen: number, at: Pt, energyFrac = 0.7) {
    const stats = deriveStats(genome);
    const c: Creature = {
      id: nextId++, name: makeName(), genome, stats, gen, parents, pen, ...at,
      angle: Math.random() * Math.PI * 2, wander: Math.random() * Math.PI * 2,
      energy: stats.maxEnergy * energyFrac, age: 0, lifespan: 120 + Math.random() * 60,
      mateCooldown: 0, children: 0, dead: null,
    };
    this.creatures.push(c);
    return c;
  }

  inPen(pen: number) {
    return this.creatures.filter(c => c.pen === pen);
  }

  moveTo(ids: Set<number>, pen: number) {
    for (const c of this.creatures) {
      if (!ids.has(c.id) || c.pen === pen) continue;
      c.pen = pen;
      Object.assign(c, this.randomSpot(pen, c.stats.radius));
    }
  }

  /** Put a creature at an exact spot, nudged to the nearest open ground if that spot is a wall. */
  place(c: Creature, pen: number, x: number, y: number) {
    const r = c.stats.radius;
    const clampX = (v: number) => Math.max(r, Math.min(PEN_W - r, v));
    const clampY = (v: number) => Math.max(r, Math.min(PEN_H - r, v));
    let at = { x: clampX(x), y: clampY(y) };
    if (!this.walkable(pen, at.x, at.y)) {
      let best = Infinity;
      this.pens[pen].tiles.forEach((t, i) => {
        if (t === 'wall') return;
        const q = tileCenter(i), d = dist(q, at);
        if (d < best) { best = d; at = q; }
      });
    }
    c.pen = pen;
    c.x = at.x;
    c.y = at.y;
  }

  cull(ids: Set<number>) {
    for (const c of this.creatures) if (ids.has(c.id)) this.die(c, 'culled');
    this.creatures = this.creatures.filter(c => !c.dead);
  }

  private die(c: Creature, cause: DeathCause) {
    c.dead = cause;
    this.deaths[cause]++;
    const color = cause === 'culled' || cause === 'spikes' ? '#7a2a2a' : cause === 'starved' ? '#5a5040' : '#4a3d55';
    this.splats.push({ pen: c.pen, x: c.x, y: c.y, r: c.stats.radius * 1.3, color, t: 12 });
  }

  step(dt: number) {
    this.time += dt;

    for (const pen of this.pens) for (const i of pen.foods) pen.growth[i] = Math.max(0, pen.growth[i] - dt);

    const ready = (c: Creature) =>
      !c.dead && c.age > MATURE_AGE && c.mateCooldown <= 0 && c.energy > c.stats.maxEnergy * c.stats.mateThreshold;

    for (const c of this.creatures) {
      if (c.dead) continue;
      c.age += dt;
      c.mateCooldown -= dt;
      c.energy -= c.stats.metabolism * dt;

      const pen = this.pens[c.pen];
      const here = this.tileIndex(c.x, c.y);
      const tile = here === null ? null : pen.tiles[here];
      if (tile === 'spikes') c.energy -= SPIKE_DRAIN * (1 - c.genome.armor * 0.85) * dt;

      if (c.energy <= 0) { this.die(c, tile === 'spikes' ? 'spikes' : 'starved'); continue; }
      if (c.age >= c.lifespan) { this.die(c, 'old age'); continue; }

      if (tile === 'door' && here !== null) {
        const ex = pen.doors.get(here)!;
        this.place(c, ex.pen, ex.x + (Math.random() - 0.5) * 6, ex.y + (Math.random() - 0.5) * 6);
        continue;
      }

      // Priorities: eat when hungry, then mate when ready, then follow a lure, else wander.
      let target: Pt | null = null;

      if (c.energy < c.stats.maxEnergy * 0.75) {
        const seen = this.nearestVisible(c, pen.foods.filter(i => pen.growth[i] <= 0).map(i => ({ i, ...tileCenter(i) })), SENSE);
        const best = seen ? dist(c, seen) : Infinity, bi = seen ? seen.i : -1;
        if (bi >= 0) {
          target = tileCenter(bi);
          if (best < c.stats.radius + 5) {
            pen.growth[bi] = REGROW_TIME / pen.regrow;
            c.energy = Math.min(c.stats.maxEnergy, c.energy + FOOD_ENERGY);
            target = null;
          }
        }
      }

      if (!target && ready(c)) {
        const mate = this.nearestVisible(c, this.creatures.filter(o => o !== c && o.pen === c.pen && ready(o)), Infinity);
        const best = mate ? dist(c, mate) : Infinity;
        if (mate) {
          target = mate;
          if (best < c.stats.radius + mate.stats.radius + 2 && this.creatures.length < POP_CAP) this.mate(c, mate);
        }
      }

      if (!target) {
        let best = LURE_RANGE;
        for (const l of pen.lures) {
          const d = dist(c, l);
          if (d < best && d > TILE * 0.4 && this.canSee(c.pen, c, l)) { best = d; target = l; }
        }
      }

      if (target) c.wander = Math.atan2(target.y - c.y, target.x - c.x);
      else c.wander += (Math.random() - 0.5) * 4 * dt;
      c.angle = turnToward(c.angle, c.wander, 7 * dt);
      this.move(c, c.stats.speed * dt);
    }

    this.creatures = this.creatures.filter(c => !c.dead);
    for (const s of this.splats) s.t -= dt;
    this.splats = this.splats.filter(s => s.t > 0);
  }

  private move(c: Creature, step: number) {
    const r = c.stats.radius;
    const nx = Math.max(r, Math.min(PEN_W - r, c.x + Math.cos(c.angle) * step));
    const ny = Math.max(r, Math.min(PEN_H - r, c.y + Math.sin(c.angle) * step));
    const stuck = !this.walkable(c.pen, c.x, c.y); // a wall was painted on top of it
    if (stuck || this.walkable(c.pen, nx, ny)) { c.x = nx; c.y = ny; }
    else if (this.walkable(c.pen, nx, c.y)) c.x = nx;
    else if (this.walkable(c.pen, c.x, ny)) c.y = ny;
    else c.wander = c.angle + Math.PI + (Math.random() - 0.5);
    // Bounce off the pen edges.
    if (nx <= r || nx >= PEN_W - r) c.wander = Math.PI - c.angle;
    if (ny <= r || ny >= PEN_H - r) c.wander = -c.angle;
  }

  private mate(a: Creature, b: Creature) {
    for (const p of [a, b]) {
      p.energy -= MATE_COST;
      p.mateCooldown = p.stats.mateCooldown;
      p.children++;
    }
    const genome = breed(a.genome, b.genome, this.pens[a.pen].radiation);
    const child = this.add(genome, Math.max(a.gen, b.gen) + 1, [a.name, b.name], a.pen, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    child.energy = Math.min(child.stats.maxEnergy, CHILD_ENERGY);
    this.births++;
  }
}

export function rectCells(c0: number, r0: number, c1: number, r1: number, hollow = false): number[] {
  const [ca, cb] = [Math.min(c0, c1), Math.max(c0, c1)];
  const [ra, rb] = [Math.min(r0, r1), Math.max(r0, r1)];
  const cells: number[] = [];
  for (let r = ra; r <= rb; r++) for (let c = ca; c <= cb; c++) {
    if (hollow && r !== ra && r !== rb && c !== ca && c !== cb) continue;
    cells.push(r * GW + c);
  }
  return cells;
}
