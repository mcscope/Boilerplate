import './style.css';
import { Renderer } from './render';
import { OIL, WATER } from './sim/fluid';
import { ICE, MUD, NONE, STONE, WAX_SOLID, WOOD } from './sim/thermo';
import { PUZZLES } from './puzzles';
import { brushIcon, installPixelUI, toolIcon } from './ui/pixel';
import { H, LEVELS, Level, Physics, W, World } from './world';

type Tool = 'wall' | 'erase' | 'water' | 'muddy' | 'oil' | 'mud' | 'wood' | 'ice' | 'wax' | 'steam' | 'fire' | 'chill' | 'sponge';

const TOOLS: { id: Tool; label: string; key: string; hint: string }[] = [
  { id: 'wall', label: 'Wall', key: 'W', hint: 'Draw stone. Right-drag erases.' },
  { id: 'erase', label: 'Erase', key: 'E', hint: 'Remove any solid. Right-drag draws stone.' },
  { id: 'water', label: 'Water', key: 'Q', hint: 'Pour water. Right-drag soaks liquid up.' },
  { id: 'muddy', label: 'Muddy water', key: 'U', hint: 'Pour silty water. Silt settles out where the water is calm and builds up as mud. Right-drag soaks liquid up.' },
  { id: 'oil', label: 'Oil', key: 'O', hint: 'Pour oil. It floats on water and burns above 250°. Right-drag soaks liquid up.' },
  { id: 'mud', label: 'Mud', key: 'D', hint: 'Place solid mud. Fast-flowing water erodes it into muddy water. Right-drag erases.' },
  { id: 'wood', label: 'Wood', key: 'L', hint: 'Place wood. Porous: soaks up wax, oil or water and carries it along its grain. A thin soaked stick is a wick. Burns above 300° where it touches air; wet wood must dry first. Right-drag erases.' },
  { id: 'ice', label: 'Ice', key: 'I', hint: 'Place ice. It melts above 0° once it has soaked up enough heat. Right-drag erases.' },
  { id: 'wax', label: 'Wax', key: 'X', hint: 'Place solid wax. Melts above 60°, flows, and sets again below 55°. Burns above 300°. Right-drag erases.' },
  { id: 'steam', label: 'Steam', key: 'M', hint: 'Release steam. It rises, pressurizes sealed pockets, and condenses as it cools.' },
  { id: 'fire', label: 'Fire', key: 'F', hint: 'Blowtorch: heats to 800°. Boils water, melts ice and wax, ignites oil and wood. Right-drag chills.' },
  { id: 'chill', label: 'Chill', key: 'C', hint: 'Cools to -40°. Freezes water into ice. Right-drag heats.' },
  { id: 'sponge', label: 'Sponge', key: 'S', hint: 'Soak up liquid. Right-drag pours water.' },
];
const OPPOSITE: Record<Tool, Tool> = {
  wall: 'erase', erase: 'wall', water: 'sponge', muddy: 'sponge', mud: 'erase', wood: 'erase', oil: 'sponge', ice: 'erase', wax: 'erase', steam: 'sponge', fire: 'chill', chill: 'fire', sponge: 'water',
};
const BRUSH_COLOR: Record<Tool, [number, number, number]> = {
  wall: [255, 255, 255], erase: [255, 120, 110], water: [140, 210, 255], muddy: [190, 150, 100], mud: [150, 110, 70], wood: [190, 130, 70], oil: [240, 200, 90], ice: [200, 240, 255], wax: [250, 230, 180],
  steam: [230, 230, 240], fire: [255, 150, 50], chill: [120, 180, 255], sponge: [255, 220, 120],
};
type View = 'normal' | 'pressure' | 'temperature';
const BRUSHES = [2, 3, 5, 9]; // radii in px; labelled by diameter
/** Which budget an erased material refunds. */
const REFUND: Record<number, Tool> = { [STONE]: 'wall', [WOOD]: 'wood', [ICE]: 'ice', [WAX_SOLID]: 'wax', [MUD]: 'mud' };
const SOLID_TOOL: Partial<Record<Tool, number>> = { wall: STONE, erase: NONE, ice: ICE, wax: WAX_SOLID, mud: MUD, wood: WOOD };

