import { FLUID, Fluid, WATER } from './fluid';
import { MUD, NONE, Thermo } from './thermo';

/**
 * Mud: silt suspended in water (turbidity) that settles out of calm water and builds up as solid mud,
 * and solid mud that fast-flowing water erodes back into suspension.
 *
 * Silt lives on water particles. Every step it's pooled per cell (perfect mixing within a cell), moved
 * between cells (settling, deposition), and handed back out evenly to the particles.
 *
 * Mud also holds water (moisture). Water seeps in where mud touches it (faster under deeper water), spreads
 * through the mud from wet to dry and downhill, and seeps out of saturated mud into open air, so dams leak.
 * Mud filters what it absorbs: the silt stays on the upstream face. Exposed mud slowly dries.
 *
 * Mud slumps: with nothing beneath it, it falls (undercut banks cave in); wet mud slides down any slope
 * steeper than 45°. Mud that slumps into water breaks up into a muddy cloud that later settles out again.
 */

const SUSPEND_SPEED = 140; // px/s: at this flow speed and above, turbulence keeps silt fully suspended
const SETTLE_RATE = 3; // fraction of a cell's silt that drops to the cell below per second, in still water
const DEPOSIT_RATE = 1.2; // fraction per second that settles onto a bed below
export const CELL_OF_MUD = 12; // silt that fills one cell with solid mud (a fully muddy particle carries 1)
const ERODE_SPEED = 110; // px/s of flow past mud before it starts wearing away
const ERODE_RATE = 4; // cells per second eroded at twice ERODE_SPEED

const MUD_WATER = 2; // water particles a fully saturated cell of mud holds
const PLACED_MOISTURE = 0.6; // fresh mud is damp but holds its shape
const SEEP_UPTAKE = 0.1; // chance per second a touching water particle soaks in (times the water's depth factor)
const SEEP_SPREAD = 1.2; // moisture diffusion between mud cells, per second
const SEEP_GRAVITY = 0.4; // extra downward drainage, per second
const SEEP_OUT_AT = 0.9; // moisture above which mud seeps water out into open air
const SEEP_OUT_RATE = 3; // drips per second at full saturation
const DRY_RATE = 0.004; // moisture lost per second by mud exposed to air (faster when hot)
const SLIDE_MOISTURE = 0.85; // wetter than this, mud slides down slopes steeper than 45°
const SLIDE_CHANCE = 0.15; // per slump check: wet slopes give way a clod at a time, not all at once
const SLUMP_INTERVAL = 1 / 20; // seconds between slump moves
const TOPPLE_CHANCE = 0.25; // per slump check, for a mud cell with nothing bracing either side (more when wet)
// How much water depth (in cells) one cell of dam thickness can hold back, dry vs saturated.
const DAM_STRENGTH_DRY = 10;
const DAM_STRENGTH_WET = 2;
const DAM_SCAN = 16; // thickest dam (cells) that water pressure is checked against
const MAX_OVERHANG_DRY = 3; // cells mud can cantilever out past its support when dry; none when saturated

export class Sediment {
  /** Average silt per water particle in each cell (0..1), for rendering. */
  avg: Float32Array;
  /** Silt settled onto each cell's bed so far. */
  deposit: Float32Array;
  private erosion: Float32Array;
  /** Silt released by erosion, waiting to be mixed into the water in that cell (a particle holds at most 1). */
  private inject: Float32Array;
  private total: Float32Array;
  private cnt: Float32Array;
  private speed: Float32Array;
  /** Water content of each mud cell, 0 (dry) to 1 (saturated). */
  moist: Float32Array;
  private head: Float32Array;
  /** Horizontal distance (cells) from each mud cell to the nearest mud resting on something below. */
  private overhang: Float32Array;
  private moved: Uint8Array;
  private slumpTimer = 0;

  constructor(private fluid: Fluid, private thermo: Thermo) {
    const n = fluid.nx * fluid.ny;
    this.avg = new Float32Array(n);
    this.deposit = new Float32Array(n);
    this.erosion = new Float32Array(n);
    this.inject = new Float32Array(n);
    this.total = new Float32Array(n);
    this.cnt = new Float32Array(n);
    this.speed = new Float32Array(n);
    this.moist = new Float32Array(n);
    this.head = new Float32Array(n);
    this.overhang = new Float32Array(n);
    this.moved = new Uint8Array(n);
  }

  /** Called when a cell's solid changes: fresh mud starts damp, anything else holds no moisture. */
  placed(c: number, isMud: boolean) {
    this.moist[c] = isMud ? PLACED_MOISTURE : 0;
    this.erosion[c] = 0;
  }

