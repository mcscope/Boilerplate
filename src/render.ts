import { AIR } from './sim/fluid';
import { ICE, MUD, WAX_SOLID, WOOD, WOOD_FUEL } from './sim/thermo';
import { GAS, P0, RHO_AIR, SOLID, T_AMBIENT, VAPOR_MOLAR_RATIO } from './sim2/types';
import { CELL, H, NX, NY, W, World } from './world';

/** Vapor density of a cell of pure steam at 100 °C and atmospheric pressure: the "thick mist" reference. */
const VAPOR_REF = RHO_AIR * VAPOR_MOLAR_RATIO * ((T_AMBIENT + 273.15) / (100 + 273.15));
/** 4×4 Bayer matrix, for ordered-dither mist. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16);

function pressureTint(out: Uint8ClampedArray, o: number, g: number, scale = 1) {
  if (Math.abs(g) < 0.01) return;
  const a = Math.min(0.6, Math.abs(g) * 1.5) * scale;
  const tint: RGB = g > 0 ? [255, 120, 60] : [80, 140, 255];
  for (let k = 0; k < 3; k++) out[o + k] = out[o + k] * (1 - a) + tint[k] * a;
}

type RGB = [number, number, number];

function hash(a: number, b: number, c = 0) {
  let h = Math.imul(a, 374761393) ^ Math.imul(b, 668265263) ^ Math.imul(c, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

interface Palette { surface: RGB; light: RGB; base: RGB; deep: RGB; foam: RGB }
const WATER: Palette = {
  surface: [168, 222, 255], light: [86, 166, 232], base: [52, 120, 204], deep: [34, 82, 164], foam: [228, 244, 255],
};
const OIL_COLORS: Palette = {
  surface: [252, 216, 112], light: [224, 172, 62], base: [182, 126, 36], deep: [132, 86, 22], foam: [255, 238, 172],
};
const WAX_COLORS: Palette = {
  surface: [255, 248, 224], light: [248, 230, 186], base: [234, 206, 152], deep: [212, 180, 122], foam: [255, 252, 238],
};

/** Overlay color and opacity for a temperature, or null for comfortable room temperature. */
function heatTint(t: number): [RGB, number] | null {
  if (t < 0) return [[90, 160, 255], Math.min(0.7, 0.25 - t / 60)];
  if (t < 35) return null;
  if (t < 100) return [[255, 160, 40], ((t - 35) / 65) * 0.5];
  if (t < 300) return [[255, 70, 30], 0.5 + ((t - 100) / 200) * 0.2];
  return [[255, 240, 200], 0.75];
}

// ---- Effects: quick, element-themed pixel animations drawn over the world ----

type FxKind = 'drop' | 'spark' | 'steam' | 'dust' | 'star' | 'rocket';
interface Fx { x: number; y: number; vx: number; vy: number; life: number; max: number; kind: FxKind; c: RGB; payload?: FxKind }

const DROP_COLORS: RGB[] = [[168, 222, 255], [86, 166, 232], [228, 244, 255]];
const SPARK_COLORS: RGB[] = [[255, 244, 170], [255, 168, 46], [226, 64, 26]];
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

export class Effects {
  private list: Fx[] = [];
  /** Water-wipe transition: the screen starts flooded and drains away. 0 = none, counts up to WIPE_TIME. */
  private wipe = -1;
  private readonly WIPE_TIME = 0.75;