/** Puzzles first, then the free-play playgrounds. */
const ALL: Level[] = [...PUZZLES, ...LEVELS];
/** Physics engine: ?physics=unified|classic in the URL wins, then the saved choice, then unified (the default). */
function initialPhysics(): Physics {
  const q = new URLSearchParams(location.search).get('physics');
  if (q === 'unified' || q === 'classic') return q;
  try { if (localStorage.getItem('physics') === 'classic') return 'classic'; } catch { /* storage unavailable */ }
  return 'unified';
}
let world = new World(initialPhysics());
/**
 * Puzzle difficulty. Locked: build while paused; once the run starts, building is locked until Reset.
 * Live: edit while it runs.
 */
type EditMode = 'locked' | 'live';
let editMode: EditMode = (() => { try { return localStorage.getItem('editMode') === 'locked' ? 'locked' : 'live'; } catch { return 'live'; } })();
let lockNoticeShown = false;
let levelIndex = 0;
/** Remaining tool budgets in a puzzle (cells, or seconds for fire / chill); null in free play. */
let budget: Record<string, number> | null = null;
/** How much of each tool the player has used this attempt (the score for unlimited tools like walls). */
let used: Record<string, number> = {};
let solvedShown = false;
let hintShown = false;
let lastGoalHtml = '';
const solved = new Set<string>();
try { for (const n of JSON.parse(localStorage.getItem('solved') ?? '[]')) solved.add(n); } catch { /* storage unavailable */ }
let tool: Tool = 'water';
let brushIndex = 1; // 6px
let paused = false;
let view: View = 'normal';
let mouse: { x: number; y: number } | null = null;
let held: Tool | null = null;
/** The pointer (mouse button, finger or pen) currently drawing; other touches are ignored. */
let drawPointer: number | null = null;

installPixelUI();
document.querySelector('#app')!.innerHTML = `
  <header>
    <h1>BOILERPLATE</h1>
    <div class="group">
      <button id="pause"></button>
      <button id="step" title="Advance one frame (.)">Step</button>
      <button id="reset" title="Reload the level (R)">Reset</button>
    </div>
    <div class="group physics" role="group" aria-label="Physics engine">
      <span class="group-label">Physics:</span>
      <button data-physics="classic" title="The original engine: liquid particles plus air pockets with uniform pressure">Classic (legacy)</button>
      <button data-physics="unified" title="Air and steam simulated as a real gas, one pressure solve for everything">Unified</button>
    </div>
    <div id="stats"></div>
  </header>
  <main>
    <div class="stage">
      <canvas id="view" width="${W}" height="${H}"></canvas>
      <div id="banner"></div>
      <div id="chip"></div>
    </div>
    <nav id="dock" aria-label="Controls">
      <button data-act="menu" title="Menu: level, goal, views, puzzles">☰</button>
      <button data-act="pause"></button>
      <button data-act="reset" title="Reset the level">⟲</button>
      <button data-act="brush" title="Brush size"></button>
      ${TOOLS.map(t => `<button data-tool="${t.id}" title="${t.label}"></button>`).join('')}
    </nav>
    <button id="scrim" data-act="menu" aria-label="Close menu"></button>
    <aside>
      <section class="compact-only drawer-top">
        <button data-act="menu">✕ Close</button>
        <button data-act="step">Step</button>
        <button data-act="fullscreen" class="fs">⛶ Fullscreen</button>
        <span class="group physics">
          <button data-physics="classic">Classic</button>
          <button data-physics="unified">Unified</button>
        </span>
      </section>
      <section id="level-info">
        <h2 id="level-name"></h2>
        <p id="level-desc" class="muted"></p>
        <div id="goal"></div>
      </section>
      <section id="tools-panel">
        <h2>Tools</h2>

        <div class="tools">${TOOLS.map(t => `<button data-tool="${t.id}" title="${t.label}"></button>`).join('')}</div>
        <p id="tool-hint" class="muted"></p>
        <h2 class="brush-h">Brush size</h2>
        <div class="tools">${BRUSHES.map((b, i) => `<button data-brush="${i}" title="${b * 2}px brush"><img class="icon" src="${brushIcon(i)}" alt="${b * 2}px"><kbd>${i + 1}</kbd></button>`).join('')}</div>
      </section>
      <section>
        <h2>World</h2>
        <div class="tools">
          <button id="faucet" title="Toggle the level's faucets (F)"></button>
          <button id="pressure" title="Tint air by pressure: blue below atmosphere, orange above (P)">Pressure</button>
          <button id="temperature" title="Show temperature: blue cold, red hot, white very hot (T)">Temperature</button>
        </div>
      </section>
      <section>
        <h2>Puzzles</h2>
        <div class="tools mode" role="group" aria-label="Difficulty">
          <button data-mode="locked" title="Build while paused. Once you press Play, building is locked until Reset.">Locked</button>
          <button data-mode="live" title="Edit freely while the simulation runs.">Live</button>
        </div>
        <div class="levels">${PUZZLES.map((l, i) => `<button data-level="${i}">${l.name}</button>`).join('')}</div>
        <h2>Playground</h2>
        <div class="levels">${LEVELS.map((l, i) => `<button data-level="${PUZZLES.length + i}">${l.name}</button>`).join('')}</div>
      </section>
    </aside>
  </main>
  <div id="rotate"><img class="icon" src="${toolIcon('water')}" alt=""><div>Turn your phone sideways</div><div class="muted">Boilerplate plays in landscape.</div></div>`;

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const canvas = $<HTMLCanvasElement>('#view');
const renderer = new Renderer(canvas.getContext('2d')!);
const fx = renderer.fx;

