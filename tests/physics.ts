/**
 * Canonical physics scenarios (design/unified-physics.md, "Validation scenarios"), run headlessly.
 *
 *   npm run test:physics
 *   npm run test:physics -- --only=siphon --jobs=1 --verbose
 *
 * Each scenario builds its own small level, runs it, and reports one metric against a pass threshold.
 * Thresholds come from the design doc. `expected` records a scenario's known baseline, so a known failure stays
 * visible without failing the run.
 * Exit code is non-zero on unexpected failures (any failure with --strict).
 */
import { CELL, CUP_INTERIOR, LEVELS, NX } from '../src/world';
import { OIL, WATER } from '../src/sim/fluid';
import { phaseLedger } from '../src/sim2/phase';
import {
  Args, Expect, ascii, RESULT_TAG, Result, builder, countIn, fmt, gasCellsIn, gasTotals, holdTemp, kindCounts,
  loadWorld, maxSpeed, mean, openCells, parseArgs, percentile, seedRandom, rect, report, run, runParallel, surfaceFromCount, ysIn,
} from './lib';

const G = 800; // px/s², DEFAULT_PARAMS.gravity
const P0 = 60000; // atmospheric pressure, px²/s² (sim2 P0)

interface Outcome { pass: boolean; metric: string; threshold: string; note?: string }
interface Scenario {
  id: string;
  name: string;
  expected: Expect;
  /** Why the expectation is what it is, shown when the result matches a non-pass expectation. */
  why?: string;
  run: (verbose: boolean) => Outcome;
}

const log = (verbose: boolean, ...a: unknown[]) => { if (verbose) console.log(...a); };

const levelByName = (name: string) => {
  const l = LEVELS.find(l => l.name === name);
  if (!l) throw new Error(`level "${name}" not found in LEVELS`);
  return l;
};

