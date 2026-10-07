# Mobile Release Plan ($1)

## Recommended path

**Ship the existing web game inside native app shells with Capacitor**, one codebase for iOS and Android. The game is already TypeScript + Canvas with no server, so it ports without a rewrite. The work is performance, touch controls, content, and store logistics.

Alternatives considered:
- **PWA only.** Free to ship, but there's no App Store discovery and charging for it is awkward. Fine as a free web demo alongside the store builds.
- **Rewrite in a native engine** (Unity/Godot). Months of work for little gain. The simulation is the product, and it already runs in a browser.

## 1. Performance (the biggest risk)

Today the simulation costs about 4–12 ms per frame on a desktop CPU. Phones are 2–4× slower and throttle when hot, so a budget of about 8 ms per frame on a mid-range phone means real work:

1. **Measure first.** Profile on a ~2019 iPhone (iPhone 11) and a mid-range Android (Pixel 6a or a Samsung A-series).
2. **Move the simulation to a Web Worker.** The UI stays responsive, and the worker sends a finished 320×180 image back each frame (57 KB, cheap to transfer). Rendering with OffscreenCanvas inside the worker is supported on iOS 16.4+.
3. **Fixed simulation rate.** Run the sim at a fixed 60 Hz, dropping to 30 Hz on slow devices or when the phone runs hot, and keep drawing at screen rate.
4. **Cap particles per level** (about 6–8k). Design puzzles within the cap.
5. **If still short:** port the hot loops (pressure solve, particle separation, transfers) to WebAssembly (Rust or AssemblyScript). They're plain typed-array loops that port mechanically. Expect a 2–3× speedup.

Also needed for fairness and replays: a **seeded random number generator** so a given solution always plays out the same way. Right now runs differ slightly from one to the next.

## 2. Touch controls and layout

- **Landscape only.** The world is 16:9, and at phone sizes it scales to about 2.5× (pixel-crisp).
- **Bottom toolbar** with tool chips showing budgets, a big Play/Pause button, and the goal meter as an overlay along the top.
- **Brushes**
  - Draw with one finger. Show a small magnifier above the finger, since the finger hides what it's touching.
  - Two-finger tap = **undo**.
  - Long-press = erase.
  - Pinch to zoom and pan for precise building.
- **Undo/redo** for everything placed before Play (essential on touch).
- **Haptics** on placing, on running out of budget, and on solving.
- Safe areas (notches, home indicator) and readable text sizes.

## 3. Content worth a dollar

A $1 premium puzzle game should offer about **30–40 puzzles plus a sandbox**:

- **Acts:** water and pressure → oil and fire → mud → ice and wax → steam → machines (once rigid bodies exist).
- **A 3–5 puzzle tutorial** that teaches by doing, with almost no text.
- **The sandbox** unlocks after Act 1.
- **Scores** per puzzle (parts used, time, heat used), with local best-score histograms. Global leaderboards via Game Center / Google Play Games could come later; they need no server of our own.
- **Sound is essential and currently missing:**
  - Water trickle and splash
  - Fire crackle, sizzle when water hits fire, boiling, steam hiss
  - Ambient music
- **Polish:** level select map, solve celebration, short replay of your solution.
- **Settings:** sound, reduced motion, colorblind-safe palette (water vs. oil is currently blue vs. gold, which is OK, but should be checked).

## 4. Pricing model

| Option | Upside | Downside |
|---|---|---|
| **Paid upfront, $0.99** | Simplest. No in-app purchase code, no "free with catches" stigma. | Paid apps get a small fraction of the downloads free ones do, and there's no way to try before buying. |
| **Free download + one-time $0.99 unlock** (recommended) | Players try the first act and the tutorial, then pay to continue. Better conversion and store visibility. | Needs in-app purchase integration (a Capacitor plugin such as RevenueCat or native StoreKit / Play Billing), plus restore-purchases. |

Either way: **no ads, no tracking.** That keeps privacy labels simple ("Data Not Collected") and avoids consent prompts.

**What a $0.99 sale nets:** Apple's and Google's small-business rate is 15%, and VAT/GST is taken out first in many countries, so expect roughly $0.70–0.85 per sale. The Apple developer account is $99/year, so it takes about 120–140 sales a year just to cover that. Google's fee is a one-time $25. *Check these fees and rates against current terms before launch.*

## 5. Store logistics

- **Accounts:** Apple Developer Program, Google Play Console. Both need banking and tax forms; give that a week or two.
- **Google Play's testing requirement:** new personal developer accounts must run a closed test with a minimum number of testers (recently 12) for 14 days before going to production. Start recruiting testers early.
- **Apple review:** wrapped web apps can be rejected for "minimum functionality". A complete game with real content, offline play and native touch controls clears that bar. Make sure it works fully offline with no browser feel: no zoom bounce, no text selection, no browser chrome.
- **Store assets:**
  - App icon
  - Screenshots for the required phone sizes (and tablet, if supporting iPad)
  - A 15–30 second preview video. The grease fire and the dam bursting sell themselves.
  - Description and keywords
- **Policies:** privacy policy page (one paragraph if nothing is collected), age rating questionnaire (fire is fine), support URL or email.
- **Name check:** search trademarks and both stores for "Pressure Lab" before investing in branding.

## 6. Phases

| Phase | Work | Rough size |
|---|---|---|
| 1. Performance foundation | Device profiling, Web Worker, seeded RNG, fixed-step sim, particle caps; decide on WebAssembly | 1–2 weeks |
| 2. Mobile UX | Touch tools, undo/redo, zoom/pan, new layout, haptics, save data via Capacitor storage | 2 weeks |
| 3. Content and juice | 30–40 puzzles, tutorial, sound and music, level map, scores, art polish | 4–8 weeks (the long pole) |
| 4. Packaging | Capacitor iOS/Android projects, icons, splash, offline, in-app purchase or paid setup, store listings | 1 week |
| 5. Beta | TestFlight + Play closed test (14+ days), fix device-specific issues, balance puzzles from player data | 2–3 weeks |
| 6. Launch | Submit, respond to review, launch trailer and posts (r/WebGames, r/puzzlevideogames, TikTok clips of sim moments) | 1 week |

About 3 months part-time to a credible launch, with content as the variable.

## Decisions needed

1. **Paid upfront or free + unlock?** (Recommend free + unlock.)
2. **iPhone only first, or both stores at launch?** Both is little extra code, but double the store logistics. Google's 14-day closed test makes it worth starting Android early.
3. **Name.**
4. **Scope of v1:** are machines (rigid bodies) in v1, or a post-launch update? Recommend post-launch "Act 5" as a free update. It gives a reason to come back and a news hook.