// ---- Juice: banners and effects ----

const PUFF_COLOR: Record<number, [number, number, number]> = {
  [STONE]: [160, 164, 182], [MUD]: [128, 94, 60], [WOOD]: [176, 124, 70], [ICE]: [214, 242, 255], [WAX_SOLID]: [244, 224, 176],
};

function banner(html: string, cls: string, ms = 1600) {
  const el = $('#banner');
  el.className = '';
  void el.offsetWidth; // restart the animation
  el.innerHTML = html;
  el.className = cls;
  if (ms > 0) setTimeout(() => { if (el.className === cls) el.className = ''; }, ms);
}

function shake(el: HTMLElement) {
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
  el.addEventListener('animationend', () => el.classList.remove('shake'), { once: true });
}

// ---- Personal bests, kept in this browser per physics engine (each metric tracked separately) ----

interface Best { time: number; parts: number }
type BestStore = Record<string, Record<string, Best>>;

function loadBests(): BestStore {
  try { return JSON.parse(localStorage.getItem('bests') ?? '{}') as BestStore; } catch { return {}; }
}

function bestKey() { return `${world.physics}:${editMode}`; }

function bestFor(name: string): Best | undefined {
  return loadBests()[bestKey()]?.[name];
}

/** Materials placed this attempt (walls, wood…), the "parts" score. Fire isn't counted. */
function partsUsed() {
  return Object.entries(used).reduce((n, [k, v]) => (k === 'fire' || k === 'chill' ? n : n + v), 0);
}

/** Record a solve; returns which metrics are new personal bests. */
function recordBest(name: string, time: number, parts: number) {
  const store = loadBests();
  const mine = (store[bestKey()] ??= {});
  const old = mine[name];
  const newTime = !old || time < old.time, newParts = !old || parts < old.parts;
  mine[name] = { time: newTime ? time : old.time, parts: newParts ? parts : old.parts };
  try { localStorage.setItem('bests', JSON.stringify(store)); } catch { /* storage unavailable */ }
  return { newTime, newParts, first: !old };
}

function bestLabel(b: Best) {
  return `${b.time.toFixed(1)}s · ${b.parts} parts`;
}

function celebrate() {
  const z = ALL[levelIndex].puzzle!.goal.zone;
  const cx = ((z.i0 + z.i1 + 1) / 2) * 2, top = z.j0 * 2;
  fx.add(cx, top, 'drop', 40, 160, 1.4);
  fx.add(cx, top, 'spark', 25, 140, 1.6);
  fx.add(cx, top, 'steam', 10, 50, 1.2);
  const payloads = ['drop', 'spark', 'steam', 'drop', 'spark'] as const;
  payloads.forEach((p, n) => fx.rocket(cx + (n - 2) * 22, top, p, n * 0.18));
  const time = world.time, parts = partsUsed();
  const r = recordBest(ALL[levelIndex].name, time, parts);
  const tag = (isNew: boolean) => (isNew && !r.first ? ' <span class="new-best">NEW BEST</span>' : '');
  banner(`<div class="big">SOLVED!</div>
    <div class="small">${time.toFixed(1)}s${tag(r.newTime)} · ${parts} parts${tag(r.newParts)}</div>`, 'solved-banner', 3600);
}