const SCENARIOS: Scenario[] = [
  // 1 -------------------------------------------------------------------------------------------
  {
    id: 'hydrostatic', name: '1. Hydrostatic rest',
    expected: 'pass',
    run: (verbose) => {
      const w = loadWorld(b => {
        b.solid(30, 40, 32, 82); b.solid(128, 40, 130, 82); b.solid(30, 80, 130, 82);
        b.water(33, 56, 127, 79);
      });
      run(w, 3);
      let peak = 0, p99 = 0;
      const speeds: number[] = [];
      run(w, 2, w => {
        const s = maxSpeed(w);
        peak = Math.max(peak, s);
        speeds.push(s);
        const f = w.fluid, all: number[] = [];
        for (let k = 0; k < f.count; k++) all.push(Math.hypot(f.vel[2 * k], f.vel[2 * k + 1]));
        p99 = Math.max(p99, percentile(all, 0.99));
      });
      log(verbose, '  max speed per 10 frames', speeds.filter((_, n) => n % 10 === 0).map(s => s.toFixed(1)).join(' '));
      return { pass: peak < 5, metric: `max speed ${fmt(peak)} px/s (99th pct ${fmt(p99)}, mean per-frame max ${fmt(mean(speeds))})`, threshold: '< 5 px/s over 2 s, after 3 s' };
    },
  },
  // 2 -------------------------------------------------------------------------------------------
  {
    id: 'utube', name: '2. U-tube equalization',
    expected: 'pass',
    run: (verbose) => {
      // Geometry of LEVELS 'U-Tube', but started out of balance instead of with a faucet.
      const w = loadWorld(b => {
        b.solid(40, 20, 120, 80);
        b.open(46, 20, 54, 72); b.open(106, 20, 114, 72); b.open(46, 66, 114, 72);
        b.water(46, 30, 54, 72); b.water(55, 66, 114, 72);
      });
      const L = rect(46, 0, 54, 65), R = rect(106, 0, 114, 65);
      let diff = NaN;
      run(w, 15, (w, n) => {
        if (n % 60 === 0) log(verbose, `  t=${n / 60}s left ${fmt(surfaceFromCount(w, L, 66))} right ${fmt(surfaceFromCount(w, R, 66))}`);
      });
      const l = surfaceFromCount(w, L, 66), r = surfaceFromCount(w, R, 66);
      diff = Math.abs(l - r);
      return { pass: diff <= 1, metric: `levels ${fmt(l)} / ${fmt(r)} (row), diff ${fmt(diff, 2)} cells`, threshold: '<= 1 cell after 15 s' };
    },
  },
  // 3 -------------------------------------------------------------------------------------------
  {
    id: 'siphon', name: '3. Siphon',
    expected: 'pass',
    run: (verbose) => {
      const w = loadWorld(levelByName('Siphon'));
      // High tank interior, minus the hose leg that dips into it.
      const tank = rect(13, 22, 57, 59), hoseLeg = rect(43, 22, 45, 59);
      const inTank = () => countIn(w, tank) - countIn(w, hoseLeg);
      const n0 = inTank();
      let drainedAt = NaN, at10 = NaN;
      run(w, 20, (_, n) => {
        if (n === 600) at10 = inTank() / n0;
        if (n % 120 === 0) log(verbose, `  t=${n / 60}s high tank ${(100 * inTank() / n0).toFixed(1)}%`);
        if (Number.isNaN(drainedAt) && inTank() < 0.5 * n0) drainedAt = n / 60;
      });
      const frac = inTank() / n0;
      return {
        pass: frac < 0.5, metric: `high tank at ${(100 * at10).toFixed(1)}% at 10 s, ${(100 * frac).toFixed(1)}% at 20 s${Number.isNaN(drainedAt) ? '' : ` (<50% at ${fmt(drainedAt)} s)`}`,
        threshold: '< 50% within 20 s',
      };
    },
  },
  // 4 -------------------------------------------------------------------------------------------
  {
    id: 'pythagorean', name: '4. Pythagorean cup',
    expected: 'pass',
    run: (verbose) => {
      const w = loadWorld(levelByName('Pythagorean Cup'));
      // The faucet runs until the siphon fires (water comes out under the cup floor), then is shut off.
      const outlet = rect(108, 73, 110, 85);
      let peak = 0, firedAt = NaN;
      run(w, 60, (w, n) => {
        const c = countIn(w, CUP_INTERIOR);
        peak = Math.max(peak, c);
        if (Number.isNaN(firedAt) && countIn(w, outlet) > 20) { firedAt = n / 60; w.emitters[0].on = false; }
        if (n % 120 === 0) log(verbose, `  t=${n / 60}s cup ${c} outlet ${countIn(w, outlet)}`);
        return !Number.isNaN(firedAt) && n / 60 > firedAt + 25;
      });
      const left = countIn(w, CUP_INTERIOR), frac = peak ? left / peak : 1;
      // It can only drain down to the top of the siphon's inlet (row 66): what's below that is the residue.
      const level = surfaceFromCount(w, CUP_INTERIOR, CUP_INTERIOR.j1 + 1);
      // The crest sits ~27 rows above the floor across a 54-wide cup: a real fill holds well over 2000 particles.
      const filled = peak > 2000;
      return {
        pass: filled && !Number.isNaN(firedAt) && level >= 65,
        metric: `peak ${peak}, fired ${Number.isNaN(firedAt) ? 'never' : `at ${fmt(firedAt)} s`}, residue ${left} (${(100 * frac).toFixed(1)}%, level row ${fmt(level)}) 25 s later`,
        threshold: 'peak > 2000, fires, drains to the inlet top (row >= 65) within 25 s',
      };
    },
  },
  // 5 -------------------------------------------------------------------------------------------
  {
    id: 'bubble', name: '5. Bubble rise',
    expected: 'pass',
    run: (verbose) => {
      // A sealed stone bottle of air at the bottom of a deep tank; its cap is erased at t = 0.
      const tankIn = rect(53, 20, 107, 79);
      const bottle = rect(74, 66, 86, 79);
      const w = loadWorld(b => {
        b.solid(50, 16, 52, 82); b.solid(108, 16, 110, 82); b.solid(50, 80, 110, 82);
        // Water everywhere except the bottle, so the bottle starts as air at ambient pressure (not a vacuum:
        // in the unified engine a cell that was liquid and empties starts with no gas).
        b.water(53, 24, 71, 79); b.water(89, 24, 107, 79); b.water(72, 24, 88, 61);
        b.solid(72, 62, 73, 79); b.solid(87, 62, 88, 79); b.solid(72, 62, 88, 65); // bottle walls + cap
      });
      run(w, 0.5);
      const air0 = gasTotals(w, bottle).air;
      openCells(w, 76, 62, 84, 65); // uncork
      let surfacedAt = NaN;
      const vol = (bottle.i1 - bottle.i0 + 1) * (bottle.j1 - bottle.j0 + 1);
      run(w, 20, (w, n) => {
        // Gas trapped anywhere below the top 6 rows of water counts as "not yet surfaced".
        const surf = percentile(ysIn(w, tankIn), 0.02);
        const trapped = gasCellsIn(w, rect(tankIn.i0, Math.ceil(surf) + 6, tankIn.i1, tankIn.j1));
        if (n % 300 === 0) log(verbose, ascii(w, rect(50, 16, 110, 82)));
        if (n % 60 === 0) log(verbose, `  t=${n / 60}s bottle water ${countIn(w, bottle)} trapped gas cells ${trapped} surface row ${fmt(surf)}`);
        if (Number.isNaN(surfacedAt) && trapped < 0.05 * vol && countIn(w, bottle) > 0.8 * vol * w.fluid.restDensity) surfacedAt = n / 60;
      });
      const surf = percentile(ysIn(w, tankIn), 0.02);
      const trapped = gasCellsIn(w, rect(tankIn.i0, Math.ceil(surf) + 6, tankIn.i1, tankIn.j1));
      const air1 = gasTotals(w, bottle).air;
      const filled = countIn(w, bottle) / (vol * w.fluid.restDensity);
      return {
        pass: !Number.isNaN(surfacedAt),
        metric: `bottle ${(100 * filled).toFixed(0)}% liquid, ${trapped} gas cells trapped${Number.isNaN(surfacedAt) ? '' : `, surfaced at ${fmt(surfacedAt)} s`}${air0 !== null && air1 !== null ? `, bottle air ${fmt(air0, 2)} -> ${fmt(air1, 2)}` : ''}`,
        threshold: 'bottle >80% liquid and <5% of its volume as gas below the surface, within 20 s',
      };
    },
  },
  // 6 -------------------------------------------------------------------------------------------
  {
    id: 'syringe', name: '6. Syringe (Boyle)',
    expected: 'pass',
    run: (verbose) => {
      // J-tube: closed left arm traps air at atmospheric pressure over water; the open right arm gets topped up.
      // P = P0 + ρ g Δh from the two water levels (engine-independent), V = air volume in the closed arm.
      const W = 6;
      const closed = rect(20, 20, 25, 63), open = rect(40, 2, 45, 63), FLOOR = 64;
      const w = loadWorld(b => {
        b.solid(17, 17, 48, 72);
        b.open(20, 20, 25, 70); b.open(40, 1, 45, 70); b.open(20, 64, 45, 70);
        b.water(20, 50, 25, 70); b.water(40, 50, 45, 70); b.water(26, 64, 39, 70);
      });
      const measure = () => {
        const hc = surfaceFromCount(w, closed, FLOOR), ho = surfaceFromCount(w, open, FLOOR);
        const V = (hc - closed.j0) * W; // cells of air above the closed arm's water
        const P = P0 + G * (hc - ho) * CELL; // ρ = 1
        return { hc, ho, V, P, PV: P * V };
      };
      run(w, 5);
      const a = measure();
      builder(w).water(40, 8, 45, 49); // pour a column into the open arm
      run(w, 15, (_, n) => { if (n % 120 === 0) { const m = measure(); log(verbose, `  t=${n / 60}s closed ${fmt(m.hc)} open ${fmt(m.ho)} V ${fmt(m.V)} P/P0 ${fmt(m.P / P0, 3)}`); } });
      const b = measure();
      const ratio = b.PV / a.PV;
      return {
        pass: Math.abs(ratio - 1) <= 0.1 && b.V < 0.85 * a.V,
        metric: `V ${fmt(a.V)} -> ${fmt(b.V)} cells, P/P0 ${fmt(a.P / P0, 2)} -> ${fmt(b.P / P0, 2)}, PV ratio ${fmt(ratio, 3)}`,
        threshold: 'PV within 10% and V shrinks >15%',
      };
    },
  },
  // 7 -------------------------------------------------------------------------------------------
  {
    id: 'hero', name: "7. Hero's fountain",
    expected: 'pass',
    run: (verbose) => {
      // Open basin (top) drains into sealed chamber A (bottom left); A's air is piped to the top of sealed chamber B
      // (middle right), whose water is pushed up a nozzle that ends above the basin's water surface.
      const SOURCE = 8; // basin water surface row
      const nozzle = rect(86, 1, 87, 41);
      const w = loadWorld(b => {
        // Basin, open on top, outlet in the floor at i 10..11.
        b.solid(4, 4, 5, 31); b.solid(47, 4, 48, 31); b.solid(4, 30, 48, 31); b.open(10, 30, 11, 31);
        b.water(6, SOURCE, 46, 29);
        // Drain pipe down to A.
        b.solid(9, 32, 9, 59); b.solid(12, 32, 12, 59);
        // Chamber A: interior i 6..30, j 61..72; holes in its lid for the drain pipe and the air tube.
        b.solid(4, 59, 32, 60); b.solid(4, 73, 32, 74); b.solid(4, 59, 5, 74); b.solid(31, 59, 32, 74);
        b.open(10, 59, 11, 60); b.open(27, 59, 28, 60);
        // Air tube: up from A at i 27..28 to row 37..38, across, down into B's lid at i 74..75.
        b.solid(26, 36, 26, 58); b.solid(29, 39, 29, 58);
        b.solid(26, 35, 77, 36); b.solid(29, 39, 73, 39);
        b.solid(73, 39, 73, 41); b.solid(76, 37, 77, 41);
        // Chamber B: interior i 60..90, j 42..54.
        b.solid(58, 40, 92, 41); b.solid(58, 55, 92, 56); b.solid(58, 40, 59, 56); b.solid(91, 40, 92, 56);
        b.open(74, 40, 75, 41);
        b.water(60, 43, 90, 54);
        // Nozzle: from near B's floor up through its lid to row 3 (above the basin surface), open at the top.
        b.solid(85, 3, 85, 52); b.solid(88, 3, 88, 52); b.open(86, 40, 87, 41);
        // Overflow catch: anything spilling from the nozzle falls to a drain.
        b.drain(34, 86, 120, 86);
      });
      let top = Infinity;
      run(w, 40, (w, n) => {
        if (n % 600 === 0) log(verbose, ascii(w, rect(2, 4, 95, 76)));
        const ys = ysIn(w, nozzle);
        // Highest point the jet reaches: 3rd-highest particle in the nozzle column, ignoring stray single drops.
        const s = ys.sort((a, b) => a - b)[Math.min(2, ys.length - 1)] ?? Infinity;
        if (n > 30) top = Math.min(top, s);
        if (n % 120 === 0) log(verbose, `  t=${n / 60}s jet top row ${fmt(s)} basin ${countIn(w, rect(6, 4, 46, 29))} A ${countIn(w, rect(6, 61, 30, 72))}`);
      });
      return {
        pass: top < SOURCE - 1,
        metric: `jet reached row ${fmt(top)} vs source surface row ${SOURCE} (${fmt(SOURCE - top)} cells above)`,
        threshold: '> 1 cell above the source surface within 40 s',
      };
    },
  },
  // 8 -------------------------------------------------------------------------------------------
  {
    id: 'boil', name: '8. Boiling pot',
    expected: 'pass',
    run: (verbose) => {
      // Pot on a hot plate under a cold roof that slopes up to the right, past the pot's rim.
      const pot = rect(52, 50, 88, 69), plate = rect(48, 70, 92, 72);
      const roof: { i: number; j: number }[] = [];
      const w = loadWorld(b => {
        b.solid(50, 46, 51, 72); b.solid(89, 46, 90, 72); b.solid(48, 70, 92, 72);
        b.water(52, 56, 88, 69);
        for (let i = 40; i <= 130; i++) { const j = Math.round(34 - (i - 40) * 0.15); b.solid(i, j, i, j + 1); roof.push({ i, j }); }
        b.solid(10, 84, 150, 86); // floor to catch condensate
      });
      const n0 = countIn(w, pot, WATER);
      let peakVapor = 0;
      run(w, 40, (w, n) => {
        holdTemp(w, plate, 300);
        for (const { i, j } of roof) { w.thermo.T[i + j * NX] = 5; w.thermo.T[i + (j + 1) * NX] = 5; }
        const v = gasTotals(w).vapor;
        peakVapor = Math.max(peakVapor, v);
        if (n % 300 === 0) log(verbose, `  t=${n / 60}s pot ${countIn(w, pot, WATER)} vapor ${fmt(v)} outside ${kindCounts(w).water - countIn(w, pot, WATER)}`);
      });
      const inPot = countIn(w, pot, WATER), outside = kindCounts(w).water - inPot;
      const lost = 1 - inPot / n0;
      return {
        pass: lost > 0.1 && peakVapor > 0 && outside >= 20,
        metric: `pot lost ${(100 * lost).toFixed(1)}%, peak vapor ${fmt(peakVapor)}, condensed outside pot ${outside}`,
        threshold: 'pot loses >10% in 40 s, vapor seen, >=20 condensed outside',
      };
    },
  },
  // 9 -------------------------------------------------------------------------------------------
  {
    id: 'boiler', name: '9. Sealed boiler',
    expected: 'pass',
    run: (verbose) => {
      // LEVELS 'Steam Boiler' with its floor held hot instead of lighting the oil tray.
      const w = loadWorld(levelByName('Steam Boiler'));
      const cup = rect(108, 48, 131, 70), floor = rect(52, 61, 88, 62);
      let at = NaN;
      run(w, 45, (w, n) => {
        holdTemp(w, floor, 250);
        const c = countIn(w, cup);
        if (Number.isNaN(at) && c >= 100) at = n / 60;
        if (n % 300 === 0) log(verbose, `  t=${n / 60}s cup ${c}`);
      });
      const c = countIn(w, cup);
      return {
        pass: c >= 100,
        metric: `cup ${c}${Number.isNaN(at) ? '' : ` (100 at ${fmt(at)} s)`}`,
        threshold: '>= 100 water lifted into the cup within 45 s',
      };
    },
  },
  // 10 ------------------------------------------------------------------------------------------
  {
    id: 'oil', name: '10. Oil floats',
    expected: 'pass',
    run: (verbose) => {
      const tank = rect(33, 30, 127, 79);
      const w = loadWorld(b => {
        b.solid(30, 30, 32, 82); b.solid(128, 30, 130, 82); b.solid(30, 80, 130, 82);
        b.oil(33, 72, 127, 79); b.water(33, 50, 127, 71);
      });
      run(w, 20, (w, n) => { if (n % 120 === 0) log(verbose, `  t=${n / 60}s oil mean row ${fmt(mean(ysIn(w, tank, OIL)))} water mean row ${fmt(mean(ysIn(w, tank, WATER)))}`); });
      const oil = ysIn(w, tank, OIL), waterTop = percentile(ysIn(w, tank, WATER), 0.1);
      const onTop = oil.filter(y => y < waterTop).length / Math.max(1, oil.length);
      return {
        pass: onTop >= 0.9,
        metric: `${(100 * onTop).toFixed(1)}% of oil above the water's 10th-percentile row`,
        threshold: '>= 90% after 20 s',
      };
    },
  },
  // 11 ------------------------------------------------------------------------------------------
  {
    id: 'mass', name: '11. Mass conservation',
    expected: 'pass',
    run: (verbose) => {
      // Sealed box: a dam-break slosh over a hot floor (to make vapor), then the heat is cut so it condenses.
      const box = rect(41, 31, 119, 79), floor = rect(41, 80, 119, 81);
      const w = loadWorld(b => {
        b.solid(38, 28, 122, 30); b.solid(38, 80, 122, 82); b.solid(38, 28, 40, 82); b.solid(120, 28, 122, 82);
        b.water(41, 50, 70, 79);
      });
      // Liquid in particles, less what the phase ledger says the particles still owe (mass already moved to vapor),
      // plus condensate not yet gathered into a whole particle (fine mist): all of it is real mass.
      const liquid = () => kindCounts(w).total - phaseLedger().mass * w.fluid.restDensity;
      const tot = () => { const g = gasTotals(w, box); return { liq: liquid(), vap: g.vapor, air: g.air }; };
      run(w, 0.1); // let the air region be labelled
      const a = tot();
      let worst = 0, worstAir = 0;
      run(w, 30, (w, n) => {
        if (n < 15 * 60) holdTemp(w, floor, 200);
        const t = tot();
        worst = Math.max(worst, Math.abs((t.liq + t.vap) / (a.liq + a.vap) - 1));
        if (a.air !== null && t.air !== null) worstAir = Math.max(worstAir, Math.abs(t.air / a.air - 1));
        if (n % 300 === 0) log(verbose, `  t=${n / 60}s liquid ${t.liq} vapor ${fmt(t.vap)} air ${t.air === null ? '-' : fmt(t.air)}`);
      });
      const b = tot();
      const drift = (b.liq + b.vap) / (a.liq + a.vap) - 1;
      const airDrift = a.air !== null && b.air !== null ? b.air / a.air - 1 : null;
      return {
        pass: worst <= 0.01 && (airDrift === null || worstAir <= 0.01),
        metric: `liquid+vapor ${fmt(a.liq)}+${fmt(a.vap)} -> ${fmt(b.liq)}+${fmt(b.vap)} (${(100 * drift).toFixed(2)}%, worst ${(100 * worst).toFixed(2)}%)`
          + (airDrift === null ? ', air n/a' : `, air ${(100 * airDrift).toFixed(2)}% (worst ${(100 * worstAir).toFixed(2)}%)`),
        threshold: 'liquid+vapor and air each within 1% at every frame over 30 s',
      };
    },
  },
];

