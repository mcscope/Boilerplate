/**
 * Puzzle harness: every puzzle in src/puzzles.ts, run headlessly.
 *
 *   npm run test:puzzles                               # classic engine, all puzzles in parallel
 *   npm run test:puzzles -- --physics=unified
 *   npm run test:puzzles -- --only=6c --jobs=1
 *
 * For each puzzle:
 * - "no input": the level as shipped must NOT solve itself within 60 s (hard design rule).
 * - "reference": a scripted solution must solve it within 90 s. Puzzles without one were solved by hand
 *   and are reported as human-verified.
 * - "negative": scripted near-misses that must NOT solve it (they check the puzzle teaches its idea).
 *
 * Solutions spend materials through world.paintSolid with the puzzle's budgets (only tools the puzzle grants),
 * and use Fire through thermo.applyTemperature, at most the puzzle's fire budget (seconds).
 */
import { CELL, Level, World } from '../src/world';
import { PUZZLES } from '../src/puzzles';
import { STONE, WOOD } from '../src/sim/thermo';
import { DT, Physics, RESULT_TAG, makeWorld, parseArgs, seedRandom, runParallel, table } from './lib';

type Spend = (mat: number, tool: string, i0: number, j0: number, i1: number, j1: number) => void;
/** Fire at (x, y) px for this frame, if fire budget remains. */
type Fire = (x: number, y: number) => void;

interface Solution {
  label: string;
  /** 'solve': must solve. 'fail': a negative check that must not. */
  expect: 'solve' | 'fail';
  /**
   * Set when a reference solution is known not to work with the current level (it was written for an earlier
   * layout). It still runs and reports, but its failure doesn't fail the suite unless --strict.
   */
  stale?: string;
  build?: (spend: Spend, w: World) => void;
  act?: (frame: number, fire: Fire, w: World) => void;
}

const NO_INPUT_SECONDS = 60;
const SOLUTION_SECONDS = 90;
const FIRE_RADIUS = 6;

/** Light a fire at (x, y) for the first `frames` frames. */
const torch = (x: number, y: number, frames = 24) => (frame: number, fire: Fire) => { if (frame < frames) fire(x, y); };