function loadLevel(i: number) {
  levelIndex = i;
  const level = ALL[i];
  world.load(level);
  budget = level.puzzle ? { ...level.puzzle.tools } : null;
  used = {};
  solvedShown = false;
  hintShown = false;
  lockNoticeShown = false;
  if (budget) {
    paused = true; // puzzles start paused: build first, then press Play
    if (!(tool in budget)) tool = Object.keys(budget)[0] as Tool;
  }
  $('#level-name').textContent = level.name;
  $('#level-desc').textContent = level.desc;
  refreshButtons();
  renderGoal();
  fx.startWipe();
  banner(`<div class="big">${level.name}</div>`, 'title-banner', 1700);
}

/** Switch engines: a fresh World, then reload the current level (brush, view and tool stay as they are). */
function setPhysics(p: Physics) {
  try { localStorage.setItem('physics', p); } catch { /* storage unavailable */ }
  if (p === world.physics) return;
  world = new World(p);
  loadLevel(levelIndex);
  markSolved(); // bests are kept per engine
}

function allowed(t: Tool) {
  return !budget || t in budget || (t === 'erase' && Object.keys(budget).some(k => k in SOLID_TOOL));
}

let lastChipHtml = '';

function renderGoal() {
  const p = ALL[levelIndex].puzzle, el = $('#goal');
  if (!p) { el.innerHTML = ''; lastGoalHtml = ''; $('#chip').innerHTML = ''; lastChipHtml = ''; return; }
  const g = world.goal, goal = p.goal;
  const pct = Math.min(100, (g.amount / goal.amount) * 100);
  const checks: string[] = [];
  if (goal.minPurity !== undefined) checks.push(`Purity <b class="${g.purity >= goal.minPurity ? 'ok' : 'bad'}">${Math.round(g.purity * 100)}%</b> (need ${Math.round(goal.minPurity * 100)}%)`);
  if (goal.maxSilt !== undefined) checks.push(`Dirt <b class="${g.silt <= goal.maxSilt ? 'ok' : 'bad'}">${Math.round(g.silt * 100)}%</b> (max ${Math.round(goal.maxSilt * 100)}%)`);
  if (goal.minTemp !== undefined) checks.push(`Temperature <b class="${g.temp >= goal.minTemp ? 'ok' : 'bad'}">${Math.round(g.temp)}°</b> (need ${goal.minTemp}°)`);
  const next = levelIndex + 1 < PUZZLES.length ? `<button id="next">Next puzzle →</button>` : '';
  const html = `
    <div class="goal-label">Goal: ${goal.label}</div>
    ${(() => { const b = bestFor(ALL[levelIndex].name); return b ? `<div class="muted best">Your best: ${bestLabel(b)}</div>` : ''; })()}
    <div class="meter"><i style="width:${pct}%"></i></div>
    <div class="muted">${g.amount} / ${goal.amount}${checks.length ? ' · ' + checks.join(' · ') : ''}</div>
    ${g.solved ? `<div class="solved">Solved! ${next}</div>` : g.met ? `<div class="muted">Holding… ${g.held.toFixed(1)}s</div>` : ''}
    ${hintShown ? `<p class="muted hint">Hint: ${p.hint}</p>` : '<button id="hint">Show hint</button>'}
    ${paused && world.time === 0 ? `<p class="muted"><b>Build first, then press Play${matchMedia('(pointer: coarse)').matches ? '' : ' (Space)'}.</b></p>` : ''}`;
  // Only touch the DOM when something changed, so buttons in the panel don't get replaced mid-click.
  if (html !== lastGoalHtml) { el.innerHTML = html; lastGoalHtml = html; }
  // The compact goal chip shown over the game on phones.
  const bad = checks.filter(c => c.includes('class="bad"')).map(c => c.replace(/ \(.*\)$/, ''));
  const chip = g.solved
    ? `<b class="ok">✓ Solved</b>${next.replace('Next puzzle →', 'Next ▶')}`
    : `<span class="meter"><i style="width:${pct}%"></i></span><span>${g.amount}/${goal.amount}</span>${bad.map(b => `<span>${b}</span>`).join('')}${g.met ? `<span>Holding ${g.held.toFixed(1)}s</span>` : ''}`;
  if (chip !== lastChipHtml) { $('#chip').innerHTML = chip; lastChipHtml = chip; }
}

