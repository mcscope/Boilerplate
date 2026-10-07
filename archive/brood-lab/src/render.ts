import { Genome } from './genes';
import { Creature, Exit, GH, GW, Lab, PEN_NAMES, Pen, REGROW_TIME, TILE, TileKind } from './lab';

/** Screen pixels per tile. Pens render at this resolution and are scaled up with no smoothing. */
export const PX = 16;
export const VIEW_W = GW * PX;
export const VIEW_H = GH * PX;
const S = PX / TILE; // world units → screen pixels

type RGB = [number, number, number];

function hash(a: number, b: number, c = 0) {
  let h = Math.imul(a, 374761393) ^ Math.imul(b, 668265263) ^ Math.imul(c, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function hsl(h: number, s: number, l: number): RGB {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/** Thin wrapper for writing pixels into ImageData. */
class Pix {
  readonly w: number;
  readonly h: number;
  constructor(readonly img: ImageData) {
    this.w = img.width;
    this.h = img.height;
  }
  set(x: number, y: number, c: RGB) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4, d = this.img.data;
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
  }
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, 1, 1);
}

// ---- Small hand-drawn sprites ----

function spriteFromArt(art: string[], palette: Record<string, RGB>) {
  const c = document.createElement('canvas');
  c.width = art[0].length;
  c.height = art.length;
  const ctx = c.getContext('2d')!;
  const p = new Pix(ctx.createImageData(c.width, c.height));
  art.forEach((row, y) => [...row].forEach((ch, x) => { if (palette[ch]) p.set(x, y, palette[ch]); }));
  ctx.putImageData(p.img, 0, 0);
  return c;
}

const PLANT: Record<string, RGB> = {
  o: [24, 36, 18], d: [38, 74, 34], g: [64, 122, 48], l: [112, 170, 66], r: [214, 58, 74], R: [255, 170, 170],
};

const BUSH = spriteFromArt([
  '...oooooo...',
  '..ogglggdo..',
  '.ogllgRrgdo.',
  'ogRrggrrgdgo',
  'oglrrgglgddo',
  'oggggdgRrddo',
  'odgRrgddrrdo',
  '.odrrddgdddo',
  '..oddddddoo.',
  '...oooooo...',
], PLANT);

const BUSH_MID = spriteFromArt([
  '...oooo...',
  '..ogglgo..',
  '.oglggddo.',
  'ogglgdgddo',
  'odggddgddo',
  '.oddddddo.',
  '..oooooo..',
], PLANT);

const SPROUT = spriteFromArt([
  '.l...l.',
  'lgl.lgl',
  '.og.go.',
  '..ogo..',
  '...g...',
], PLANT);

const FONT: Record<string, string[]> = {
  A: ['.#.', '#.#', '###', '#.#', '#.#'],
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  C: ['.##', '#..', '#..', '#..', '.##'],
  D: ['##.', '#.#', '#.#', '#.#', '##.'],
  '?': ['##.', '..#', '.#.', '...', '.#.'],
};

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16);

// ---- Tiles ----

const CREEP: RGB = [44, 31, 46];

function floorTile(p: Pix, ox: number, oy: number, col: number, row: number) {
  for (let y = 0; y < PX; y++) for (let x = 0; x < PX; x++) {
    const gx = col * PX + x, gy = row * PX + y;
    const n = hash(gx, gy, 1);
    let c: RGB = n < 0.07 ? [54, 39, 56] : n > 0.96 ? [32, 22, 34] : CREEP;
    // Organic veins that run continuously across tiles.
    const v = Math.sin(gx * 0.31 + Math.sin(gy * 0.23) * 2.4 + Math.sin(gx * 0.07) * 3);
    if (Math.abs(v) < 0.08) c = hash(gx, gy, 2) < 0.5 ? [78, 40, 82] : [64, 34, 68];
    p.set(ox + x, oy + y, c);
  }
  if (hash(col, row, 7) < 0.35) {
    const x = ox + 2 + Math.floor(hash(col, row, 8) * 11), y = oy + 2 + Math.floor(hash(col, row, 9) * 11);
    p.set(x, y, [88, 74, 82]); p.set(x + 1, y, [66, 56, 62]); p.set(x, y + 1, [58, 48, 54]); p.set(x + 1, y + 1, [28, 20, 30]);
  }
}

