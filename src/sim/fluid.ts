/**
 * FLIP liquid on a staggered (MAC) grid, after Matthias Müller's "Ten Minute Physics" FLIP solver.
 * Particles carry the liquid; the grid enforces incompressibility, which gives real pressure:
 * water levels out in U-tubes and siphons pull.
 *
 * Coordinates are in pixels, y points down. Cell (i, j) covers [i*h, (i+1)*h) × [j*h, (j+1)*h).
 * u[i, j] lives on the left face of the cell, v[i, j] on the top face.
 */

export const FLUID = 0;
const MAX_SPEED = 1500; // px/s safety cap
export const AIR = 1;
export const SOLID = 2;

/** Liquid kinds carried by particles. */
export const WATER = 0;
export const OIL = 1;
export const WAX = 2;
/** Relative density per liquid kind: oil floats on molten wax, which floats on water. */
export const LIQUID_DENSITY = [1, 0.7, 0.9];
/**
 * Hot liquid is lighter (exaggerated for gameplay), which drives convection: hot water rises. Per liquid kind:
 * molten wax expands far more with heat than water or oil (as real paraffin does), so warm wax is lighter than
 * the lamp oil and cooler wax is heavier: that crossover is what makes a lava lamp work.
 */
const THERMAL_EXPANSION = [0.0015, 0.0015, 0.0056];
/** Suspended silt makes water heavier, so muddy water sinks under clear water. */
const SILT_DENSITY = 0.25;
function particleDensity(kind: number, temp: number, silt: number) {
  const t = temp < 0 ? 0 : temp > 100 ? 100 : temp;
  return LIQUID_DENSITY[kind] * (1 - THERMAL_EXPANSION[kind] * (t - 20)) * (1 + SILT_DENSITY * silt);
}

/** Surface tension: how strongly nearby particles of the same liquid pull together, and out to what distance (in radii). */
const COHESION = 0.08;
const COHESION_RANGE = 3.5;

export interface FluidParams {
  gravity: number; // px/s²
  flipRatio: number; // 0 = PIC (viscous, stable), 1 = FLIP (lively, noisy)
  pressureIters: number;
  separationIters: number;
  overRelaxation: number;
  substeps: number;
}

export const DEFAULT_PARAMS: FluidParams = {
  gravity: 800,
  flipRatio: 0.9,
  pressureIters: 50,
  separationIters: 1,
  overRelaxation: 1.9,
  substeps: 2,
};

export abstract class Fluid {
  readonly nx: number;
  readonly ny: number;
  readonly h: number;
  protected readonly inv: number;

  // Grid
  u: Float32Array;
  v: Float32Array;
  protected du: Float32Array;
  protected dv: Float32Array;
  protected prevU: Float32Array;
  protected prevV: Float32Array;
  p: Float32Array;
  /** 0 = solid, 1 = open. */
  s: Float32Array;
  cellType: Int32Array;
  density: Float32Array;
  readonly restDensity: number;
  /** Fraction of each cell's liquid that is oil / molten wax (0..1). */
  cellOil: Float32Array;
  cellWax: Float32Array;
  protected waxDensity: Float32Array;
  protected massDensity: Float32Array;
  /** Mass density of each liquid cell (water = 1). */
  cellRho: Float32Array;
  protected oilDensity: Float32Array;
  // Air connectivity (the gas itself lives in UnifiedFluid).
  /** Air region id per cell (-1 if not air). */
  region: Int32Array;
  /** Per region id: whether it connects to the open top (atmosphere). */
  regionAtmosphere: boolean[] = [];
  /** If true, the air region touching the top row is open atmosphere, fixed at atmospheric pressure. */
  openTop = true;
  protected prevType: Int32Array;
  protected gasReady = false;
  protected queue: Int32Array;

  // Particles
  readonly maxParticles: number;
  readonly radius: number;
  count = 0;
  pos: Float32Array;
  vel: Float32Array;
  /** Liquid kind per particle (WATER / OIL). */
  kind: Uint8Array;
  /** Temperature per particle, °C. */
  temp: Float32Array;
  /** Seconds of burning left (oil only); 0 = not burning. */
  burn: Float32Array;
  /** Suspended silt per particle (water only), 0..1. */
  silt: Float32Array;
  protected prePos: Float32Array;