function refreshButtons() {
  $('#pause').textContent = paused ? '▶ Play' : '❚❚ Pause';
  for (const b of document.querySelectorAll<HTMLElement>('[data-act="pause"]')) b.textContent = paused ? '▶' : '❚❚';
  for (const b of document.querySelectorAll<HTMLElement>('[data-act="brush"]')) b.innerHTML = `<img class="icon" src="${brushIcon(brushIndex)}" alt="${BRUSHES[brushIndex] * 2}px">`;
  $('.fs').style.display = document.fullscreenEnabled ? '' : 'none';
  for (const b of document.querySelectorAll<HTMLElement>('[data-tool]')) {
    const t = b.dataset.tool as Tool;
    b.classList.toggle('active', t === tool);
    b.style.display = allowed(t) ? '' : 'none';
    const label = TOOLS.find(x => x.id === t)!.label;
    const timed = t === 'fire' || t === 'chill';
    const left = !budget || !(t in budget) ? ''
      : !isFinite(budget[t]) ? ` · ${used[t] ?? 0} used`
      : timed ? ` · ${budget[t].toFixed(1)}s` : ` · ${budget[t]}`;
    b.innerHTML = `<img class="icon" src="${toolIcon(t)}" alt=""><kbd>${TOOLS.find(x => x.id === t)!.key}</kbd><span class="lbl">${label}</span><span class="cnt">${left}</span>`;
  }
  for (const b of document.querySelectorAll<HTMLElement>('[data-brush]')) b.classList.toggle('active', Number(b.dataset.brush) === brushIndex);
  for (const b of document.querySelectorAll<HTMLElement>('[data-mode]')) b.classList.toggle('active', b.dataset.mode === editMode);
  for (const b of document.querySelectorAll<HTMLElement>('[data-level]')) b.classList.toggle('active', Number(b.dataset.level) === levelIndex);
  const faucetOn = world.emitters.some(e => e.on);
  const faucet = $('#faucet');
  faucet.textContent = world.emitters.length ? (faucetOn ? 'Faucet: on (G)' : 'Faucet: off (G)') : 'No faucet';
  faucet.toggleAttribute('disabled', !world.emitters.length || !!budget);
  $('#pressure').classList.toggle('active', view === 'pressure');
  $('#temperature').classList.toggle('active', view === 'temperature');
  for (const b of document.querySelectorAll<HTMLElement>('[data-physics]')) b.classList.toggle('active', b.dataset.physics === world.physics);
  $('#tool-hint').textContent = TOOLS.find(t => t.id === tool)!.hint;
}

function togglePause() {
  paused = !paused;
  // A little splash from each faucet when the water starts.
  if (!paused) for (const e of world.emitters) if (e.on) fx.add(e.x + e.w / 2, e.y, 'drop', 10, 70, 1.6, Math.PI / 2);
}

function toggleFaucet() {
  const on = !world.emitters.some(e => e.on);
  for (const e of world.emitters) e.on = on;
  refreshButtons();
}

/** Fullscreen hides the browser bars on phones; then try to hold landscape (Android allows it in fullscreen). */
function enterFullscreen() {
  document.documentElement.requestFullscreen?.()
    .then(() => (screen.orientation as ScreenOrientation & { lock?(o: string): Promise<void> }).lock?.('landscape'))
    .catch(() => { /* not supported (e.g. iPhone Safari) */ });
}

// #menu in the URL opens the drawer (phone layout).
if (location.hash === '#menu') document.body.classList.add('drawer-open');

document.addEventListener('click', ev => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('button');
  if (!el) return;
  const act = el.dataset.act ?? el.id;
  if (act === 'menu') document.body.classList.toggle('drawer-open');
  else if (act === 'brush') brushIndex = (brushIndex + 1) % BRUSHES.length;
  else if (act === 'fullscreen') enterFullscreen();
  else if (act === 'pause') togglePause();
  else if (act === 'step') { paused = true; world.step(1 / 60); }
  else if (act === 'reset') loadLevel(levelIndex);
  else if (act === 'faucet') toggleFaucet();
  else if (act === 'next') loadLevel(levelIndex + 1);
  else if (el.dataset.mode) {
    editMode = el.dataset.mode as EditMode;
    try { localStorage.setItem('editMode', editMode); } catch { /* storage unavailable */ }
    markSolved();
  }
  else if (act === 'hint') { hintShown = true; renderGoal(); }
  else if (act === 'pressure') view = view === 'pressure' ? 'normal' : 'pressure';
  else if (act === 'temperature') view = view === 'temperature' ? 'normal' : 'temperature';
  else if (el.dataset.tool && allowed(el.dataset.tool as Tool)) tool = el.dataset.tool as Tool;
  else if (el.dataset.brush) brushIndex = Number(el.dataset.brush);
  else if (el.dataset.level) { loadLevel(Number(el.dataset.level)); document.body.classList.remove('drawer-open'); }
  else if (el.dataset.physics) setPhysics(el.dataset.physics as Physics);
  refreshButtons();
});