function wallTile(p: Pix, ox: number, oy: number, col: number, row: number, isWall: (c: number, r: number) => boolean) {
  const up = isWall(col, row - 1), down = isWall(col, row + 1), left = isWall(col - 1, row), right = isWall(col + 1, row);
  for (let y = 0; y < PX; y++) for (let x = 0; x < PX; x++) {
    const n = hash(col * PX + x, row * PX + y, 3);
    let c: RGB = n < 0.1 ? [100, 84, 96] : n > 0.92 ? [72, 58, 70] : [88, 72, 84];
    if ((y + (col % 2) * 3) % 6 === 0) c = [64, 50, 62]; // chitin plate seams
    if ((y + (col % 2) * 3) % 6 === 1) c = [108, 92, 104];
    if (!left && x === 0) c = [36, 26, 36];
    if (!right && x === PX - 1) c = [36, 26, 36];
    if (!up && y < 4) c = y === 0 ? [36, 26, 36] : y === 1 ? [164, 142, 152] : [128, 110, 122]; // lit top face
    if (!down && y >= 12) c = y === PX - 1 ? [18, 12, 20] : [50, 38, 50]; // front face in shadow
    p.set(ox + x, oy + y, c);
  }
}

function spike(p: Pix, ox: number, oy: number, cx: number, by: number, h: number, hw: number) {
  for (let i = 0; i < h; i++) {
    const w = Math.round(hw * (1 - i / h));
    for (let x = -w; x <= w; x++) {
      const edge = w > 0 && (x === -w || x === w);
      const c: RGB = edge ? [40, 26, 30] : x < 0 ? [236, 222, 188] : x === 0 ? [204, 184, 152] : [150, 126, 104];
      p.set(ox + cx + x, oy + by - i, c);
    }
  }
  for (let x = -hw - 1; x <= hw + 1; x++) p.set(ox + cx + x, oy + by + 1, [24, 16, 24]);
}

function spikesTile(p: Pix, ox: number, oy: number) {
  for (let y = 0; y < PX; y++) for (let x = 0; x < PX; x++) if (hash(ox + x, oy + y, 4) < 0.25) p.set(ox + x, oy + y, [60, 26, 34]);
  spike(p, ox, oy, 8, 6, 6, 1);
  spike(p, ox, oy, 12, 11, 7, 2);
  spike(p, ox, oy, 4, 13, 8, 2);
}

function foodTile(p: Pix, ox: number, oy: number) {
  for (let y = 0; y < PX; y++) for (let x = 0; x < PX; x++) {
    const d = ((x - 7.5) / 7.5) ** 2 + ((y - 9) / 6.5) ** 2;
    if (d > 1) continue;
    const c: RGB = d > 0.8 ? [36, 26, 20] : hash(ox + x, oy + y, 5) < 0.15 ? [86, 62, 42] : [62, 44, 32];
    p.set(ox + x, oy + y, c);
  }
}

function lureTile(p: Pix, ox: number, oy: number) {
  for (const [x, y] of [[3, 13], [2, 14], [12, 13], [13, 14], [4, 4], [12, 3]]) p.set(ox + x, oy + y, [90, 40, 80]);
  for (let y = 0; y < PX; y++) for (let x = 0; x < PX; x++) {
    const d = Math.hypot(x - 7.5, y - 8.5);
    if (d > 5.6) continue;
    let c: RGB = d > 4.8 ? [40, 16, 36] : [150, 60, 120];
    if (d <= 4.8 && x + y < 13) c = [196, 96, 156];
    if (d < 2) c = [240, 236, 140];
    p.set(ox + x, oy + y, c);
  }
}

function doorTile(p: Pix, ox: number, oy: number, to?: number) {
  for (let y = 0; y < PX; y++) for (let x = 0; x < PX; x++) {
    const d = Math.hypot(x - 7.5, (y - 7.5) / 1.08);
    let c: RGB | null = null;
    if (d <= 4.6) c = BAYER[(x & 3) + (y & 3) * 4] < 0.2 ? [26, 60, 76] : [10, 26, 36];
    else if (d <= 6.4) c = y < 7 ? [150, 230, 240] : [80, 170, 190];
    else if (d <= 7.3) c = [16, 30, 40];
    if (c) p.set(ox + x, oy + y, c);
  }
  const glyph = FONT[to === undefined ? '?' : PEN_NAMES[to]];
  glyph.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === '#') p.set(ox + 6 + x, oy + 5 + y, [210, 250, 255]); }));
}