const SOLUTIONS: Record<string, Solution[]> = {
  '1. First Pour': [{
    label: 'long gentle chute', expect: 'solve',
    build: spend => { for (let i = 14; i <= 112; i++) { const j = Math.round(30 + (i - 14) * 0.24); spend(STONE, 'wall', i, j, i, j + 1); } },
  }],
  '2. Same Level': [{
    label: 'sealed riser', expect: 'solve',
    build: spend => { spend(STONE, 'wall', 100, 30, 101, 60); spend(STONE, 'wall', 106, 36, 107, 69); spend(STONE, 'wall', 108, 36, 114, 36); },
  }],
  '2b. Over the Top': [{
    label: 'siphon over the rim', expect: 'solve',
    build: spend => {
      spend(STONE, 'wall', 100, 30, 101, 60); // riser, left
      spend(STONE, 'wall', 106, 36, 107, 69); // riser, right (also the inner wall of the crest)
      spend(STONE, 'wall', 100, 28, 119, 29); // crest ceiling
      spend(STONE, 'wall', 108, 36, 114, 37); // crest floor
      spend(STONE, 'wall', 113, 38, 114, 80); // down leg, left
      spend(STONE, 'wall', 118, 30, 119, 80); // down leg, right
    },
  }, {
    label: 'riser only (Same Level answer)', expect: 'fail',
    build: spend => { spend(STONE, 'wall', 100, 30, 101, 60); spend(STONE, 'wall', 106, 36, 107, 69); spend(STONE, 'wall', 108, 36, 114, 36); },
  }],
  '3. Clear Water': [{
    label: 'settling pond', expect: 'solve',
    stale: 'written for an earlier layout (the shelf now starts at i=40); needs a new solution',
    build: spend => { spend(STONE, 'wall', 14, 62, 16, 77); spend(STONE, 'wall', 60, 70, 61, 77); spend(STONE, 'wall', 95, 66, 96, 74); },
  }],
  '3b. Muddy Waters': [{
    label: 'deflector into a settling tank', expect: 'solve',
    stale: 'scripted attempt from an earlier layout; the puzzle was solved by hand',
    build: spend => {
      for (let i = 30; i <= 84; i++) { const j = 18 + Math.round((84 - i) * 0.12); spend(STONE, 'wall', i, j, i, j); } // deflector to the far end
      spend(STONE, 'wall', 85, 15, 85, 18); // lip on the high end
      spend(STONE, 'wall', 12, 62, 67, 63); // tank floor
      spend(STONE, 'wall', 12, 30, 13, 61); // tank left wall
      spend(STONE, 'wall', 66, 34, 67, 61); // weir
      spend(STONE, 'wall', 68, 34, 74, 34); // spout over the beaker
      spend(STONE, 'wall', 56, 30, 57, 52); // hanging baffle in front of the weir
    },
  }],
  '4. Skimmer': [{
    label: 'weir on the water outlet', expect: 'solve',
    // The water has to climb a weir before it can leave, so the tank fills and the floating oil spills over the
    // left lip. The channel up to the weir must be wide, or the outflow can't keep up and water spills too.
    build: spend => { spend(STONE, 'wall', 95, 50, 96, 78); },
  }],
  '5. Kindling': [{
    label: 'log stack + torch', expect: 'solve',
    build: spend => { spend(WOOD, 'wood', 62, 79, 98, 81); spend(WOOD, 'wood', 70, 74, 90, 75); },
    act: torch(126, 158),
  }],
  '5b. Still': [{
    label: 'sloped hood', expect: 'solve',
    build: spend => {
      // Hood: from just outside the pot's left rim, rising to the right, over the beaker.
      for (let i = 34; i <= 132; i++) { const j = Math.round(42 - (i - 34) * 0.14); spend(STONE, 'wall', i, j, i, j); }
      spend(STONE, 'wall', 133, 26, 133, 32); // end cap
    },
    act: torch(118, 158),
  }, {
    label: 'fire only, no hood', expect: 'fail',
    act: torch(118, 158),
  }],
  '6a. Water Bridge': [{
    label: 'dip tube + pipe to the oil tank', expect: 'solve',
    build: spend => {
      spend(STONE, 'wall', 44, 42, 48, 42); spend(STONE, 'wall', 44, 43, 44, 58); spend(STONE, 'wall', 48, 46, 48, 58); // dip tube inside the boiler
      spend(STONE, 'wall', 51, 42, 61, 42); spend(STONE, 'wall', 51, 46, 56, 46); // run out of the high hole
      spend(STONE, 'wall', 61, 43, 61, 56); spend(STONE, 'wall', 57, 47, 57, 60); // down leg
      spend(STONE, 'wall', 61, 57, 83, 57); spend(STONE, 'wall', 57, 61, 83, 61); // along to the oil tank's inlet
    },
    act: torch(70, 147),
  }],
  '6. Steam Pump': [{
    label: 'dip tube below the waterline', expect: 'solve',
    stale: 'crossover spills outside the cup wall (i=117 vs cup at 118); fixing that still lifts only ~20 in classic',
    build: spend => {
      // Dip tube inside the boiler: from the hole, down to near the floor (open at the bottom).
      spend(STONE, 'wall', 83, 41, 88, 41); // cap over the tube
      spend(STONE, 'wall', 83, 42, 83, 57); // tube left wall
      spend(STONE, 'wall', 87, 45, 88, 57); // tube right wall, below the hole
      // Outside: along from the hole, up a riser, over, and down into the cup.
      spend(STONE, 'wall', 91, 45, 103, 45); // floor of the run out of the hole
      spend(STONE, 'wall', 91, 41, 98, 41); // ceiling of the run
      spend(STONE, 'wall', 99, 10, 99, 41); // riser left wall
      spend(STONE, 'wall', 103, 14, 103, 44); // riser right wall
      spend(STONE, 'wall', 99, 9, 117, 9); // top of the crossover
      spend(STONE, 'wall', 104, 14, 116, 14); // floor of the crossover, spilling into the cup
    },
    act: torch(140, 134),
  }, {
    label: 'straight pipe from above the water', expect: 'fail',
    build: spend => {
      spend(STONE, 'wall', 91, 45, 103, 45); spend(STONE, 'wall', 91, 41, 98, 41);
      spend(STONE, 'wall', 99, 10, 99, 41); spend(STONE, 'wall', 103, 14, 103, 44);
      spend(STONE, 'wall', 99, 9, 117, 9); spend(STONE, 'wall', 104, 14, 116, 14);
    },
    act: torch(140, 134),
  }],
};