// ---------------------------------------------------------------- main

function runOne(id: string, args: Args): Result {
  const s = SCENARIOS.find(s => s.id === id)!;
  seedRandom(args.seed);
  const t0 = performance.now();
  let o: Outcome;
  try { o = s.run(args.verbose); } catch (e) { o = { pass: false, metric: `threw: ${(e as Error).message}`, threshold: '-' }; }
  const expected = s.expected;
  const note = expected !== 'pass' ? s.why : o.note;
  return { name: s.name, pass: o.pass, metric: o.metric, threshold: o.threshold, expected, seconds: (performance.now() - t0) / 1000, note };
}

async function main() {
  const args = parseArgs();
  if (args.child) { console.log(RESULT_TAG + JSON.stringify(runOne(args.child, args))); return; }
  const picked = SCENARIOS.filter(s => !args.only || s.id.startsWith(args.only) || s.name.toLowerCase().includes(args.only.toLowerCase()) || s.name.startsWith(args.only));
  if (!picked.length) { console.error(`no scenario matches --only=${args.only}; ids: ${SCENARIOS.map(s => s.id).join(', ')}`); process.exit(2); }
  const t0 = performance.now();
  const results = await runParallel(picked.map(s => s.id), args.verbose ? 1 : args.jobs, id => runOne(id, args));
  const bad = report(`Physics scenarios (seed ${args.seed})`, results, args.strict);
  console.log(`wall clock ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  process.exitCode = bad ? 1 : 0;
}

void main();