function drawTileAt(p: Pix, ox: number, oy: number, col: number, row: number, kind: TileKind, isWall: (c: number, r: number) => boolean, doorTo?: number) {
  if (kind === 'wall') return wallTile(p, ox, oy, col, row, isWall);
  floorTile(p, ox, oy, col, row);
  if (kind === 'spikes') spikesTile(p, ox, oy);
  else if (kind === 'food') foodTile(p, ox, oy);
  else if (kind === 'lure') lureTile(p, ox, oy);
  else if (kind === 'door') doorTile(p, ox, oy, doorTo);
}

/** Draws one tile (as a toolbar icon) into a PX×PX canvas. */
export function drawSwatch(canvas: HTMLCanvasElement, kind: TileKind) {
  const ctx = canvas.getContext('2d')!;
  const p = new Pix(ctx.createImageData(PX, PX));
  drawTileAt(p, 0, 0, 3, 3, kind, () => false, 1);
  ctx.putImageData(p.img, 0, 0);
  if (kind === 'food') ctx.drawImage(BUSH, 2, 3);
}

const tileLayers = new Map<Pen, { canvas: HTMLCanvasElement; version: number }>();

function tileLayer(pen: Pen) {
  let layer = tileLayers.get(pen);
  if (!layer) {
    const canvas = document.createElement('canvas');
    canvas.width = VIEW_W;
    canvas.height = VIEW_H;
    layer = { canvas, version: -1 };
    tileLayers.set(pen, layer);
  }
  if (layer.version !== pen.version) {
    const ctx = layer.canvas.getContext('2d')!;
    const p = new Pix(ctx.createImageData(VIEW_W, VIEW_H));
    const isWall = (c: number, r: number) => c < 0 || r < 0 || c >= GW || r >= GH || pen.tiles[r * GW + c] === 'wall';
    for (let r = 0; r < GH; r++) for (let c = 0; c < GW; c++) {
      const i = r * GW + c;
      drawTileAt(p, c * PX, r * PX, c, r, pen.tiles[i], isWall, pen.doors.get(i)?.pen);
    }
    ctx.putImageData(p.img, 0, 0);
    layer.version = pen.version;
  }
  return layer.canvas;
}

// ---- Creature sprites, generated from genes ----

const enum Mat { None, Leg, Bone, Plate, Body, Head, Eye }

interface Shape {
  r: number;
  pairs: number;
  legLen: number;
  clawLen: number;
  clawW: number;
  bladeLen: number;
  plates: number;
  abdRx: number;
  armor: number;
}

