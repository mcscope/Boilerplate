/**
 * Shared helpers for the headless validation suites (tests/physics.ts, tests/puzzles.ts).
 *
 * Everything here talks to the engine through World / Fluid / Thermo.
 */
import { Builder, CELL, Level, NX, NY, Rect, World } from '../src/world';
import { OIL, WATER, WAX } from '../src/sim/fluid';
import { spawn } from 'child_process';
import { cpus } from 'os';

export const DT = 1 / 60;

// ---------------------------------------------------------------- command line

export interface Args {
  only: string | null;
  strict: boolean;
  jobs: number;
  verbose: boolean;
  /** Internal: run exactly one named item in this process and print a JSON result line. */
  child: string | null;
  /** Seed for Math.random (the engines use it for jitter, boiling, flames), so runs are reproducible. */
  seed: number;
  /** Seeds to run every check with (`--seeds=1,2,3`); defaults to [seed]. Puzzle suite only. */
  seeds: number[];
}

export function parseArgs(argv = process.argv.slice(2)): Args {
  const get = (name: string) => {
    const a = argv.find(s => s === `--${name}` || s.startsWith(`--${name}=`));
    if (!a) return undefined;
    return a.includes('=') ? a.slice(a.indexOf('=') + 1) : '';
  };
  const jobs = Number(get('jobs') ?? 0) || Math.max(1, Math.min(8, availableCpus() - 1));
  const seed = Number(get('seed') ?? 1);
  seedRandom(seed);
  const seeds = (get('seeds') ?? String(seed)).split(',').map(Number).filter(n => Number.isFinite(n));
  return { only: get('only') ?? null, strict: get('strict') !== undefined, jobs, verbose: get('verbose') !== undefined, child: get('child') ?? null, seed, seeds };
}

/** Replace Math.random with a seeded generator (mulberry32). */
export function seedRandom(seed: number) {
  let a = (seed >>> 0) || 1;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function availableCpus() {
  try { return cpus().length; } catch { return 4; }
}

// ---------------------------------------------------------------- worlds

export function makeWorld(): World {
  return new World();
}

/** Build an inline level and load it. */
export function level(name: string, build: (b: Builder) => void): Level {
  return { name, desc: '', build };
}

export function loadWorld(lvl: Level | ((b: Builder) => void), name = 'test'): World {
  const w = makeWorld();
  w.load(typeof lvl === 'function' ? level(name, lvl) : lvl);
  return w;
}

/** A Builder for editing a loaded world (e.g. pouring more water in mid-run). */
export function builder(w: World) { return new Builder(w); }

/** Step `seconds` of simulation at 60 Hz. `onStep` runs before each step; return true from it to stop early. */
export function run(w: World, seconds: number, onStep?: (w: World, frame: number, t: number) => boolean | void) {
  const frames = Math.round(seconds / DT);
  for (let n = 0; n < frames; n++) {
    if (onStep && onStep(w, n, n * DT)) return n * DT;
    w.step(DT);
  }
  return seconds;
}

/** Erase cells regardless of locks (scenario scripting, not player input). */
export function openCells(w: World, i0: number, j0: number, i1: number, j1: number) {
  builder(w).open(i0, j0, i1, j1);
  w.solidVersion++;
}

/** Hold solid cells at a temperature (a hot plate or cold ceiling that never runs out). */
export function holdTemp(w: World, r: Rect, temp: number) {
  for (let j = r.j0; j <= r.j1; j++) for (let i = r.i0; i <= r.i1; i++) w.thermo.T[i + j * NX] = temp;
}

// ---------------------------------------------------------------- measurements

export const rect = (i0: number, j0: number, i1: number, j1: number): Rect => ({ i0, j0, i1, j1 });

/** Particles in an inclusive cell rect, optionally only of one kind. */
export function countIn(w: World, r: Rect, kind?: number) {
  const f = w.fluid;
  let n = 0;
  for (let k = 0; k < f.count; k++) {
    if (kind !== undefined && f.kind[k] !== kind) continue;
    const i = f.pos[2 * k] / CELL, j = f.pos[2 * k + 1] / CELL;
    if (i >= r.i0 && i < r.i1 + 1 && j >= r.j0 && j < r.j1 + 1) n++;
  }
  return n;
}

export function kindCounts(w: World) {
  const f = w.fluid, out = { water: 0, oil: 0, wax: 0, total: f.count };
  for (let k = 0; k < f.count; k++) {
    if (f.kind[k] === WATER) out.water++;
    else if (f.kind[k] === OIL) out.oil++;
    else if (f.kind[k] === WAX) out.wax++;
  }
  return out;
}

export function maxSpeed(w: World, r?: Rect) {
  const f = w.fluid;
  let m = 0;
  for (let k = 0; k < f.count; k++) {
    if (r) {
      const i = f.pos[2 * k] / CELL, j = f.pos[2 * k + 1] / CELL;
      if (i < r.i0 || i >= r.i1 + 1 || j < r.j0 || j >= r.j1 + 1) continue;
    }
    m = Math.max(m, Math.hypot(f.vel[2 * k], f.vel[2 * k + 1]));
  }
  return m;
}

/** Particle y positions (in cells) inside a rect, optionally of one kind. */
export function ysIn(w: World, r: Rect, kind?: number) {
  const f = w.fluid, ys: number[] = [];
  for (let k = 0; k < f.count; k++) {
    if (kind !== undefined && f.kind[k] !== kind) continue;
    const i = f.pos[2 * k] / CELL, j = f.pos[2 * k + 1] / CELL;
    if (i >= r.i0 && i < r.i1 + 1 && j >= r.j0 && j < r.j1 + 1) ys.push(j);
  }
  return ys;
}

/**
 * Liquid surface height in a column of `width` cells whose liquid rests on a floor at cell row `floorJ`
 * (exclusive: the last liquid row is floorJ - 1), from the particle count. Returns the surface row (cells, y down).
 * Count-based, so it ignores splashes and is sub-cell accurate.
 */
export function surfaceFromCount(w: World, r: Rect, floorJ = r.j1 + 1) {
  const n = countIn(w, r);
  return floorJ - n / (w.fluid.restDensity * (r.i1 - r.i0 + 1));
}

export function percentile(xs: number[], p: number) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
}