  // Spatial hash for particle separation
  protected readonly pInv: number;
  protected readonly pnx: number;
  protected readonly pny: number;
  protected cellCount: Int32Array;
  protected firstCell: Int32Array;
  protected cellIds: Int32Array;

  params: FluidParams = { ...DEFAULT_PARAMS };

  constructor(nx: number, ny: number, h: number, maxParticles: number) {
    this.nx = nx;
    this.ny = ny;
    this.h = h;
    this.inv = 1 / h;
    const n = nx * ny;
    this.u = new Float32Array(n);
    this.v = new Float32Array(n);
    this.du = new Float32Array(n);
    this.dv = new Float32Array(n);
    this.prevU = new Float32Array(n);
    this.prevV = new Float32Array(n);
    this.p = new Float32Array(n);
    this.s = new Float32Array(n).fill(1);
    this.cellType = new Int32Array(n);
    this.density = new Float32Array(n);
    this.cellOil = new Float32Array(n);
    this.cellWax = new Float32Array(n);
    this.waxDensity = new Float32Array(n);
    this.massDensity = new Float32Array(n);
    this.cellRho = new Float32Array(n).fill(1);
    this.oilDensity = new Float32Array(n);
    this.region = new Int32Array(n);
    this.prevType = new Int32Array(n);
    this.queue = new Int32Array(n);

    this.maxParticles = maxParticles;
    this.radius = 0.3 * h;
    this.restDensity = (h / (2 * this.radius)) ** 2;
    this.pos = new Float32Array(2 * maxParticles);
    this.vel = new Float32Array(2 * maxParticles);
    this.kind = new Uint8Array(maxParticles);
    this.temp = new Float32Array(maxParticles);
    this.burn = new Float32Array(maxParticles);
    this.silt = new Float32Array(maxParticles);
    this.prePos = new Float32Array(2 * maxParticles);

    this.pInv = 1 / (2.2 * this.radius);
    this.pnx = Math.floor(nx * h * this.pInv) + 1;
    this.pny = Math.floor(ny * h * this.pInv) + 1;
    this.cellCount = new Int32Array(this.pnx * this.pny);
    this.firstCell = new Int32Array(this.pnx * this.pny + 1);
    this.cellIds = new Int32Array(maxParticles);

    this.sealBorder();
  }

  idx(i: number, j: number) {
    return i + j * this.nx;
  }

  /** The outermost ring of cells is always solid. */
  sealBorder() {
    for (let i = 0; i < this.nx; i++) { this.s[this.idx(i, 0)] = 0; this.s[this.idx(i, this.ny - 1)] = 0; }
    for (let j = 0; j < this.ny; j++) { this.s[this.idx(0, j)] = 0; this.s[this.idx(this.nx - 1, j)] = 0; }
  }

  setSolid(i: number, j: number, solid: boolean) {
    if (i <= 0 || j <= 0 || i >= this.nx - 1 || j >= this.ny - 1) return;
    this.s[this.idx(i, j)] = solid ? 0 : 1;
  }

  solidAt(x: number, y: number) {
    const i = Math.floor(x * this.inv), j = Math.floor(y * this.inv);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return true;
    return this.s[i + j * this.nx] === 0;
  }

  addParticle(x: number, y: number, vx = 0, vy = 0, kind = WATER, temp = 20, silt = 0) {
    if (this.count >= this.maxParticles || this.solidAt(x, y)) return false;
    const k = this.count++;
    this.pos[2 * k] = x;
    this.pos[2 * k + 1] = y;
    this.vel[2 * k] = vx;
    this.vel[2 * k + 1] = vy;
    this.kind[k] = kind;
    this.temp[k] = temp;
    this.burn[k] = 0;
    this.silt[k] = silt;
    return true;
  }