function shapeOf(g: Genome): Shape {
  const r = 4 + g.size * 5;
  return {
    r,
    pairs: 2 + Math.round(g.speed * 2),
    legLen: r * (0.7 + g.speed * 0.9),
    clawLen: 1.5 + g.bite * r * 0.9,
    clawW: 0.45 + g.bite * 0.35,
    bladeLen: g.bite > 0.4 ? (g.bite - 0.3) * r * 1.6 : 0,
    plates: Math.round(g.armor * 4),
    abdRx: r * (0.85 + g.size * 0.2),
    armor: g.armor,
  };
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** What the creature is made of at local point (lx, ly), facing +x. k = pixels per world unit. */
function materialAt(sh: Shape, lx: number, ly: number, frame: number, k: number): Mat {
  const { r } = sh;
  const ay = Math.abs(ly);
  const side = ly < 0 ? 0 : 1;
  if (Math.hypot(lx - r * 1.15, ay - r * 0.24) * k < 0.8) return Mat.Eye;
  if (Math.hypot(lx - r * 0.98, ly) < r * 0.45) return Mat.Head;
  if (((lx - r * 0.3) / (r * 0.55)) ** 2 + (ly / (r * 0.62)) ** 2 <= 1) return sh.armor > 0.6 ? Mat.Plate : Mat.Body;
  const ax = -r * 0.6;
  if (((lx - ax) / sh.abdRx) ** 2 + (ly / (r * 0.78)) ** 2 <= 1) {
    if (sh.plates > 0) {
      const spacing = (2 * sh.abdRx) / (sh.plates + 1);
      const band = (lx - (ax - sh.abdRx)) / spacing;
      const nearest = Math.round(band);
      if (nearest >= 1 && nearest <= sh.plates && Math.abs(band - nearest) * spacing * k < 0.75) return Mat.Plate;
    }
    return Mat.Body;
  }
  const c = sh.clawLen;
  const m = [r * 1.25, r * 0.28, r * 1.25 + c * 0.6, r * 0.28 + c * 0.45, r * 1.25 + c, r * 0.02];
  if (Math.min(segDist(lx, ay, m[0], m[1], m[2], m[3]), segDist(lx, ay, m[2], m[3], m[4], m[5])) * k < sh.clawW) return Mat.Bone;
  if (sh.bladeLen > 0) {
    const b = sh.bladeLen;
    const bl = [r * 0.2, r * 0.4, -r * 0.3, r * 0.95 + b * 0.3, -r * 0.8 - b * 0.7, r * 0.9 + b * 0.75];
    if (Math.min(segDist(lx, ay, bl[0], bl[1], bl[2], bl[3]), segDist(lx, ay, bl[2], bl[3], bl[4], bl[5])) * k < 0.65) return Mat.Bone;
  }
  for (let i = 0; i < sh.pairs; i++) {
    const hipX = r * 0.45 - (i / (sh.pairs - 1)) * r * 1.2;
    const swing = ((i + side + frame) % 2 ? 1 : -1) * r * 0.25;
    const reach = (i < sh.pairs / 2 ? 1 : -1) * sh.legLen * 0.3;
    const kx = hipX + swing * 0.4, ky = r * 0.5 + sh.legLen * 0.55;
    const fx = kx + reach + swing, fy = ky + sh.legLen * 0.25;
    if (Math.min(segDist(lx, ay, hipX, r * 0.45, kx, ky), segDist(lx, ay, kx, ky, fx, fy)) * k < 0.6) return Mat.Leg;
  }
  return Mat.None;
}

function buildSprite(g: Genome, angle: number, frame: number, k: number, starving: boolean) {
  const sh = shapeOf(g);
  const reach = Math.max(sh.r * 1.3 + sh.clawLen, sh.r * 0.6 + sh.legLen * 0.9, sh.r * 1.2 + sh.bladeLen);
  const size = Math.ceil(reach * k * 2) + 4;
  const mats = new Uint8Array(size * size);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const dx = i + 0.5 - size / 2, dy = j + 0.5 - size / 2;
    mats[j * size + i] = materialAt(sh, (dx * cos + dy * sin) / k, (-dx * sin + dy * cos) / k, frame, k);
  }

  const hue = (270 + g.fertility * 110) % 360; // violet → pink → ember as fertility rises
  const sat = starving ? 0.12 : 0.5;
  const pal = {
    outline: hsl(hue, 0.45, 0.07),
    shade: hsl(hue, sat, 0.2),
    base: hsl(hue, sat, 0.32),
    light: hsl(hue, sat + 0.1, 0.47),
    leg: hsl(hue, 0.25, 0.42),
    bone: [236, 220, 180] as RGB,
    boneShade: [158, 132, 98] as RGB,
    eye: (g.bite > 0.6 ? [255, 84, 60] : [255, 222, 90]) as RGB,
  };

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const p = new Pix(ctx.createImageData(size, size));
  const at = (i: number, j: number) => (i < 0 || j < 0 || i >= size || j >= size ? Mat.None : mats[j * size + i]);
  const solid = (m: Mat) => m >= Mat.Bone;
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const m = mats[j * size + i];
    if (m === Mat.None) {
      if (solid(at(i - 1, j)) || solid(at(i + 1, j)) || solid(at(i, j - 1)) || solid(at(i, j + 1))) p.set(i, j, pal.outline);
      continue;
    }
    // Light comes from the top-left: edges facing it are lit, edges facing away are shaded.
    const lit = !solid(at(i, j - 1)) || !solid(at(i - 1, j));
    const dark = !solid(at(i, j + 1)) || !solid(at(i + 1, j));
    let c: RGB;
    switch (m) {
      case Mat.Leg: c = pal.leg; break;
      case Mat.Eye: c = pal.eye; break;
      case Mat.Bone: case Mat.Plate: c = dark ? pal.boneShade : pal.bone; break;
      case Mat.Head: c = lit && !dark ? pal.base : pal.shade; break;
      default: c = dark ? pal.shade : lit ? pal.light : pal.base;
    }
    p.set(i, j, c);
  }
  ctx.putImageData(p.img, 0, 0);
  return canvas;
}

const DIRS = 16;
const SPRITE_K = S * 1.6; // sprites are drawn a bit larger than their collision size so they read clearly
const spriteCache = new WeakMap<Creature, Map<number, HTMLCanvasElement>>();