window.addEventListener('keydown', ev => {
  const k = ev.key.toLowerCase();
  const t = TOOLS.find(t => t.key.toLowerCase() === k);
  if (t) { if (allowed(t.id)) tool = t.id; }
  else if (/^[1-4]$/.test(k)) brushIndex = Number(k) - 1;
  else if (ev.code === 'Space') { togglePause(); ev.preventDefault(); }
  else if (k === '.') { paused = true; world.step(1 / 60); }
  else if (k === 'r') loadLevel(levelIndex);
  else if (k === 'g') { if (!budget) toggleFaucet(); }
  else if (k === 'p') view = view === 'pressure' ? 'normal' : 'pressure';
  else if (k === 't') view = view === 'temperature' ? 'normal' : 'temperature';
  else return;
  refreshButtons();
});

/** Pointer position in world pixels, or null when it's off the canvas. */
function canvasPos(ev: PointerEvent) {
  const r = canvas.getBoundingClientRect();
  const x = ((ev.clientX - r.left) / r.width) * W, y = ((ev.clientY - r.top) / r.height) * H;
  return x < 0 || y < 0 || x >= W || y >= H ? null : { x, y };
}

// The game is sized to fit the viewport height as well as its column: CSS needs the height taken by everything else.
function fitStage() {
  const stage = $('.stage'), main = $('main');
  const above = stage.getBoundingClientRect().top + window.scrollY;
  const pad = stage.offsetHeight - canvas.offsetHeight + parseFloat(getComputedStyle(main).paddingBottom);
  document.documentElement.style.setProperty('--chrome-h', `${Math.ceil(above + pad)}px`);
}
new ResizeObserver(fitStage).observe($('header'));
window.addEventListener('resize', fitStage);
fitStage();

// Pointer events cover mouse, touch and pen. One pointer draws at a time; a second finger is ignored.
canvas.addEventListener('contextmenu', ev => ev.preventDefault());
canvas.addEventListener('pointerdown', ev => {
  if (drawPointer !== null) return;
  if (ev.pointerType === 'mouse' && ev.button !== 0 && ev.button !== 2) return;
  drawPointer = ev.pointerId;
  canvas.setPointerCapture(ev.pointerId);
  held = ev.button === 2 ? OPPOSITE[tool] : tool;
  if (!allowed(held)) held = budget && tool in SOLID_TOOL ? 'erase' : null;
  mouse = canvasPos(ev);
  ev.preventDefault();
});
canvas.addEventListener('pointermove', ev => {
  // A hovering mouse shows the brush; otherwise only the drawing pointer counts.
  if (drawPointer === null ? ev.pointerType === 'mouse' : ev.pointerId === drawPointer) mouse = canvasPos(ev);
});
const endDraw = (ev: PointerEvent) => {
  if (ev.pointerId !== drawPointer) return;
  drawPointer = null;
  held = null;
  if (ev.pointerType !== 'mouse') mouse = null; // no hover cursor left behind after a touch
};
canvas.addEventListener('pointerup', endDraw);
canvas.addEventListener('pointercancel', endDraw);
canvas.addEventListener('pointerleave', ev => { if (ev.pointerType === 'mouse' && drawPointer === null) mouse = null; });