  add(x: number, y: number, kind: FxKind, n: number, speed = 80, spread = Math.PI * 2, dir = -Math.PI / 2, color?: RGB) {
    for (let k = 0; k < n; k++) {
      const a = dir + (Math.random() - 0.5) * spread, v = speed * (0.4 + Math.random() * 0.8);
      const max = kind === 'steam' ? 0.8 + Math.random() * 0.6 : kind === 'dust' ? 0.3 + Math.random() * 0.3 : 0.5 + Math.random() * 0.7;
      const c = color ?? (kind === 'drop' ? pick(DROP_COLORS) : kind === 'spark' ? pick(SPARK_COLORS)
        : kind === 'steam' ? [236, 240, 248] : kind === 'star' ? [255, 240, 150] : [150, 150, 160]);
      this.list.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: max, max, kind, c });
    }
  }

  /** A firework that rises, then bursts into a ring of one element. */
  rocket(x: number, y: number, payload: FxKind, delay = 0) {
    this.list.push({ x, y, vx: (Math.random() - 0.5) * 30, vy: -150 - Math.random() * 60, life: 0.55 + delay, max: 0.55 + delay, kind: 'rocket', c: [255, 255, 220], payload });
  }

  startWipe() { this.wipe = 0; }

  draw(out: Uint8ClampedArray, dt: number) {
    const blend = (x: number, y: number, c: RGB, a: number) => {
      x = Math.round(x); y = Math.round(y);
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const o = (y * W + x) * 4;
      out[o] += (c[0] - out[o]) * a; out[o + 1] += (c[1] - out[o + 1]) * a; out[o + 2] += (c[2] - out[o + 2]) * a;
    };

    // Water wipe: a wavy water surface that sinks from the top of the screen to the bottom.
    if (this.wipe >= 0) {
      this.wipe += dt;
      const t = Math.min(1, this.wipe / this.WIPE_TIME), ease = t * t * (3 - 2 * t);
      const level = ease * (H + 12) - 6;
      for (let x = 0; x < W; x++) {
        const surf = Math.round(level + Math.sin(x * 0.12 + this.wipe * 14) * 3 + Math.sin(x * 0.05 - this.wipe * 9) * 2);
        for (let y = Math.max(0, surf); y < H; y++) {
          const d = y - surf;
          const c: RGB = d === 0 ? [228, 244, 255] : d < 3 ? [86, 166, 232] : d < 24 ? [52, 120, 204] : [34, 82, 164];
          blend(x, y, c, 1);
        }
        if (Math.random() < 0.03 && surf > 0 && surf < H) this.add(x, surf, 'drop', 1, 60, 1.2);
      }
      if (t >= 1) this.wipe = -1;
    }

    const g = 400;
    for (let k = this.list.length - 1; k >= 0; k--) {
      const p = this.list[k];
      p.life -= dt;
      if (p.life <= 0) {
        if (p.kind === 'rocket' && p.payload) {
          // Burst: a ring of the payload element, plus a few stars.
          const n = 26;
          for (let q = 0; q < n; q++) this.add(p.x, p.y, p.payload, 1, 90, 0.3, (q / n) * Math.PI * 2);
          this.add(p.x, p.y, 'star', 6, 60);
        }
        this.list.splice(k, 1);
        continue;
      }
      const f = p.life / p.max;
      if (p.kind === 'steam') { p.vy -= 20 * dt; p.vx *= 0.97; p.vy *= 0.97; }
      else if (p.kind === 'spark' || p.kind === 'star') { p.vy += g * 0.25 * dt; p.vx *= 0.98; }
      else if (p.kind === 'rocket') { p.vy += g * 0.3 * dt; }
      else p.vy += g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      switch (p.kind) {
        case 'drop':
          blend(p.x, p.y, p.c, 1);
          blend(p.x, p.y - 1, [228, 244, 255], 0.5 * f);
          break;
        case 'spark': {
          const c = f > 0.66 ? SPARK_COLORS[0] : f > 0.33 ? SPARK_COLORS[1] : SPARK_COLORS[2];
          blend(p.x, p.y, c, 0.95);
          break;
        }
        case 'steam': {
          const r = 1 + (1 - f) * 2.5;
          for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (dx * dx + dy * dy <= r * r) blend(p.x + dx, p.y + dy, p.c, 0.6 * f);
          break;
        }
        case 'dust':
          blend(p.x, p.y, p.c, 0.8 * f);
          break;
        case 'star': {
          const tw = (Math.floor(p.life * 20) % 2) ? 1 : 0.5;
          blend(p.x, p.y, [255, 255, 230], tw);
          blend(p.x - 1, p.y, p.c, 0.6 * tw); blend(p.x + 1, p.y, p.c, 0.6 * tw);
          blend(p.x, p.y - 1, p.c, 0.6 * tw); blend(p.x, p.y + 1, p.c, 0.6 * tw);
          break;
        }
        case 'rocket':
          blend(p.x, p.y, [255, 255, 230], 1);
          blend(p.x, p.y + 1, [255, 200, 120], 0.7);
          if (Math.random() < 0.6) this.add(p.x, p.y + 2, 'spark', 1, 15, 0.8, Math.PI / 2);
          break;
      }
    }
  }
}