function spriteFor(c: Creature, frame: number, juvenile: boolean, starving: boolean) {
  let cache = spriteCache.get(c);
  if (!cache) spriteCache.set(c, (cache = new Map()));
  const dir = ((Math.round((c.angle / (Math.PI * 2)) * DIRS) % DIRS) + DIRS) % DIRS;
  const key = dir * 8 + frame * 4 + (juvenile ? 2 : 0) + (starving ? 1 : 0);
  let sprite = cache.get(key);
  if (!sprite) {
    sprite = buildSprite(c.genome, (dir / DIRS) * Math.PI * 2, frame, SPRITE_K * (juvenile ? 0.65 : 1), starving);
    cache.set(key, sprite);
  }
  return sprite;
}

/** Midpoint circle, one pixel thick. `dash` skips every other step for a dotted ring. */
function pixelRing(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string, dash = false) {
  ctx.fillStyle = color;
  let x = r, y = 0, err = 1 - r, n = 0;
  while (x >= y) {
    if (!dash || n++ % 2 === 0) {
      for (const [a, b] of [[x, y], [y, x], [-y, x], [-x, y], [-x, -y], [-y, -x], [y, -x], [x, -y]]) ctx.fillRect(cx + a, cy + b, 1, 1);
    }
    y++;
    if (err < 0) err += 2 * y + 1;
    else { x--; err += 2 * (y - x) + 1; }
  }
}

function exitMarker(ctx: CanvasRenderingContext2D, wx: number, wy: number, fromPen: number, color: string) {
  const cx = Math.round(wx * S), cy = Math.round(wy * S);
  pixelRing(ctx, cx, cy, 5, '#0b1a22');
  pixelRing(ctx, cx, cy, 4, color);
  ctx.fillStyle = color;
  FONT[PEN_NAMES[fromPen]].forEach((row, y) => [...row].forEach((ch, x) => { if (ch === '#') ctx.fillRect(cx - 1 + x, cy - 2 + y, 1, 1); }));
}

// ---- Pen ----

export interface Ghost { x: number; y: number; creature: Creature }