export function mean(xs: number[]) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN; }

/** Gas cells (cellType AIR / GAS = 1) in a rect. */
export function gasCellsIn(w: World, r: Rect) {
  const f = w.fluid;
  let n = 0;
  for (let j = r.j0; j <= r.j1; j++) for (let i = r.i0; i <= r.i1; i++) if (f.cellType[i + j * NX] === 1) n++;
  return n;
}

// ---------------------------------------------------------------- gas / vapor (feature-detected)

/**
 * Air and vapor in a rect (whole grid if omitted). `vapor` is in liquid-particle equivalents (vapor mass density ×
 * restDensity) so it adds directly to particle counts; `air` is in the engine's units (an ambient cell = RHO_AIR),
 * only meaningful for relative change.
 */
export function gasTotals(w: World, r?: Rect): { air: number; vapor: number } {
  const R = r ?? rect(0, 0, NX - 1, NY - 1);
  const g = w.fluid.gasState;
  let air = 0, vapor = 0;
  for (let j = R.j0; j <= R.j1; j++) for (let i = R.i0; i <= R.i1; i++) {
    const c = i + j * NX;
    air += g.air[c] + g.pendingAir[c];
    vapor += g.vapor[c] + g.pendingVapor[c];
  }
  return { air, vapor: vapor * w.fluid.restDensity };
}

// ---------------------------------------------------------------- reporting

export type Expect = 'pass' | 'fail' | 'n/a';

export interface Result {
  name: string;
  pass: boolean;
  metric: string;
  threshold: string;
  expected: Expect;
  seconds: number; // wall-clock
  note?: string;
}

export function verdict(r: Result) {
  if (r.pass) return r.expected === 'pass' ? 'PASS' : r.expected === 'n/a' ? 'PASS (n/a)' : 'PASS (unexpected)';
  return r.expected === 'pass' ? 'FAIL' : r.expected === 'fail' ? 'FAIL (expected)' : 'FAIL (n/a)';
}

/** A failure that should break the build: everything not marked expected-fail / n/a (all of them with --strict). */
export function isBad(r: Result, strict: boolean) { return !r.pass && (strict || r.expected === 'pass'); }