  reset() {
    this.avg.fill(0);
    this.deposit.fill(0);
    this.erosion.fill(0);
    this.inject.fill(0);
    this.moist.fill(0);
    this.slumpTimer = 0;
  }

  step(dt: number) {
    const f = this.fluid, th = this.thermo, { nx, ny, h } = f;
    const { total, cnt, speed, deposit, avg } = this;
    const n = nx * ny;
    const cellOf = (k: number) => Math.floor(f.pos[2 * k] / h) + Math.floor(f.pos[2 * k + 1] / h) * nx;

    for (let c = 0; c < n; c++) {
      const ux = 0.5 * (f.u[c] + (c + 1 < n ? f.u[c + 1] : 0)), vy = 0.5 * (f.v[c] + (c + nx < n ? f.v[c + nx] : 0));
      speed[c] = Math.hypot(ux, vy);
      // Boiled-off muddy water leaves its silt on the spot.
      if (th.residue[c] > 0) { deposit[c] += th.residue[c]; th.residue[c] = 0; }
    }

    let changed = false;
    const sp = 2 * f.radius;
    // Erosion: fast flow past mud wears it away into muddy water.
    for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      const c = i + j * nx;
      if (th.mat[c] !== MUD) continue;
      let flow = 0, fastest = -1;
      for (const o of [c - 1, c + 1, c - nx, c + nx]) if (f.cellType[o] === FLUID && speed[o] > flow) { flow = speed[o]; fastest = o; }
      if (flow <= ERODE_SPEED) continue;
      // Fast water scours the mud surface continuously, picking up silt as it goes...
      const de = Math.min(1 - this.erosion[c], ERODE_RATE * (flow / ERODE_SPEED - 1) * dt);
      this.erosion[c] += de;
      this.inject[fastest] += de * CELL_OF_MUD;
      if (this.erosion[c] < 1) continue;
      // ...and once a cell's worth is gone, the cell itself opens up.
      this.erosion[c] = 0;
      th.mat[c] = NONE;
      f.s[c] = 1;
      for (let y = j * h + f.radius; y < (j + 1) * h; y += sp)
        for (let x = i * h + f.radius; x < (i + 1) * h; x += sp) f.addParticle(x, y, 0, 0, WATER, th.T[c], 0);
      changed = true;
    }

    // Depth of water above each liquid cell: deeper water pushes harder (into mud, and against dams).
    const head = this.head;
    for (let c = 0; c < n; c++) head[c] = f.cellType[c] === FLUID ? (c >= nx ? head[c - nx] : 0) + 1 : 0;

    if (this.slump(dt)) changed = true;
    this.seep(dt);

    // Pool silt per cell.
    total.fill(0);
    cnt.fill(0);
    for (let k = 0; k < f.count; k++) {
      if (f.kind[k] !== WATER) continue;
      const c = cellOf(k);
      total[c] += f.silt[k];
      cnt[c]++;
    }
    // Eroded silt mixes into whatever water is there, as fast as that water can hold it; the rest
    // drifts to the next cell downstream along with the water (here: whichever neighbor has the most liquid).
    for (let c = 0; c < n; c++) {
      if (this.inject[c] <= 0) continue;
      const take = Math.min(this.inject[c], cnt[c] - total[c]);
      if (take > 0) { total[c] += take; this.inject[c] -= take; }
      if (this.inject[c] > 0 && cnt[c] === 0) {
        let best = -1;
        for (const o of [c - 1, c + 1, c - nx, c + nx]) if (o >= 0 && o < n && cnt[o] > (best < 0 ? 0 : cnt[best])) best = o;
        if (best >= 0) { this.inject[best] += this.inject[c]; this.inject[c] = 0; }
      }
    }

    // Settling, bottom row first so silt moves at most one cell per step.
    for (let j = ny - 2; j >= 1; j--) for (let i = 1; i < nx - 1; i++) {
      const c = i + j * nx;
      if (cnt[c] === 0 || total[c] <= 0) continue;
      const calm = Math.max(0, 1 - speed[c] / SUSPEND_SPEED);
      if (calm === 0) continue;
      const below = c + nx;
      if (f.s[below] === 0) {
        const q = total[c] * Math.min(1, DEPOSIT_RATE * calm * dt);
        total[c] -= q;
        deposit[c] += q;
      } else if (f.cellType[below] === FLUID && cnt[below] > 0) {
        const room = cnt[below] - total[below];
        const q = Math.min(room, total[c] * Math.min(1, SETTLE_RATE * calm * dt));
        if (q > 0) { total[c] -= q; total[below] += q; }
      }
    }