export function drawPen(
  ctx: CanvasRenderingContext2D,
  lab: Lab,
  pen: number,
  selected: Set<number>,
  hovered: Creature | null,
  box: { x0: number; y0: number; x1: number; y1: number } | null,
  brush: { cells: number[]; erase: boolean } | null,
  ghosts: Ghost[],
  doorUi: { pending: { pen: number; tile: number } | null; preview: Exit | null },
) {
  ctx.imageSmoothingEnabled = false;
  const p = lab.pens[pen];
  ctx.drawImage(tileLayer(p), 0, 0);

  // Lures: a pulsing, dithered glow.
  const pulse = 0.5 + 0.5 * Math.sin(lab.time * 3);
  for (const l of p.lures) {
    const cx = Math.floor(l.x * S), cy = Math.floor(l.y * S), R = 11;
    for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) {
      const d = Math.hypot(x, y) / R;
      if (d > 1 || d < 0.3) continue;
      if (BAYER[((cx + x) & 3) + ((cy + y) & 3) * 4] < (1 - d) * (0.35 + 0.4 * pulse)) dot(ctx, cx + x, cy + y, 'rgba(240,240,130,0.45)');
    }
    if (pulse > 0.5) { ctx.fillStyle = '#fffbd0'; ctx.fillRect(cx - 1, cy, 2, 2); }
  }

  // Door exits that land in this pen: a cyan ring tagged with the pen the door is in.
  const blink = Math.floor(lab.time * 4) % 2 === 0;
  lab.pens.forEach((src, si) => src.doors.forEach(ex => {
    if (ex.pen === pen) exitMarker(ctx, ex.x, ex.y, si, '#6cc6d8');
  }));
  if (doorUi.preview?.pen === pen) exitMarker(ctx, doorUi.preview.x, doorUi.preview.y, doorUi.pending!.pen, '#ffd84a');
  if (doorUi.pending?.pen === pen && blink) {
    const x = (doorUi.pending.tile % GW) * PX, y = Math.floor(doorUi.pending.tile / GW) * PX;
    ctx.fillStyle = '#ffd84a';
    ctx.fillRect(x, y, PX, 1); ctx.fillRect(x, y + PX - 1, PX, 1); ctx.fillRect(x, y, 1, PX); ctx.fillRect(x + PX - 1, y, 1, PX);
  }

  // Food patches: berry bush when ready, smaller stages while regrowing.
  for (const i of p.foods) {
    const left = (p.growth[i] * p.regrow) / REGROW_TIME;
    const sprite = left <= 0 ? BUSH : left < 0.5 ? BUSH_MID : SPROUT;
    const x = (i % GW) * PX + Math.floor((PX - sprite.width) / 2), y = Math.floor(i / GW) * PX + PX - 3 - sprite.height;
    ctx.drawImage(sprite, x, y);
  }

  for (const s of lab.splats) {
    if (s.pen !== pen) continue;
    const cx = Math.round(s.x * S), cy = Math.round(s.y * S), R = Math.max(2, Math.round(s.r * S));
    ctx.globalAlpha = Math.min(0.8, s.t / 4);
    const seed = Math.round(s.x * 7 + s.y * 13);
    for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) {
      if (hash(x, y, seed) < 1 - Math.hypot(x, y) / R) dot(ctx, cx + x, cy + y, s.color);
    }
    ctx.globalAlpha = 1;
  }

  const creatures = lab.creatures.filter(c => c.pen === pen).sort((a, b) => a.y - b.y);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  for (const c of creatures) {
    const cx = Math.round(c.x * S), cy = Math.round(c.y * S) + 2, w = Math.round(c.stats.radius * S * 1.4);
    ctx.fillRect(cx - w, cy, w * 2, 2);
    ctx.fillRect(cx - w + 1, cy + 2, w * 2 - 2, 1);
  }
  for (const c of creatures) {
    const juvenile = c.age < 12;
    const starving = c.energy < c.stats.maxEnergy * 0.25;
    const frame = Math.floor(lab.time * (4 + c.stats.speed / 12) + c.id * 0.37) % 2;
    const sprite = spriteFor(c, frame, juvenile, starving);
    const cx = Math.round(c.x * S), cy = Math.round(c.y * S);
    ctx.globalAlpha = ghosts.some(g => g.creature === c) ? 0.35 : 1;
    ctx.drawImage(sprite, cx - sprite.width / 2, cy - sprite.height / 2);
    ctx.globalAlpha = 1;
    if (selected.has(c.id) || c === hovered) {
      const R = Math.round(c.stats.radius * SPRITE_K * (juvenile ? 0.65 : 1) * 1.3) + 3;
      pixelRing(ctx, cx, cy, R, selected.has(c.id) ? '#ffd84a' : '#ffffff', !selected.has(c.id));
    }
  }

  // Creatures being carried: drawn where they'll land.
  for (const g of ghosts) {
    const sprite = spriteFor(g.creature, 0, g.creature.age < 12, false);
    const cx = Math.round(g.x * S), cy = Math.round(g.y * S);
    ctx.globalAlpha = 0.85;
    ctx.drawImage(sprite, cx - sprite.width / 2, cy - sprite.height / 2);
    ctx.globalAlpha = 1;
    pixelRing(ctx, cx, cy, Math.round(g.creature.stats.radius * SPRITE_K * 1.3) + 3, '#ffd84a', true);
  }

  if (box) {
    // Marching ants.
    const x0 = Math.round(Math.min(box.x0, box.x1) * S), x1 = Math.round(Math.max(box.x0, box.x1) * S);
    const y0 = Math.round(Math.min(box.y0, box.y1) * S), y1 = Math.round(Math.max(box.y0, box.y1) * S);
    const phase = Math.floor(lab.time * 10);
    const ant = (x: number, y: number) => dot(ctx, x, y, (x + y + phase) % 4 < 2 ? '#ffd84a' : '#3a2a10');
    for (let x = x0; x <= x1; x++) { ant(x, y0); ant(x, y1); }
    for (let y = y0; y <= y1; y++) { ant(x0, y); ant(x1, y); }
  }

  if (brush) {
    ctx.fillStyle = brush.erase ? 'rgba(255,120,110,0.18)' : 'rgba(255,255,255,0.14)';
    for (const i of brush.cells) ctx.fillRect((i % GW) * PX, Math.floor(i / GW) * PX, PX, PX);
    const set = new Set(brush.cells);
    ctx.fillStyle = brush.erase ? '#ff7a6e' : '#ffffff';
    for (const i of brush.cells) {
      const x = (i % GW) * PX, y = Math.floor(i / GW) * PX, c = i % GW;
      if (!set.has(i - GW)) ctx.fillRect(x, y, PX, 1);
      if (!set.has(i + GW)) ctx.fillRect(x, y + PX - 1, PX, 1);
      if (c === 0 || !set.has(i - 1)) ctx.fillRect(x, y, 1, PX);
      if (c === GW - 1 || !set.has(i + 1)) ctx.fillRect(x + PX - 1, y, 1, PX);
    }
  }
}