  removeParticle(k: number) {
    const last = --this.count;
    this.pos[2 * k] = this.pos[2 * last];
    this.pos[2 * k + 1] = this.pos[2 * last + 1];
    this.vel[2 * k] = this.vel[2 * last];
    this.vel[2 * k + 1] = this.vel[2 * last + 1];
    this.kind[k] = this.kind[last];
    this.temp[k] = this.temp[last];
    this.burn[k] = this.burn[last];
    this.silt[k] = this.silt[last];
  }

  /** Remove every particle for which `pred` is true. */
  removeWhere(pred: (x: number, y: number) => boolean) {
    for (let k = this.count - 1; k >= 0; k--) if (pred(this.pos[2 * k], this.pos[2 * k + 1])) this.removeParticle(k);
  }

  clearParticles() {
    this.gasReady = false;
    this.count = 0;
    this.u.fill(0);
    this.v.fill(0);
  }

  /** Recompute the grid's view of the liquid (cell types, density) without moving anything, e.g. after loading. */
  refreshFields() {
    this.transfer(true);
    this.updateDensity();
  }

  /** Advance the simulation by dt seconds (UnifiedFluid). */
  abstract step(dt: number): void;

  /** Gravity + movement, stepped in sub-cell increments so fast particles can't tunnel through thin walls. */
  protected integrate(dt: number) {
    const g = this.params.gravity, maxStep = 0.5 * this.h;
    for (let k = 0; k < this.count; k++) {
      let x = this.pos[2 * k], y = this.pos[2 * k + 1];
      let vx = this.vel[2 * k], vy = this.vel[2 * k + 1] + g * dt;
      const steps = Math.max(1, Math.ceil((Math.abs(vx) + Math.abs(vy)) * dt / maxStep));
      const sx = (vx * dt) / steps, sy = (vy * dt) / steps;
      let hitX = false, hitY = false;
      for (let n = 0; n < steps; n++) {
        if (!hitX) { if (this.solidAt(x + sx, y)) hitX = true; else x += sx; }
        if (!hitY) { if (this.solidAt(x, y + sy)) hitY = true; else y += sy; }
      }
      if (hitX) vx = 0;
      if (hitY) vy = 0;
      this.pos[2 * k] = x;
      this.pos[2 * k + 1] = y;
      this.vel[2 * k] = vx;
      this.vel[2 * k + 1] = vy;
    }
  }

  /** Push overlapping particles apart (keeps the liquid from clumping), then undo any push into a wall. */
  protected separate(iters: number) {
    const { pnx, pny, pInv, cellCount, firstCell, cellIds, pos } = this;
    this.prePos.set(pos.subarray(0, 2 * this.count));
    cellCount.fill(0);
    for (let k = 0; k < this.count; k++) {
      const xi = clampi(Math.floor(pos[2 * k] * pInv), 0, pnx - 1), yi = clampi(Math.floor(pos[2 * k + 1] * pInv), 0, pny - 1);
      cellCount[xi + yi * pnx]++;
    }
    let first = 0;
    for (let c = 0; c < pnx * pny; c++) { first += cellCount[c]; firstCell[c] = first; }
    firstCell[pnx * pny] = first;
    for (let k = 0; k < this.count; k++) {
      const xi = clampi(Math.floor(pos[2 * k] * pInv), 0, pnx - 1), yi = clampi(Math.floor(pos[2 * k + 1] * pInv), 0, pny - 1);
      cellIds[--firstCell[xi + yi * pnx]] = k;
    }

    const minDist = 2 * this.radius, minDist2 = minDist * minDist;
    for (let it = 0; it < iters; it++) {
      for (let k = 0; k < this.count; k++) {
        const px = pos[2 * k], py = pos[2 * k + 1];
        const pxi = Math.floor(px * pInv), pyi = Math.floor(py * pInv);
        const x0 = Math.max(pxi - 1, 0), y0 = Math.max(pyi - 1, 0);
        const x1 = Math.min(pxi + 1, pnx - 1), y1 = Math.min(pyi + 1, pny - 1);
        for (let yi = y0; yi <= y1; yi++) for (let xi = x0; xi <= x1; xi++) {
          const c = xi + yi * pnx;
          for (let m = firstCell[c]; m < firstCell[c + 1]; m++) {
            const id = cellIds[m];
            if (id === k) continue;
            let dx = pos[2 * id] - pos[2 * k], dy = pos[2 * id + 1] - pos[2 * k + 1];
            const d2 = dx * dx + dy * dy;
            if (d2 > minDist2 || d2 === 0) continue;
            const d = Math.sqrt(d2), s = (0.5 * (minDist - d)) / d;
            dx *= s;
            dy *= s;
            pos[2 * k] -= dx;
            pos[2 * k + 1] -= dy;
            pos[2 * id] += dx;
            pos[2 * id + 1] += dy;
          }
        }
      }
    }
    this.cohere();
    for (let k = 0; k < this.count; k++) if (this.solidAt(pos[2 * k], pos[2 * k + 1])) this.pushOut(k);
  }