/** Draws the world at native 320×180 into an ImageData; the canvas is scaled up with no smoothing. */
export class Renderer {
  readonly fx = new Effects();
  private img: ImageData;
  private staticLayer: Uint8ClampedArray;
  private staticVersion = -1;
  private water = new Uint8Array(W * H);

  constructor(private ctx: CanvasRenderingContext2D) {
    this.img = ctx.createImageData(W, H);
    this.staticLayer = new Uint8ClampedArray(W * H * 4);
  }

  private matAt(world: World, i: number, j: number) {
    if (i < 0 || j < 0 || i >= NX || j >= NY) return 1;
    return world.thermo.mat[i + j * NX];
  }

  private solidCell(world: World, i: number, j: number) {
    if (i < 0 || j < 0 || i >= NX || j >= NY) return true;
    return world.fluid.s[i + j * NX] === 0;
  }

  /** Background and solids: only redrawn when walls change. */
  private buildStatic(world: World) {
    const d = this.staticLayer;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const i = Math.floor(x / CELL), j = Math.floor(y / CELL);
      let c: RGB;
      const mat = this.matAt(world, i, j);
      if (mat === WOOD) {
        // Wood: horizontal planks with grain lines, knots, and dark seams between planks.
        const plank = Math.floor(y / 4);
        const tone = hash(plank, Math.floor((x + plank * 7) / 12), 17);
        c = tone < 0.5 ? [150, 100, 56] : [138, 90, 50];
        if (hash(x, plank, 18) < 0.12 || (y % 4 === 1 && hash(Math.floor(x / 3), plank, 19) < 0.4)) c = [116, 74, 40]; // grain
        if (hash(Math.floor(x / 4), plank, 20) < 0.03) c = [92, 58, 30]; // knot
        if (y % 4 === 3) c = [84, 52, 28];
        const ox = x % CELL, oy = y % CELL;
        if (oy === 0 && this.matAt(world, i, j - 1) !== WOOD && !this.solidCell(world, i, j - 1)) c = [180, 128, 76];
        else if (ox === 0 && !this.solidCell(world, i - 1, j)) c = [100, 64, 34];
        else if (ox === CELL - 1 && !this.solidCell(world, i + 1, j)) c = [96, 60, 32];
      } else if (mat === MUD) {
        // Mud: dark earth with pebbles; the top surface is wetter and darker.
        const n = hash(x, y, 15);
        c = n < 0.08 ? [138, 112, 82] : n < 0.16 ? [92, 68, 46] : [112, 84, 56];
        if (hash(Math.floor(x / 3), Math.floor(y / 3), 16) < 0.07) c = [150, 136, 118]; // pebble
        if (y % CELL === 0 && this.matAt(world, i, j - 1) !== MUD && !this.solidCell(world, i, j - 1)) c = [74, 54, 36];
      } else if (mat === ICE || mat === WAX_SOLID) {
        // Ice: pale and glassy with bright facets. Wax: creamy and smooth.
        const ice = mat === ICE;
        const n = hash(x, y, 14);
        c = ice ? (n < 0.12 ? [214, 242, 255] : [166, 214, 238]) : (n < 0.1 ? [246, 228, 188] : [232, 210, 160]);
        if (ice && (x + y * 2) % 11 === 0) c = [236, 250, 255]; // glints
        const ox = x % CELL, oy = y % CELL;
        if (oy === 0 && this.matAt(world, i, j - 1) !== mat) c = ice ? [246, 253, 255] : [255, 244, 214];
        else if (oy === CELL - 1 && this.matAt(world, i, j + 1) !== mat) c = ice ? [104, 160, 200] : [186, 154, 100];
        else if (ox === 0 && this.matAt(world, i - 1, j) !== mat) c = ice ? [130, 186, 222] : [206, 178, 124];
        else if (ox === CELL - 1 && this.matAt(world, i + 1, j) !== mat) c = ice ? [120, 176, 214] : [198, 170, 116];
      } else if (this.solidCell(world, i, j)) {
        // Stone bricks: 8×4 px, rows offset by half a brick.
        const bx = Math.floor((x + (Math.floor(y / 4) % 2) * 4) / 8), by = Math.floor(y / 4);
        const tone = hash(bx, by, 11);
        c = tone < 0.33 ? [96, 100, 118] : tone < 0.66 ? [88, 92, 110] : [104, 106, 124];
        if (y % 4 === 3 || (x + (Math.floor(y / 4) % 2) * 4) % 8 === 7) c = [70, 72, 88]; // mortar
        if (hash(x, y, 12) < 0.06) c = [116, 120, 138];
        // Edges facing open space: lit from above, shadowed below.
        const ox = x % CELL, oy = y % CELL;
        if (oy === 0 && !this.solidCell(world, i, j - 1)) c = [150, 156, 176];
        else if (oy === CELL - 1 && !this.solidCell(world, i, j + 1)) c = [40, 40, 54];
        else if (ox === 0 && !this.solidCell(world, i - 1, j)) c = [62, 64, 80];
        else if (ox === CELL - 1 && !this.solidCell(world, i + 1, j)) c = [52, 54, 70];
      } else {
        // Back wall: dark panels with faint seams and dither.
        c = [22, 24, 34];
        if (x % 32 === 0 || y % 24 === 0) c = [28, 30, 42];
        else if (hash(x, y, 13) < 0.04) c = [26, 28, 40];
        // Ambient occlusion right under a solid.
        if (this.solidCell(world, i, j - 1) && y % CELL === 0) c = [16, 17, 25];
      }
      d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
    }
    this.staticVersion = world.solidVersion;
  }

  draw(world: World, opts: { view: 'normal' | 'pressure' | 'temperature'; brush: { x: number; y: number; r: number; color: RGB } | null; dt?: number }) {
    if (this.staticVersion !== world.solidVersion) this.buildStatic(world);
    const out = this.img.data;
    out.set(this.staticLayer);
    const f = world.fluid;

    const uf = world.unified;
    if (opts.view === 'pressure' && !uf) {
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const c = Math.floor(x / CELL) + Math.floor(y / CELL) * NX;
        if (f.cellType[c] !== AIR || f.region[c] < 0) continue;
        pressureTint(out, (y * W + x) * 4, f.regionGauge[f.region[c]]);
      }
    }

    this.drawWater(world);
    // Unified: the pressure field covers liquid too, so tint after the water (half strength over liquid).
    if (opts.view === 'pressure' && uf) {
      const p = uf.pressure, ct = f.cellType;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const c = Math.floor(x / CELL) + Math.floor(y / CELL) * NX;
        if (ct[c] === SOLID || f.s[c] === 0) continue;
        pressureTint(out, (y * W + x) * 4, p[c] / P0 - 1, ct[c] === GAS ? 1 : 0.5);
      }
    }
    this.drawBurningWood(world);
    if (uf) this.drawVapor(world);
    this.drawSteamAndFire(world);

    if (opts.view === 'temperature') {
      const T = world.thermo.T;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const tint = heatTint(T[Math.floor(x / CELL) + Math.floor(y / CELL) * NX]);
        if (!tint) continue;
        const [col, a] = tint, o = (y * W + x) * 4;
        for (let k = 0; k < 3; k++) out[o + k] = out[o + k] * (1 - a) + col[k] * a;
      }
    }

    for (const e of world.emitters) this.drawFaucet(e.x, e.y, e.w, e.on);
    for (const d of world.drains) this.drawDrain(d.i0 * CELL, (d.j1 + 1) * CELL - 1, (d.i1 - d.i0 + 1) * CELL);
    this.drawGoal(world);

    // No-build zones: red diagonal hatching.
    for (const r of world.level?.puzzle?.noBuild ?? []) {
      for (let y = r.j0 * CELL; y < (r.j1 + 1) * CELL; y++) for (let x = r.i0 * CELL; x < (r.i1 + 1) * CELL; x++) {
        if ((x + y) % 8 !== 0) continue;
        const o = (y * W + x) * 4;
        out[o] = out[o] * 0.5 + 200 * 0.5; out[o + 1] = out[o + 1] * 0.5 + 60 * 0.5; out[o + 2] = out[o + 2] * 0.5 + 60 * 0.5;
      }
    }
    if (opts.brush) this.ring(opts.brush.x, opts.brush.y, opts.brush.r, opts.brush.color);

    this.fx.draw(this.img.data, opts.dt ?? 1 / 60);
    this.ctx.putImageData(this.img, 0, 0);
  }

  private drawWater(world: World) {
    const f = world.fluid, mask = this.water, out = this.img.data;
    const threshold = 0.22 * f.restDensity;
    mask.fill(0);

    // Bulk liquid from the density field, sampled per pixel.
    for (let y = 0; y < H; y++) {
      const fy = (y + 0.5) / CELL - 0.5, j0 = Math.max(0, Math.floor(fy)), j1 = Math.min(NY - 1, j0 + 1), ty = fy - j0;
      for (let x = 0; x < W; x++) {
        const fx = (x + 0.5) / CELL - 0.5, i0 = Math.max(0, Math.floor(fx)), i1 = Math.min(NX - 1, i0 + 1), tx = fx - i0;
        const d = (1 - tx) * (1 - ty) * f.density[i0 + j0 * NX] + tx * (1 - ty) * f.density[i1 + j0 * NX]
          + tx * ty * f.density[i1 + j1 * NX] + (1 - tx) * ty * f.density[i0 + j1 * NX];
        if (d > threshold && f.s[Math.floor(x / CELL) + Math.floor(y / CELL) * NX] !== 0) mask[y * W + x] = 1;
      }
    }
    // Spray: lone droplets the density field is too coarse to show.
    for (let k = 0; k < f.count; k++) {
      const x = Math.floor(f.pos[2 * k]), y = Math.floor(f.pos[2 * k + 1]);
      if (x >= 0 && y >= 0 && x < W && y < H && !mask[y * W + x]) mask[y * W + x] = 2;
    }

    for (let x = 0; x < W; x++) {
      let depth = 0;
      for (let y = 0; y < H; y++) {
        const m = mask[y * W + x];
        const c = Math.floor(x / CELL) + Math.floor(y / CELL) * NX;
        // Depth counts down from the open surface: walls in between don't restart it, only open air does.
        // Water pressed against a ceiling has no surface line, so a wall above starts it at mid-depth.
        if (!m) { if (f.s[c] !== 0) depth = 0; else if (depth < 4) depth = 4; continue; }
        const speed = Math.abs(f.u[c]) + Math.abs(f.v[c]);
        const pal = f.cellOil[c] > 0.5 ? OIL_COLORS : f.cellWax[c] > 0.5 ? WAX_COLORS : WATER;
        let col: RGB;
        const silt = pal === WATER ? world.sediment.avg[c] : 0;
        if (m === 2) col = pal.light;
        else if (depth === 0) col = pal.surface;
        else if (speed > 260 && hash(x, y, Math.floor(world.time * 12)) < 0.5) col = pal.foam;
        else if (depth < 3) col = pal.light;
        else col = depth > 24 ? pal.deep : pal.base;
        // Subtle animated ripple bands in deep liquid.
        if (m === 1 && depth > 4 && hash(Math.floor((x + world.time * 8) / 6), y, 7) < 0.03) col = pal.light;
        // Silt clouds the water toward murky brown.
        if (silt > 0.02) {
          const a = Math.min(0.85, 0.15 + silt * 2.2);
          const mud: RGB = depth === 0 ? [176, 146, 104] : depth > 24 ? [96, 70, 44] : [128, 96, 62];
          col = [col[0] + (mud[0] - col[0]) * a, col[1] + (mud[1] - col[1]) * a, col[2] + (mud[2] - col[2]) * a];
        }
        const o = (y * W + x) * 4;
        // Water is slightly see-through so walls behind it read.
        out[o] = out[o] * 0.15 + col[0] * 0.85;
        out[o + 1] = out[o + 1] * 0.15 + col[1] * 0.85;
        out[o + 2] = out[o + 2] * 0.15 + col[2] * 0.85;
        depth++;
      }
    }
  }

  /**
   * The goal, drawn in the world: a softly tinted target area with a dotted gold border, and a dashed fill line
   * with pennants at the height the water must reach. Green while the goal is met; sparkles once solved.
   */
  private drawGoal(world: World) {
    const goal = world.level?.puzzle?.goal;
    if (!goal) return;
    const out = this.img.data, z = goal.zone, st = world.goal;
    const x0 = z.i0 * CELL, x1 = (z.i1 + 1) * CELL - 1, y0 = z.j0 * CELL, y1 = (z.j1 + 1) * CELL - 1;
    const gold: RGB = [255, 206, 84], green: RGB = [120, 240, 140];
    const col = st.met || st.solved ? green : gold;
    const blend = (x: number, y: number, c: RGB, a: number) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const o = (y * W + x) * 4;
      out[o] += (c[0] - out[o]) * a; out[o + 1] += (c[1] - out[o + 1]) * a; out[o + 2] += (c[2] - out[o + 2]) * a;
    };
    // Faint tint over the open part of the area, and a dotted border.
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (world.fluid.s[Math.floor(x / CELL) + Math.floor(y / CELL) * NX] === 0) continue;
      const edge = x === x0 || x === x1 || y === y0 || y === y1;
      if (edge) { if ((x + y) % 3 === 0) blend(x, y, col, 0.8); }
      else blend(x, y, col, 0.06);
    }
    // Fill line: where `amount` particles of liquid would come up to, at rest density, across the open width.
    let open = 0;
    for (let i = z.i0; i <= z.i1; i++) if (world.fluid.s[i + z.j1 * NX] !== 0) open++;
    const rows = goal.amount / (world.fluid.restDensity * Math.max(1, open));
    const ly = Math.max(y0, Math.round((z.j1 + 1 - rows) * CELL));
    const march = Math.floor(world.time * 6);
    for (let x = x0; x <= x1; x++) {
      if (world.fluid.s[Math.floor(x / CELL) + Math.floor(ly / CELL) * NX] === 0) continue;
      const on = (x + march) % 6 < 4;
      blend(x, ly, on ? col : [40, 30, 10], on ? 0.95 : 0.5);
    }
    // Pennants on both ends of the line.
    const flag = (fx: number, dir: number) => {
      for (let y = ly - 7; y <= ly; y++) blend(fx, y, [220, 220, 230], 0.9); // pole
      for (let r = 0; r < 4; r++) for (let w = 0; w <= 3 - r; w++) { blend(fx + dir * (1 + w), ly - 7 + r, col, 0.95); blend(fx + dir * (1 + w), ly - 1 - r, col, 0); }
    };
    flag(x0 - 2, -1);
    flag(x1 + 2, 1);
    // Sparkles once solved.
    if (st.solved) {
      const t = Math.floor(world.time * 8);
      for (let k = 0; k < 14; k++) {
        const sx = x0 + Math.floor(hash(k, t, 31) * (x1 - x0)), sy = y0 + Math.floor(hash(k, t, 32) * (y1 - y0));
        blend(sx, sy, [255, 255, 220], 1);
        blend(sx - 1, sy, [255, 240, 160], 0.6); blend(sx + 1, sy, [255, 240, 160], 0.6);
        blend(sx, sy - 1, [255, 240, 160], 0.6); blend(sx, sy + 1, [255, 240, 160], 0.6);
      }
    }
  }

  /** Wood chars darker as it burns; burning wood glows with flickering embers. */
  private drawBurningWood(world: World) {
    const th = world.thermo, out = this.img.data, flick = Math.floor(world.time * 10);
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const c = i + j * NX;
      if (th.mat[c] === MUD) {
        // Wet mud is darker.
        const d = 1 - 0.4 * world.sediment.moist[c];
        for (let y = j * CELL; y < (j + 1) * CELL; y++) for (let x = i * CELL; x < (i + 1) * CELL; x++) {
          const o = (y * W + x) * 4;
          out[o] *= d; out[o + 1] *= d; out[o + 2] *= d;
        }
        continue;
      }
      if (th.mat[c] !== WOOD) continue;
      const charred = 1 - th.fuel[c] / WOOD_FUEL;
      // Wood soaked with fuel turns amber; soaked with water, dark.
      const fuelSoak = Math.min(1, th.soak[c] / 2), waterSoak = Math.min(1, th.wet[c] / 2);
      if (fuelSoak > 0.02 || waterSoak > 0.02) for (let y = j * CELL; y < (j + 1) * CELL; y++) for (let x = i * CELL; x < (i + 1) * CELL; x++) {
        const o = (y * W + x) * 4;
        const a = 0.55 * fuelSoak;
        out[o] = out[o] * (1 - a) + 214 * a; out[o + 1] = out[o + 1] * (1 - a) + 170 * a; out[o + 2] = out[o + 2] * (1 - a) + 80 * a;
        const d = 1 - 0.4 * waterSoak;
        out[o] *= d; out[o + 1] *= d; out[o + 2] *= d * 1.05;
      }
      if (charred <= 0 && !th.burning[c]) continue;
      for (let y = j * CELL; y < (j + 1) * CELL; y++) for (let x = i * CELL; x < (i + 1) * CELL; x++) {
        const o = (y * W + x) * 4;
        const dark = 1 - 0.75 * charred;
        out[o] *= dark; out[o + 1] *= dark; out[o + 2] *= dark;
        if (th.burning[c]) {
          const n = hash(x, y, flick);
          const ember: RGB = n < 0.25 ? [255, 210, 90] : n < 0.6 ? [240, 110, 30] : [150, 40, 20];
          const a = 0.35 + 0.5 * charred * n;
          for (let k = 0; k < 3; k++) out[o + k] = out[o + k] * (1 - a) + ember[k] * a;
        }
      }
    }
  }

  /**
   * Unified: water vapor as soft white mist. Density is sampled bilinearly per pixel and quantized with a
   * drifting 4×4 ordered dither, so it reads as pixel-art haze like the classic steam puffs.
   */
  private drawVapor(world: World) {
    const uf = world.unified!, f = world.fluid, out = this.img.data, vap = uf.gasState.vapor, ct = f.cellType;
    const drift = Math.floor(world.time * 6);
    const at = (i: number, j: number) => {
      const c = i + j * NX;
      return ct[c] === GAS ? vap[c] : 0;
    };
    for (let j = 1; j < NY - 1; j++) for (let i = 1; i < NX - 1; i++) {
      const c = i + j * NX;
      if (ct[c] !== GAS) continue;
      // Skip cells with no vapor nearby (the common case) without per-pixel work.
      if (vap[c] + vap[c - 1] + vap[c + 1] + vap[c - NX] + vap[c + NX] < 0.02 * VAPOR_REF) continue;
      for (let y = j * CELL; y < (j + 1) * CELL; y++) {
        const fy = (y + 0.5) / CELL - 0.5, j0 = Math.floor(fy), ty = fy - j0;
        for (let x = i * CELL; x < (i + 1) * CELL; x++) {
          const fx = (x + 0.5) / CELL - 0.5, i0 = Math.floor(fx), tx = fx - i0;
          const v = (1 - tx) * (1 - ty) * at(i0, j0) + tx * (1 - ty) * at(i0 + 1, j0) + tx * ty * at(i0 + 1, j0 + 1) + (1 - tx) * ty * at(i0, j0 + 1);
          const a = Math.min(1, Math.sqrt(Math.max(0, v) / VAPOR_REF));
          if (a < 0.04) continue;
          const b = BAYER[((y + drift) & 3) * 4 + ((x + (drift >> 2)) & 3)];
          const o = (y * W + x) * 4;
          let col: RGB, alpha: number;
          if (b < a * 0.6) { col = [236, 240, 248]; alpha = 0.3 + 0.25 * a; }
          else if (b < a * 1.4) { col = [210, 216, 230]; alpha = 0.12 + 0.12 * a; }
          else continue;
          out[o] += (col[0] - out[o]) * alpha;
          out[o + 1] += (col[1] - out[o + 1]) * alpha;
          out[o + 2] += (col[2] - out[o + 2]) * alpha;
        }
      }
    }
  }

  /** Steam puffs blend toward white; flames go white-yellow → orange → red → smoke as they age. */
  private drawSteamAndFire(world: World) {
    const th = world.thermo, out = this.img.data;
    const blend = (x: number, y: number, c: RGB, a: number) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const o = (y * W + x) * 4;
      out[o] += (c[0] - out[o]) * a;
      out[o + 1] += (c[1] - out[o + 1]) * a;
      out[o + 2] += (c[2] - out[o + 2]) * a;
    };
    for (let k = 0; k < th.steamCount; k++) {
      const x = Math.floor(th.sx[k]), y = Math.floor(th.sy[k]);
      const hot = Math.min(1, Math.max(0, (th.sT[k] - 90) / 30));
      blend(x, y, [236, 240, 248], 0.3 + 0.2 * hot);
      blend(x + ((k & 1) ? 1 : -1), y, [210, 216, 230], 0.18);
      blend(x, y - 1, [210, 216, 230], 0.12);
    }
    const f = world.fluid;
    for (let k = 0; k < f.count; k++) {
      if (f.burn[k] > 0) blend(Math.floor(f.pos[2 * k]), Math.floor(f.pos[2 * k + 1]), [255, 130, 40], 0.7);
    }
    for (let k = 0; k < th.flameCount; k++) {
      const life = th.fLife[k] / th.fMax[k];
      const [c, a]: [RGB, number] = life > 0.75 ? [[255, 244, 170], 0.95] : life > 0.5 ? [[255, 168, 46], 0.9]
        : life > 0.25 ? [[226, 64, 26], 0.8] : [[70, 64, 66], 0.45];
      blend(Math.floor(th.fx[k]), Math.floor(th.fy[k]), c, a);
    }
  }

  private px(x: number, y: number, c: RGB) {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4, d = this.img.data;
    d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2];
  }

  private drawFaucet(x: number, y: number, w: number, on: boolean) {
    // A brass pipe coming in from above, ending in a nozzle.
    const x0 = Math.floor(x) - 2, x1 = Math.floor(x + w) + 1, top = 0, bottom = Math.floor(y) - 1;
    for (let py = top; py <= bottom; py++) for (let px = x0; px <= x1; px++) {
      const edge = px === x0 || px === x1;
      const c: RGB = edge ? [70, 50, 24] : px === x0 + 1 ? [236, 196, 110] : px === x1 - 1 ? [150, 110, 50] : [200, 156, 76];
      this.px(px, py, c);
    }
    for (let px = x0 - 1; px <= x1 + 1; px++) {
      this.px(px, bottom - 3, [70, 50, 24]);
      this.px(px, bottom - 2, [236, 196, 110]);
      this.px(px, bottom - 1, [180, 136, 64]);
      this.px(px, bottom, [70, 50, 24]);
    }
    // Valve light.
    this.px(x1 + 2, bottom - 2, on ? [120, 255, 140] : [255, 80, 70]);
  }

  private drawDrain(x: number, y: number, w: number) {
    for (let px = x; px < x + w; px++) {
      this.px(px, y, px % 3 === 0 ? [20, 20, 26] : [130, 134, 150]);
      this.px(px, y - 1, px % 3 === 0 ? [20, 20, 26] : [90, 94, 110]);
    }
  }

  private ring(cx: number, cy: number, r: number, c: RGB) {
    const steps = Math.max(12, Math.round(r * 6));
    for (let k = 0; k < steps; k++) {
      if (k % 2) continue;
      const a = (k / steps) * Math.PI * 2;
      this.px(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r), c);
    }
  }
}