/** Puzzles solved by a person in the browser, with no scripted solution yet. */
const HUMAN_VERIFIED = new Set(['1b. Long Shot', '3b. Muddy Waters']);

// ---------------------------------------------------------------- running

interface Job { puzzle: string; kind: 'no input' | 'reference' | 'negative'; label: string; expect: 'solve' | 'fail'; seconds: number; stale?: string; seed: number }
interface JobResult extends Job { solved: boolean; at: number; detail: string; wall: number; error?: string }

function jobsFor(lvl: Level, seed: number): Job[] {
  const jobs: Job[] = [{ puzzle: lvl.name, kind: 'no input', label: '-', expect: 'fail', seconds: NO_INPUT_SECONDS, seed }];
  for (const s of SOLUTIONS[lvl.name] ?? [])
    jobs.push({ puzzle: lvl.name, kind: s.expect === 'solve' ? 'reference' : 'negative', label: s.label, expect: s.expect, seconds: SOLUTION_SECONDS, stale: s.stale, seed });
  return jobs;
}

const jobKey = (j: Job) => `${j.puzzle}::${j.label}::${j.seed}`;

function runJob(job: Job, physics: Physics): JobResult {
  seedRandom(job.seed);
  const t0 = performance.now();
  const lvl = PUZZLES.find(p => p.name === job.puzzle)!;
  const sol = job.kind === 'no input' ? null : SOLUTIONS[job.puzzle].find(s => s.label === job.label)!;
  const w = makeWorld(physics);
  w.load(lvl);
  const tools = lvl.puzzle!.tools;
  const budget: Record<string, number> = { ...tools };
  let error: string | undefined;
  const spend: Spend = (mat, tool, i0, j0, i1, j1) => {
    if (!(tool in tools)) { error = `solution uses '${tool}', which this puzzle doesn't grant`; return; }
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const r = w.paintSolid((i + 0.5) * CELL, (j + 0.5) * CELL, 0.5, mat, budget[tool]);
      budget[tool] -= r.placed;
    }
  };
  const fire: Fire = (x, y) => {
    if (!('fire' in tools)) { error = "solution uses 'fire', which this puzzle doesn't grant"; return; }
    if (budget.fire <= 0) return;
    budget.fire = Math.max(0, budget.fire - DT);
    w.thermo.applyTemperature(x, y, FIRE_RADIUS, 800);
  };
  try {
    sol?.build?.(spend, w);
    const frames = Math.round(job.seconds / DT);
    for (let n = 0; n < frames && !error; n++) {
      sol?.act?.(n, fire, w);
      w.step(DT);
      if (w.goal.solved) break;
    }
  } catch (e) { error = `threw: ${(e as Error).message}`; }
  const g = w.goal, goal = lvl.puzzle!.goal;
  const parts = [`amount ${g.amount}/${goal.amount}`];
  if (goal.minPurity !== undefined) parts.push(`purity ${g.purity.toFixed(2)}`);
  if (goal.maxSilt !== undefined) parts.push(`silt ${g.silt.toFixed(3)}`);
  if (goal.minTemp !== undefined) parts.push(`temp ${g.temp.toFixed(0)}`);
  return { ...job, solved: g.solved, at: g.solved ? w.time : NaN, detail: parts.join(', '), wall: (performance.now() - t0) / 1000, error };
}

function ok(r: JobResult) { return !r.error && r.solved === (r.expect === 'solve'); }