  /**
   * Cohesion (surface tension): particles of the same liquid that are a little farther apart than their
   * resting spacing pull gently together. Water beads into droplets and holds together as a plug in a narrow
   * tube instead of smearing along the walls; it also helps oil and water keep apart.
   */
  protected cohere() {
    const { pnx, pny, pInv, firstCell, cellIds, pos, kind } = this;
    const minDist = 2 * this.radius, range = COHESION_RANGE * this.radius, range2 = range * range;
    for (let k = 0; k < this.count; k++) {
      const px = pos[2 * k], py = pos[2 * k + 1];
      const pxi = Math.floor(px * pInv), pyi = Math.floor(py * pInv);
      const x0 = Math.max(pxi - 1, 0), y0 = Math.max(pyi - 1, 0);
      const x1 = Math.min(pxi + 1, pnx - 1), y1 = Math.min(pyi + 1, pny - 1);
      for (let yi = y0; yi <= y1; yi++) for (let xi = x0; xi <= x1; xi++) {
        const c = xi + yi * pnx;
        for (let m = firstCell[c]; m < firstCell[c + 1]; m++) {
          const id = cellIds[m];
          if (id <= k || kind[id] !== kind[k]) continue; // each pair once, same liquid only
          const dx = pos[2 * id] - pos[2 * k], dy = pos[2 * id + 1] - pos[2 * k + 1];
          const d2 = dx * dx + dy * dy;
          if (d2 <= minDist * minDist || d2 > range2) continue;
          const d = Math.sqrt(d2);
          const pull = COHESION * (d - minDist) * (1 - (d - minDist) / (range - minDist)) / d;
          pos[2 * k] += dx * pull; pos[2 * k + 1] += dy * pull;
          pos[2 * id] -= dx * pull; pos[2 * id + 1] -= dy * pull;
        }
      }
    }
  }

  /** Move a particle that ended up inside a solid cell to the nearest open side of that cell. */
  protected pushOut(k: number) {
    const { pos, h, nx } = this;
    const x = pos[2 * k], y = pos[2 * k + 1];
    const i = Math.floor(x * this.inv), j = Math.floor(y * this.inv);
    const eps = 0.02 * h;
    let best = Infinity, bx = this.prePos[2 * k], by = this.prePos[2 * k + 1];
    const open = (ci: number, cj: number) => ci > 0 && cj > 0 && ci < nx - 1 && cj < this.ny - 1 && this.s[ci + cj * nx] !== 0;
    const consider = (cx: number, cy: number, ok: boolean) => {
      const d = Math.abs(cx - x) + Math.abs(cy - y);
      if (ok && d < best) { best = d; bx = cx; by = cy; }
    };
    consider(i * h - eps, y, open(i - 1, j));
    consider((i + 1) * h + eps, y, open(i + 1, j));
    consider(x, j * h - eps, open(i, j - 1));
    consider(x, (j + 1) * h + eps, open(i, j + 1));
    pos[2 * k] = bx;
    pos[2 * k + 1] = by;
  }