export function table(rows: string[][]) {
  const widths = rows[0].map((_, c) => Math.max(...rows.map(r => (r[c] ?? '').length)));
  return rows.map((r, n) => {
    const line = r.map((s, c) => (s ?? '').padEnd(widths[c])).join('  ').trimEnd();
    return n === 0 ? `${line}\n${widths.map(w => '-'.repeat(w)).join('  ')}` : line;
  }).join('\n');
}

export function report(title: string, results: Result[], strict: boolean) {
  console.log(`\n${title}\n`);
  console.log(table([
    ['scenario', 'verdict', 'metric', 'threshold', 'time'],
    ...results.map(r => [r.name, verdict(r), r.metric, r.threshold, `${r.seconds.toFixed(1)}s`]),
  ]));
  const notes = results.filter(r => r.note);
  if (notes.length) { console.log(''); for (const r of notes) console.log(`  ${r.name}: ${r.note}`); }
  const bad = results.filter(r => isBad(r, strict));
  const total = results.reduce((a, r) => a + r.seconds, 0);
  console.log(`\n${results.filter(r => r.pass).length}/${results.length} passed, ${bad.length} unexpected failure(s), ${total.toFixed(1)}s of simulation work`);
  return bad.length;
}

export function fmt(x: number, d = 1) { return Number.isFinite(x) ? x.toFixed(d) : String(x); }

// ---------------------------------------------------------------- parallel runner

/**
 * Run named jobs in parallel child processes (this same script with `--child=<name>`), each printing one JSON line
 * prefixed with RESULT_TAG. Falls back to in-process when jobs = 1.
 */
export const RESULT_TAG = '@@RESULT ';

export async function runParallel<T>(names: string[], jobs: number, inProcess: (name: string) => T): Promise<T[]> {
  if (jobs <= 1 || names.length <= 1) return names.map(inProcess);
  const out: T[] = new Array(names.length);
  let next = 0;
  const passthrough = process.argv.slice(2).filter(a => !a.startsWith('--child') && !a.startsWith('--only') && !a.startsWith('--jobs'));
  const worker = async () => {
    while (next < names.length) {
      const idx = next++;
      out[idx] = await new Promise<T>((resolve, reject) => {
        const p = spawn(process.execPath, [process.argv[1], ...passthrough, `--child=${names[idx]}`], { stdio: ['ignore', 'pipe', 'inherit'] });
        let buf = '';
        p.stdout.on('data', (d: unknown) => (buf += String(d)));
        p.on('close', (code: number) => {
          const line = buf.split('\n').find(l => l.startsWith(RESULT_TAG));
          if (!line) return reject(new Error(`child for "${names[idx]}" exited ${code} without a result:\n${buf}`));
          const extra = buf.split('\n').filter(l => l && !l.startsWith(RESULT_TAG)).join('\n');
          if (extra) process.stdout.write(extra + '\n');
          resolve(JSON.parse(line.slice(RESULT_TAG.length)) as T);
        });
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, names.length) }, worker));
  return out;
}

/** ASCII picture of a cell rect for debugging: # solid, digits = particles per cell (9+ = 9), ~ vapor, . empty. */
export function ascii(w: World, r: Rect) {
  const f = w.fluid, cnt = new Map<number, number>(), steam = new Set<number>();
  const cellOf = (x: number, y: number) => Math.floor(x / CELL) + Math.floor(y / CELL) * NX;
  for (let k = 0; k < f.count; k++) { const c = cellOf(f.pos[2 * k], f.pos[2 * k + 1]); cnt.set(c, (cnt.get(c) ?? 0) + 1); }
  const vapor = w.fluid.gasState.vapor;
  for (let c = 0; c < vapor.length; c++) if (vapor[c] > 0.002) steam.add(c);
  const lines: string[] = [];
  for (let j = r.j0; j <= r.j1; j++) {
    let s = `${String(j).padStart(3)} `;
    for (let i = r.i0; i <= r.i1; i++) {
      const c = i + j * NX, n = cnt.get(c) ?? 0;
      s += f.s[c] === 0 ? '#' : n ? String(Math.min(9, n)) : steam.has(c) ? '~' : '.';
    }
    lines.push(s);
  }
  return lines.join('\n');
}