function applyBrush() {
  if (!held || !mouse) return;
  if (budget && editMode === 'locked' && world.time > 0) {
    if (!lockNoticeShown) { lockNoticeShown = true; banner('<div class="small">Locked mode: press Reset (R) to edit again</div>', 'title-banner', 1700); }
    return;
  }
  const r = BRUSHES[brushIndex];
  const { x, y } = mouse;
  const mat = SOLID_TOOL[held];
  if (mat !== undefined) {
    // Materials: puzzles limit how many cells you can place; erasing your own refunds them.
    const res = world.paintSolid(x, y, r, mat, budget && held !== 'erase' ? budget[held] : Infinity);
    if (res.placed > 0) fx.add(x, y, 'dust', Math.min(5, res.placed), 45, Math.PI * 2, -Math.PI / 2, PUFF_COLOR[mat]);
    res.erased.forEach((n, m) => { if (n) fx.add(x, y, 'dust', Math.min(5, n), 30, 1.2, Math.PI / 2, PUFF_COLOR[m] ?? [150, 150, 160]); });
    if (budget && held !== 'erase' && res.placed === 0 && budget[held] <= 0) {
      const btn = document.querySelector<HTMLElement>(`[data-tool="${held}"]`);
      if (btn && !btn.classList.contains('shake')) shake(btn);
    }
    if (budget) {
      if (held !== 'erase') { budget[held] -= res.placed; used[held] = (used[held] ?? 0) + res.placed; }
      res.erased.forEach((n, m) => {
        const t = REFUND[m];
        if (n && t && t in budget!) { budget![t] += n; used[t] = Math.max(0, (used[t] ?? 0) - n); }
      });
      refreshButtons();
    }
    return;
  }
  if (held === 'fire' || held === 'chill') {
    if (budget) {
      if (budget[held] <= 0) {
        const btn = document.querySelector<HTMLElement>(`[data-tool="${held}"]`);
        if (btn && !btn.classList.contains('shake')) shake(btn);
        return;
      }
      budget[held] = Math.max(0, budget[held] - 1 / 60);
      used[held] = (used[held] ?? 0) + 1 / 60;
      refreshButtons();
    }
    if (held === 'fire') world.thermo.applyTemperature(x, y, r, 800);
    else world.thermo.applyTemperature(x, y, r, -40, 1 / 60, 1500);
    return;
  }
  if (held === 'water') world.pour(x, y, r, WATER);
  else if (held === 'muddy') world.pour(x, y, r, WATER, 1);
  else if (held === 'oil') world.pour(x, y, r, OIL);
  else if (held === 'steam') world.steam(x, y, r);
  else world.sponge(x, y, r);
}

// ---- Loop ----

let simMs = 0;
let fps = 60;
let last = performance.now();
let statTimer = 0;

function frame(now: number) {
  const dt = (now - last) / 1000;
  last = now;
  fps = fps * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05;

  applyBrush();
  if (!paused) {
    const t0 = performance.now();
    world.step(1 / 60);
    simMs = simMs * 0.9 + (performance.now() - t0) * 0.1;
  }
  renderer.draw(world, { view, brush: mouse ? { ...mouse, r: BRUSHES[brushIndex], color: BRUSH_COLOR[held ?? tool] } : null, dt: Math.min(dt, 0.05) });

  statTimer -= dt;
  if (statTimer <= 0) {
    statTimer = 0.25;
    renderGoal();
    if (world.goal.solved && !solvedShown) {
      solvedShown = true;
      solved.add(ALL[levelIndex].name);
      try { localStorage.setItem('solved', JSON.stringify([...solved])); } catch { /* storage unavailable */ }
      celebrate();
      markSolved();
    }
    $('#stats').innerHTML = `<span>Water particles <b>${world.fluid.count}</b></span><span>Simulation <b>${simMs.toFixed(1)} ms</b></span><span>Frame rate <b>${Math.round(fps)}</b></span><span>Engine <b>${world.physics === 'unified' ? 'Unified' : 'Classic'}</b></span>`;
  }
  requestAnimationFrame(frame);
}

function markSolved() {
  for (const b of document.querySelectorAll<HTMLElement>('[data-level]')) {
    const level = ALL[Number(b.dataset.level)];
    b.classList.toggle('done', solved.has(level.name));
    const best = level.puzzle ? bestFor(level.name) : undefined;
    b.innerHTML = `${level.name}${best ? `<small>${bestLabel(best)}</small>` : ''}`;
  }
}

// URL options for testing: ?level=N picks a level, ?warm=N simulates N frames before the first draw.
const params = new URLSearchParams(location.search);
loadLevel(Math.min(ALL.length - 1, Number(params.get('level') ?? 0)));
markSolved();
for (let k = Number(params.get('warm') ?? 0); k > 0; k--) world.step(1 / 60);
if (params.has('pressure')) view = 'pressure';
if (params.has('temperature')) view = 'temperature';
requestAnimationFrame(frame);