  /** Particle ↔ grid velocity transfer (bilinear). toGrid also classifies cells as fluid/air/solid. */
  protected transfer(toGrid: boolean) {
    const { nx, ny, h, inv } = this;
    const h2 = 0.5 * h;
    if (toGrid) {
      this.prevU.set(this.u);
      this.prevV.set(this.v);
      this.du.fill(0);
      this.dv.fill(0);
      this.u.fill(0);
      this.v.fill(0);
      for (let c = 0; c < nx * ny; c++) this.cellType[c] = this.s[c] === 0 ? SOLID : AIR;
      for (let k = 0; k < this.count; k++) {
        const i = clampi(Math.floor(this.pos[2 * k] * inv), 0, nx - 1), j = clampi(Math.floor(this.pos[2 * k + 1] * inv), 0, ny - 1);
        const c = i + j * nx;
        if (this.cellType[c] === AIR) this.cellType[c] = FLUID;
      }
    }

    for (let comp = 0; comp < 2; comp++) {
      const dx = comp === 0 ? 0 : h2, dy = comp === 0 ? h2 : 0;
      const f = comp === 0 ? this.u : this.v;
      const prevF = comp === 0 ? this.prevU : this.prevV;
      const d = comp === 0 ? this.du : this.dv;
      const offset = comp === 0 ? 1 : nx; // neighbor across the face this component lives on

      for (let k = 0; k < this.count; k++) {
        const x = clampf(this.pos[2 * k], h, (nx - 1) * h), y = clampf(this.pos[2 * k + 1], h, (ny - 1) * h);
        const x0 = Math.min(Math.floor((x - dx) * inv), nx - 2), tx = (x - dx - x0 * h) * inv, x1 = Math.min(x0 + 1, nx - 2);
        const y0 = Math.min(Math.floor((y - dy) * inv), ny - 2), ty = (y - dy - y0 * h) * inv, y1 = Math.min(y0 + 1, ny - 2);
        const sx = 1 - tx, sy = 1 - ty;
        const w0 = sx * sy, w1 = tx * sy, w2 = tx * ty, w3 = sx * ty;
        const n0 = x0 + y0 * nx, n1 = x1 + y0 * nx, n2 = x1 + y1 * nx, n3 = x0 + y1 * nx;

        if (toGrid) {
          const pv = this.vel[2 * k + comp];
          f[n0] += pv * w0; d[n0] += w0;
          f[n1] += pv * w1; d[n1] += w1;
          f[n2] += pv * w2; d[n2] += w2;
          f[n3] += pv * w3; d[n3] += w3;
        } else {
          const ct = this.cellType;
          const v0 = ct[n0] !== AIR || ct[n0 - offset] !== AIR ? 1 : 0;
          const v1 = ct[n1] !== AIR || ct[n1 - offset] !== AIR ? 1 : 0;
          const v2 = ct[n2] !== AIR || ct[n2 - offset] !== AIR ? 1 : 0;
          const v3 = ct[n3] !== AIR || ct[n3 - offset] !== AIR ? 1 : 0;
          const wsum = v0 * w0 + v1 * w1 + v2 * w2 + v3 * w3;
          if (wsum > 0) {
            const pic = (v0 * w0 * f[n0] + v1 * w1 * f[n1] + v2 * w2 * f[n2] + v3 * w3 * f[n3]) / wsum;
            const corr = (v0 * w0 * (f[n0] - prevF[n0]) + v1 * w1 * (f[n1] - prevF[n1]) + v2 * w2 * (f[n2] - prevF[n2]) + v3 * w3 * (f[n3] - prevF[n3])) / wsum;
            const flip = this.vel[2 * k + comp] + corr;
            const nv = (1 - this.params.flipRatio) * pic + this.params.flipRatio * flip;
            this.vel[2 * k + comp] = nv > MAX_SPEED ? MAX_SPEED : nv < -MAX_SPEED ? -MAX_SPEED : nv;
          }
        }
      }

      if (toGrid) {
        for (let c = 0; c < f.length; c++) if (d[c] > 0) f[c] /= d[c];
        // Faces touching a (static) solid carry no flow.
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
          const c = i + j * nx;
          const solid = this.cellType[c] === SOLID;
          if (solid || (i > 0 && this.cellType[c - 1] === SOLID)) this.u[c] = 0;
          if (solid || (j > 0 && this.cellType[c - nx] === SOLID)) this.v[c] = 0;
        }
      }
    }
  }

  /** 4-connected flood fill of air cells into regions. */
  protected labelRegions() {
    const { nx, ny, cellType, region, queue } = this;
    region.fill(-1);
    this.regionAtmosphere.length = 0;
    for (let start = 0; start < nx * ny; start++) {
      if (cellType[start] !== AIR || region[start] >= 0) continue;
      const id = this.regionAtmosphere.length;
      let atmosphere = false, head = 0, tail = 0;
      queue[tail++] = start;
      region[start] = id;
      while (head < tail) {
        const c = queue[head++];
        if (this.openTop && c < 2 * nx) atmosphere = true;
        const i = c % nx;
        if (i > 0 && cellType[c - 1] === AIR && region[c - 1] < 0) { region[c - 1] = id; queue[tail++] = c - 1; }
        if (i < nx - 1 && cellType[c + 1] === AIR && region[c + 1] < 0) { region[c + 1] = id; queue[tail++] = c + 1; }
        if (c >= nx && cellType[c - nx] === AIR && region[c - nx] < 0) { region[c - nx] = id; queue[tail++] = c - nx; }
        if (c < nx * (ny - 1) && cellType[c + nx] === AIR && region[c + nx] < 0) { region[c + nx] = id; queue[tail++] = c + nx; }
      }
      this.regionAtmosphere.push(atmosphere);
    }
  }

  protected updateDensity() {
    const { nx, ny, h, inv } = this;
    const h2 = 0.5 * h, d = this.density;
    d.fill(0);
    this.oilDensity.fill(0);
    this.waxDensity.fill(0);
    const md = this.massDensity;
    md.fill(0);
    for (let k = 0; k < this.count; k++) {
      const m = particleDensity(this.kind[k], this.temp[k], this.silt[k]);
      const od = this.kind[k] === OIL ? this.oilDensity : this.kind[k] === WAX ? this.waxDensity : null;
      const x = clampf(this.pos[2 * k], h, (nx - 1) * h), y = clampf(this.pos[2 * k + 1], h, (ny - 1) * h);
      const x0 = Math.floor((x - h2) * inv), tx = (x - h2 - x0 * h) * inv, x1 = Math.min(x0 + 1, nx - 2);
      const y0 = Math.floor((y - h2) * inv), ty = (y - h2 - y0 * h) * inv, y1 = Math.min(y0 + 1, ny - 2);
      const sx = 1 - tx, sy = 1 - ty;
      d[x0 + y0 * nx] += sx * sy;
      d[x1 + y0 * nx] += tx * sy;
      d[x1 + y1 * nx] += tx * ty;
      d[x0 + y1 * nx] += sx * ty;
      md[x0 + y0 * nx] += m * sx * sy;
      md[x1 + y0 * nx] += m * tx * sy;
      md[x1 + y1 * nx] += m * tx * ty;
      md[x0 + y1 * nx] += m * sx * ty;
      if (od) {
        od[x0 + y0 * nx] += sx * sy;
        od[x1 + y0 * nx] += tx * sy;
        od[x1 + y1 * nx] += tx * ty;
        od[x0 + y1 * nx] += sx * ty;
      }
    }
    for (let c = 0; c < nx * ny; c++) {
      const oil = d[c] > 0 ? this.oilDensity[c] / d[c] : 0, wax = d[c] > 0 ? this.waxDensity[c] / d[c] : 0;
      this.cellOil[c] = oil;
      this.cellWax[c] = wax;
      this.cellRho[c] = d[c] > 0 ? md[c] / d[c] : 1;
    }
  }
}

function clampi(x: number, lo: number, hi: number) {
  return x < lo ? lo : x > hi ? hi : x;
}
function clampf(x: number, lo: number, hi: number) {
  return x < lo ? lo : x > hi ? hi : x;
}