    // A full bed of silt turns into solid mud; the water that was in it is absorbed.
    const solidified = new Set<number>();
    for (let c = 0; c < n; c++) {
      if (deposit[c] < CELL_OF_MUD || f.s[c] === 0) continue;
      deposit[c] -= CELL_OF_MUD;
      th.mat[c] = MUD;
      f.s[c] = 0;
      this.moist[c] = 1; // freshly settled mud is saturated
      solidified.add(c);
      changed = true;
      // Leftover silt carries over to the cell above, which is the new bed surface.
      if (c - nx >= 0) { deposit[c - nx] += deposit[c]; deposit[c] = 0; }
    }
    if (solidified.size) f.removeWhere((x, y) => solidified.has(Math.floor(x / h) + Math.floor(y / h) * nx));

    // Hand the pooled silt back out evenly.
    for (let c = 0; c < n; c++) avg[c] = cnt[c] > 0 ? Math.min(1, total[c] / cnt[c]) : 0;
    for (let k = 0; k < f.count; k++) if (f.kind[k] === WATER) f.silt[k] = avg[cellOf(k)];

    if (changed) th.solidChanges++;
  }

  private isOpen(c: number) {
    const { nx, ny } = this.fluid;
    const i = c % nx, j = Math.floor(c / nx);
    return i > 0 && j > 0 && i < nx - 1 && j < ny - 1 && this.fluid.s[c] !== 0;
  }

  /** Unsupported mud falls; wet mud slides down steep slopes; mud that lands in water breaks up. */
  private slump(dt: number) {
    this.slumpTimer += dt;
    if (this.slumpTimer < SLUMP_INTERVAL) return false;
    this.slumpTimer = 0;
    const f = this.fluid, th = this.thermo, { nx, ny, h } = f, moist = this.moist;
    const moved = this.moved;
    moved.fill(0);
    let changed = false;

    // Overhangs: mud resting on something has overhang 0; mud with open space below is held up only by
    // its neighbors in the row, so it counts the distance to the nearest supported cell.
    const ov = this.overhang;
    for (let j = 1; j < ny - 1; j++) {
      const row = j * nx;
      for (let i = 1; i < nx - 1; i++) {
        const c = row + i;
        ov[c] = th.mat[c] !== MUD ? Infinity : this.isOpen(c + nx) ? Infinity : 0;
      }
      for (let i = 2; i < nx - 1; i++) { const c = row + i; if (th.mat[c] === MUD) ov[c] = Math.min(ov[c], ov[c - 1] + 1); }
      for (let i = nx - 3; i >= 1; i--) { const c = row + i; if (th.mat[c] === MUD) ov[c] = Math.min(ov[c], ov[c + 1] + 1); }
    }
    const sp = 2 * f.radius;
    for (let j = ny - 2; j >= 1; j--) {
      const flip = (j + Math.floor(Math.random() * 2)) % 2 === 0;
      for (let q = 1; q < nx - 1; q++) {
        const i = flip ? q : nx - 1 - q;
        const c = i + j * nx;
        if (th.mat[c] !== MUD || moved[c]) continue;
        let target = -1;
        const openL = this.isOpen(c - 1), openR = this.isOpen(c + 1);
        const maxOverhang = Math.floor(MAX_OVERHANG_DRY * (1 - moist[c]) + 0.5);
        if (this.isOpen(c + nx) && ov[c] > maxOverhang) target = c + nx;
        else if (this.isOpen(c + nx)) target = -1;
        else if (openL && openR && Math.random() < TOPPLE_CHANCE * (0.5 + moist[c])) {
          // Nothing bracing either side: a thin column topples.
          const d = Math.random() < 0.5 ? 1 : -1;
          target = this.isOpen(c + nx + d) ? c + nx + d : this.isOpen(c + nx - d) ? c + nx - d : c + d;
        } else if (moist[c] > SLIDE_MOISTURE && Math.random() < SLIDE_CHANCE) {
          const d = Math.random() < 0.5 ? 1 : -1;
          for (const s of [d, -d]) if (this.isOpen(c + s) && this.isOpen(c + nx + s)) { target = c + nx + s; break; }
        }
        if (target < 0) target = this.damFailure(c);
        if (target < 0) continue;
        changed = true;
        if (f.cellType[target] === FLUID) {
          // Into water: the clod breaks up into a muddy cloud, and the water it held is released.
          th.mat[c] = NONE;
          f.s[c] = 1;
          this.inject[target] += CELL_OF_MUD;
          const ti = target % nx, tj = Math.floor(target / nx);
          let n = Math.round(moist[c] * MUD_WATER);
          for (let y = tj * h + f.radius; y < (tj + 1) * h && n > 0; y += sp)
            for (let x = ti * h + f.radius; x < (ti + 1) * h && n > 0; x += sp, n--) f.addParticle(x, y, 0, 0, WATER, th.T[c], 1);
          moist[c] = 0;
        } else {
          // Through air: the clod moves down a cell.
          th.mat[target] = MUD; f.s[target] = 0; th.T[target] = th.T[c];
          moist[target] = moist[c];
          th.mat[c] = NONE; f.s[c] = 1; moist[c] = 0;
          this.erosion[target] = this.erosion[c]; this.erosion[c] = 0;
          moved[target] = 1;
          f.removeWhere((x, y) => Math.floor(x / h) + Math.floor(y / h) * nx === target);
        }
      }
    }
    return changed;
  }

  /**
   * Water pressure against a dam: if this mud cell has water on one side, measure the dam's thickness along
   * that row to open air on the other side. Deep water against a thin (or soaked) dam shoves the downstream
   * face out, so breaches start at the bottom where the pressure is highest. Returns the cell the face is
   * pushed into, or -1.
   */
  private damFailure(c: number) {
    const f = this.fluid, th = this.thermo;
    for (const d of [-1, 1]) {
      // c is a downstream face if there's open air on one side; look through the dam the other way for water.
      const air = c - d;
      if (!this.isOpen(air) || f.cellType[air] === FLUID) continue;
      let e = c, thick = 0, wet = 0;
      while (thick < DAM_SCAN && th.mat[e] === MUD) { wet += this.moist[e]; thick++; e += d; }
      if (f.cellType[e] !== FLUID) continue;
      const m = wet / thick;
      const strength = thick * (DAM_STRENGTH_DRY * (1 - m) + DAM_STRENGTH_WET * m);
      if (this.head[e] > strength) return air;
    }
    return -1;
  }

  /** Water soaking into, through, and out of mud. */
  private seep(dt: number) {
    const f = this.fluid, th = this.thermo, { nx, h } = f, { moist, head, deposit } = this;
    const ny = f.ny;
    const isMud = (c: number) => th.mat[c] === MUD;


    // Uptake: water touching unsaturated mud soaks in, leaving its silt behind on the face (filtering).
    const sat = 1 - 1 / MUD_WATER;
    for (let k = f.count - 1; k >= 0; k--) {
      if (f.kind[k] !== WATER) continue;
      const c = Math.floor(f.pos[2 * k] / h) + Math.floor(f.pos[2 * k + 1] / h) * nx;
      if (Math.random() > SEEP_UPTAKE * dt * (1 + head[c] / 8)) continue;
      for (const o of [c + nx, c - 1, c + 1, c - nx]) {
        if (!isMud(o) || moist[o] > sat) continue;
        moist[o] += 1 / MUD_WATER;
        deposit[c] += f.silt[k];
        f.removeParticle(k);
        break;
      }
    }

    // Spreading through the mud: wet to dry, plus drainage downward.
    const spread = Math.min(0.24, SEEP_SPREAD * dt), drain = SEEP_GRAVITY * dt;
    for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      const c = i + j * nx;
      if (!isMud(c)) continue;
      if (isMud(c + 1)) { const q = (moist[c] - moist[c + 1]) * spread; moist[c] -= q; moist[c + 1] += q; }
      if (isMud(c + nx)) {
        let q = (moist[c] - moist[c + nx]) * spread;
        q += Math.min(moist[c], 1 - moist[c + nx]) * drain;
        moist[c] -= q; moist[c + nx] += q;
      }
    }

    // Seeping out into open air, and drying.
    const sp = 2 * f.radius;
    for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      const c = i + j * nx;
      if (!isMud(c)) continue;
      let exposed = false;
      for (const o of [c + nx, c - 1, c + 1, c - nx]) {
        if (!this.isOpen(o) || f.cellType[o] === FLUID) continue;
        exposed = true;
        if (o === c - nx || moist[c] <= SEEP_OUT_AT) continue; // water doesn't seep upward
        if (Math.random() < SEEP_OUT_RATE * dt * (moist[c] - SEEP_OUT_AT) / (1 - SEEP_OUT_AT)) {
          const oi = o % nx, oj = Math.floor(o / nx);
          if (f.addParticle(oi * h + h / 2 + (Math.random() - 0.5) * sp, oj * h + h / 2, 0, 0, WATER, th.T[c], 0)) moist[c] -= 1 / MUD_WATER;
        }
      }
      if (exposed) moist[c] = Math.max(0, moist[c] - DRY_RATE * dt * (1 + Math.max(0, th.T[c] - 20) / 40));
    }
  }
}