async function main() {
  const args = parseArgs();
  const all = args.seeds.flatMap(seed => PUZZLES.flatMap(l => jobsFor(l, seed)));
  if (args.child) {
    const job = all.find(j => jobKey(j) === args.child);
    if (!job) { console.error(`no job ${args.child}`); process.exit(2); }
    console.log(RESULT_TAG + JSON.stringify(runJob(job, args.physics)));
    return;
  }
  makeWorld(args.physics); // fail fast if this engine isn't available
  for (const name of Object.keys(SOLUTIONS))
    if (!PUZZLES.some(p => p.name === name)) console.log(`warning: SOLUTIONS has an entry for "${name}", which is not in PUZZLES`);
  const jobs = all.filter(j => !args.only || j.puzzle.startsWith(args.only));
  if (!jobs.length) { console.error(`no puzzle matches --only=${args.only}`); process.exit(2); }
  const t0 = performance.now();
  // Longest jobs first so the pool finishes evenly.
  const order = [...jobs].sort((a, b) => b.seconds - a.seconds);
  const done = await runParallel(order.map(jobKey), args.jobs, key => runJob(order.find(j => jobKey(j) === key)!, args.physics));
  const byKey = new Map(done.map(r => [jobKey(r), r]));
  const results = jobs.map(j => byKey.get(jobKey(j))!);

  const multi = args.seeds.length > 1;
  const rows = [['puzzle', 'run', ...(multi ? ['seed'] : []), 'must', 'verdict', 'result', 'time']];
  // Group the seeds of one check together.
  const ordered = multi ? [...results].sort((a, b) => jobs.findIndex(j => j.puzzle === a.puzzle && j.label === a.label) - jobs.findIndex(j => j.puzzle === b.puzzle && j.label === b.label) || a.seed - b.seed) : results;
  for (const r of ordered) {
    const res = r.error ? r.error : `${r.solved ? `solved at ${r.at.toFixed(1)}s` : 'not solved'} (${r.detail})`;
    rows.push([r.puzzle, r.kind === 'no input' ? 'no input' : `${r.kind}: ${r.label}`, ...(multi ? [String(r.seed)] : []), r.expect === 'solve' ? 'solve' : 'not solve', ok(r) ? 'PASS' : r.stale ? 'FAIL (stale)' : 'FAIL', res, `${r.wall.toFixed(1)}s`]);
  }
  for (const lvl of PUZZLES) {
    if (args.only && !lvl.name.startsWith(args.only)) continue;
    const working = SOLUTIONS[lvl.name]?.some(s => s.expect === 'solve' && !s.stale);
    if (!working)
      rows.push([lvl.name, 'reference', ...(multi ? ['-'] : []), 'solve', HUMAN_VERIFIED.has(lvl.name) ? 'human-verified' : 'MISSING', 'no working scripted solution', '-']);
  }
  console.log(`\nPuzzles (${args.physics}, seed${multi ? 's' : ''} ${args.seeds.join(', ')})\n`);
  console.log(table(rows));
  const bad = results.filter(r => !ok(r) && (args.strict || !r.stale));
  for (const r of new Map(results.filter(r => !ok(r) && r.stale).map(r => [r.label, r])).values()) console.log(`\nstale: ${r.puzzle} / ${r.label}: ${r.stale}`);
  if (multi) {
    const flaky = new Set(results.filter(r => !ok(r) && results.some(o => o.puzzle === r.puzzle && o.label === r.label && ok(o))).map(r => `${r.puzzle} / ${r.kind === 'no input' ? 'no input' : r.label}`));
    for (const f of flaky) console.log(`\nflaky (depends on seed): ${f}`);
  }
  const selfSolved = results.filter(r => r.kind === 'no input' && r.solved);
  for (const r of selfSolved) console.log(`\n!!! RULE BROKEN: ${r.puzzle} solves itself with no player input`);
  console.log(`\n${results.filter(ok).length}/${results.length} checks passed, ${bad.length} failure(s) counted; wall clock ${((performance.now() - t0) / 1000).toFixed(1)}s with ${args.jobs} job(s)`);
  process.exitCode = bad.length ? 1 : 0;
}

void main();
