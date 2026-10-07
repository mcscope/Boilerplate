import './style.css';
import { GENES, GENE_INFO, Gene } from './genes';
import { Creature, GW, Lab, PEN_H, PEN_NAMES, PEN_W, TILE, TILE_INFO, TileKind, rectCells } from './lab';
import { Ghost, VIEW_H, VIEW_W, drawPen, drawSwatch } from './render';

const STEP = 1 / 60;

type SortKey = 'name' | 'pen' | 'gen' | 'age' | 'energy' | 'children' | Gene;
type Filter = 'all' | 'selected' | number;
type Tool = 'select' | TileKind;

const TOOLS: Tool[] = ['select', 'wall', 'food', 'spikes', 'lure', 'door', 'floor'];

const lab = new Lab();
const selected = new Set<number>();
let paused = false;
let speed = 1;
let sortKey: SortKey = 'gen';
let sortDesc = true;
let filter: Filter = 'all';
let lastRowId: number | null = null;
let hovered: Creature | null = null;
let box: { pen: number; x0: number; y0: number; x1: number; y1: number } | null = null;
let press: { pen: number; x: number; y: number; creature: Creature | null; wasSelected: boolean } | null = null;
// Creatures being dragged: each keeps its offset from the cursor so groups keep their formation.
let carrying: { offsets: Map<number, { dx: number; dy: number }>; target: { pen: number; x: number; y: number } | null } | null = null;
let tool: Tool = 'select';
let pendingDoor: { pen: number; tile: number } | null = null; // door placed, waiting for its exit click
let exitHover: { pen: number; x: number; y: number } | null = null;
// A tile rectangle being dragged out; applied on mouseup.
let painting: { pen: number; kind: TileKind; c0: number; r0: number; c1: number; r1: number; hollow: boolean } | null = null;
let hoverTile: { pen: number; tile: number } | null = null;
let rosterPressed = false; // don't rebuild rows mid-click, or the click gets lost
let rowDrag: { anchor: number; add: boolean; base: Set<number> } | null = null;

// ---- Layout ----

document.querySelector('#hud')!.innerHTML = `
  <h1>BROOD LAB</h1>
  <div class="controls">
    <button id="pause"></button>
    ${[1, 2, 4, 8].map(s => `<button data-speed="${s}">${s}×</button>`).join('')}
  </div>
  <div id="stats"></div>`;

document.querySelector('#screen')!.innerHTML = `
  <div class="left">
  <div class="toolbar">
    ${TOOLS.map(t => `<button class="tool" data-tool="${t}">${t === 'select' ? '<span class="swatch hand">✋</span>' : `<canvas class="swatch" width="16" height="16" data-swatch="${t}"></canvas>`}${t === 'select' ? 'Select' : TILE_INFO[t].label}</button>`).join('')}
  </div>
  <p id="tool-desc" class="muted"></p>
  <div class="pens">
    ${PEN_NAMES.map((n, i) => `
      <section class="pen" data-pen="${i}">
        <header>
          <b>Pen ${n}</b>
          <span class="pen-count" data-count="${i}"></span>
          <button data-select-pen="${i}">Select all</button>
        </header>
        <canvas width="${VIEW_W}" height="${VIEW_H}" data-canvas="${i}"></canvas>
        <div class="pen-controls">
          <label title="How fast eaten food patches grow back">Regrow <input type="range" min="0.25" max="3" step="0.25" value="${lab.pens[i].regrow}" data-regrow="${i}"><output data-regrow-out="${i}"></output></label>
          <label>Radiation <input type="range" min="0" max="1" step="0.05" value="${lab.pens[i].radiation}" data-rad="${i}"><output data-rad-out="${i}"></output></label>
        </div>
        <div class="pen-avgs" data-avgs="${i}"></div>
      </section>`).join('')}
  </div>
  </div>
  <section class="roster">
    <div class="filters">
      ${(['all', 0, 1, 2, 3, 'selected'] as Filter[]).map(f => `<button data-filter="${f}">${f === 'all' ? 'All' : f === 'selected' ? 'Selected' : `Pen ${PEN_NAMES[f as number]}`}</button>`).join('')}
    </div>
    <div class="select-row">
      <button data-sel="all">Select shown</button>
      <button data-sel="top">Top 10</button>
      <button data-sel="bottom">Bottom 10</button>
      <button data-sel="none">Clear</button>
    </div>
    <div class="bulk">
      <span id="sel-count" title="Drag onto a pen to place the selection there"></span>
      <span class="bulk-actions">Move to ${PEN_NAMES.map((n, i) => `<button data-move="${i}">${n}</button>`).join('')}
      <button data-cull class="danger">Kill</button></span>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          ${([['name', 'Name'], ['pen', 'Pen'], ['gen', 'Generation'], ['age', 'Age'], ['energy', 'Energy'], ...GENES.map(g => [g, GENE_INFO[g].label]), ['children', 'Children']] as [SortKey, string][])
            .map(([k, label]) => `<th data-sort="${k}" title="${k in GENE_INFO ? GENE_INFO[k as Gene].label + ': ' + GENE_INFO[k as Gene].hint : ''}">${label}</th>`).join('')}
        </tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <p class="muted">Click or drag down rows to select, shift-click for a range. In a pen, drag a creature to carry it, or drag empty ground to box-select.
    Drag a selected creature (or the yellow count above) to place the whole group anywhere, in any pen.
    Keys: 1–4 move · X kill · Esc clear · Space pause</p>
  </section>
  <div id="tooltip"></div>
  <div id="carry"></div>`;

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const canvases = PEN_NAMES.map((_, i) => $<HTMLCanvasElement>(`[data-canvas="${i}"]`));
const contexts = canvases.map(c => c.getContext('2d')!);
const tooltip = $('#tooltip');
for (const c of document.querySelectorAll<HTMLCanvasElement>('[data-swatch]')) drawSwatch(c, c.dataset.swatch as TileKind);

function setTool(t: Tool) {
  tool = t;
  for (const b of document.querySelectorAll<HTMLElement>('[data-tool]')) b.classList.toggle('active', b.dataset.tool === t);
  pendingDoor = null;
  updateToolDesc();
  for (const c of canvases) c.style.cursor = t === 'select' ? 'default' : 'cell';
}

function updateToolDesc() {
  const t = tool;
  $('#tool-desc').textContent = pendingDoor
    ? 'Now click where this door should lead (any pen). Esc cancels.'
    : t === 'door'
    ? `${TILE_INFO.door.desc} Right-drag to erase.`
    : t === 'select'
    ? 'Drag a creature to carry it and drop it anywhere. Drag empty ground to box-select; drag any selected creature to carry the whole group.'
    : `${TILE_INFO[t].desc} Drag to lay a rectangle · Shift-drag for a hollow outline · right-drag to erase.`;
}
const carry = $('#carry');

// ---- Roster ----

function sortValue(c: Creature, k: SortKey): number | string {
  if (k === 'name') return c.name;
  if (k === 'energy') return c.energy / c.stats.maxEnergy;
  if (k in GENE_INFO) return c.genome[k as Gene];
  return c[k as 'pen' | 'gen' | 'age' | 'children'];
}

function shownCreatures(): Creature[] {
  const list = lab.creatures.filter(c => filter === 'all' || (filter === 'selected' ? selected.has(c.id) : c.pen === filter));
  list.sort((a, b) => {
    const va = sortValue(a, sortKey), vb = sortValue(b, sortKey);
    const cmp = typeof va === 'string' ? va.localeCompare(vb as string) : va - (vb as number);
    return sortDesc ? -cmp : cmp;
  });
  return list;
}

function geneCell(v: number) {
  const pct = Math.round(v * 100);
  return `<td class="gene" style="--v:${pct}%">${pct}</td>`;
}

function renderRoster() {
  for (const id of selected) if (!lab.creatures.some(c => c.id === id)) selected.delete(id);
  const rows = shownCreatures().map(c => `
    <tr data-id="${c.id}" class="${selected.has(c.id) ? 'sel' : ''}">
      <td>${c.name}</td><td>${PEN_NAMES[c.pen]}</td><td>${c.gen}</td><td>${Math.floor(c.age)}</td>
      <td class="gene energy" style="--v:${Math.round((c.energy / c.stats.maxEnergy) * 100)}%">${Math.round((c.energy / c.stats.maxEnergy) * 100)}</td>
      ${GENES.map(g => geneCell(c.genome[g])).join('')}
      <td>${c.children}</td>
    </tr>`);
  $('tbody').innerHTML = rows.join('');
  for (const th of document.querySelectorAll<HTMLElement>('th')) {
    th.classList.toggle('sorted', th.dataset.sort === sortKey);
    th.dataset.dir = sortDesc ? '▼' : '▲';
  }
  for (const b of document.querySelectorAll<HTMLElement>('[data-filter]')) b.classList.toggle('active', b.dataset.filter === String(filter));
  $('#sel-count').textContent = selected.size ? `✋ ${selected.size} selected` : '0 selected';
}

function renderPenInfo() {
  lab.pens.forEach((pen, i) => {
    const members = lab.inPen(i);
    const ready = pen.foods.filter(f => pen.growth[f] <= 0).length;
    $(`[data-count="${i}"]`).textContent = `${members.length} creatures · ${ready}/${pen.foods.length} food`;
    $(`[data-regrow-out="${i}"]`).textContent = `${pen.regrow}×`;
    $(`[data-rad-out="${i}"]`).textContent = `${Math.round(pen.radiation * 100)}%`;
    $(`[data-avgs="${i}"]`).innerHTML = GENES.map(g => {
      const avg = members.length ? members.reduce((s, c) => s + c.genome[g], 0) / members.length : 0;
      return `<span title="Average ${GENE_INFO[g].label}">${GENE_INFO[g].label}<i style="--v:${avg * 100}%"></i></span>`;
    }).join('');
  });
}

function renderHud() {
  $('#pause').textContent = paused ? '▶ Play' : '❚❚ Pause';
  for (const b of document.querySelectorAll<HTMLElement>('[data-speed]')) b.classList.toggle('active', Number(b.dataset.speed) === speed);
  const t = Math.floor(lab.time);
  const topGen = lab.creatures.reduce((m, c) => Math.max(m, c.gen), 0);
  $('#stats').innerHTML = `
    <span>Population <b>${lab.creatures.length}</b></span>
    <span>Highest generation <b>${topGen}</b></span>
    <span>Born <b>${lab.births}</b></span>
    <span>Starved <b>${lab.deaths.starved}</b></span>
    <span>Old age <b>${lab.deaths['old age']}</b></span>
    <span>Killed <b>${lab.deaths.culled}</b></span>
    <span>${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}</span>`;
}

// ---- Actions ----

function moveSelected(pen: number) {
  lab.moveTo(selected, pen);
  renderRoster();
}

function cullSelected() {
  lab.cull(selected);
  selected.clear();
  renderRoster();
}

function selectRange(list: Creature[]) {
  for (const c of list) selected.add(c.id);
  renderRoster();
}

document.addEventListener('click', ev => {
  const el = ev.target as HTMLElement;
  const d = (sel: string) => el.closest<HTMLElement>(sel);
  let b: HTMLElement | null;
  if ((b = d('[data-speed]'))) speed = Number(b.dataset.speed);
  else if ((b = d('[data-tool]'))) setTool(b.dataset.tool as Tool);
  else if (d('#pause')) paused = !paused;
  else if ((b = d('[data-move]'))) moveSelected(Number(b.dataset.move));
  else if (d('[data-cull]')) cullSelected();
  else if ((b = d('[data-select-pen]'))) selectRange(lab.inPen(Number(b.dataset.selectPen)));
  else if ((b = d('[data-filter]'))) {
    const f = b.dataset.filter!;
    filter = f === 'all' || f === 'selected' ? f : Number(f);
    renderRoster();
  } else if ((b = d('[data-sel]'))) {
    const shown = shownCreatures();
    const which = b.dataset.sel;
    if (which === 'none') selected.clear();
    else selectRange(which === 'all' ? shown : which === 'top' ? shown.slice(0, 10) : shown.slice(-10));
    renderRoster();
  } else if ((b = d('th[data-sort]'))) {
    const k = b.dataset.sort as SortKey;
    sortDesc = k === sortKey ? !sortDesc : true;
    sortKey = k;
    renderRoster();
  }
});

// Roster rows: click toggles, drag paints a range (adding or removing, by what the first row was), shift-click extends.
function applyRowDrag(toId: number) {
  if (!rowDrag) return;
  const ids = shownCreatures().map(c => c.id);
  const [i, j] = [ids.indexOf(rowDrag.anchor), ids.indexOf(toId)].sort((x, y) => x - y);
  selected.clear();
  rowDrag.base.forEach(id => selected.add(id));
  if (i >= 0) for (const id of ids.slice(i, j + 1)) rowDrag.add ? selected.add(id) : selected.delete(id);
  for (const tr of document.querySelectorAll<HTMLElement>('tr[data-id]')) tr.classList.toggle('sel', selected.has(Number(tr.dataset.id)));
  $('#sel-count').textContent = `${selected.size} selected`;
}

$('tbody').addEventListener('mousedown', ev => {
  const tr = (ev.target as HTMLElement).closest<HTMLElement>('tr[data-id]');
  if (!tr || ev.button !== 0) return;
  ev.preventDefault();
  const id = Number(tr.dataset.id);
  if (ev.shiftKey && lastRowId !== null) {
    rowDrag = { anchor: lastRowId, add: true, base: new Set(selected) };
  } else {
    rowDrag = { anchor: id, add: !selected.has(id), base: new Set(selected) };
    lastRowId = id;
  }
  applyRowDrag(id);
});
$('tbody').addEventListener('mouseover', ev => {
  const tr = (ev.target as HTMLElement).closest<HTMLElement>('tr[data-id]');
  if (tr && rowDrag) applyRowDrag(Number(tr.dataset.id));
});
window.addEventListener('mouseup', () => {
  if (rowDrag) { rowDrag = null; renderRoster(); }
});

document.addEventListener('input', ev => {
  const el = ev.target as HTMLInputElement;
  if (el.dataset.regrow) lab.pens[Number(el.dataset.regrow)].regrow = Number(el.value);
  if (el.dataset.rad) lab.pens[Number(el.dataset.rad)].radiation = Number(el.value);
  renderPenInfo();
});

window.addEventListener('keydown', ev => {
  if ((ev.target as HTMLElement).tagName === 'INPUT') return;
  if (ev.code === 'Space') { paused = !paused; ev.preventDefault(); }
  else if (ev.key === 'Escape') {
    if (pendingDoor) { pendingDoor = null; updateToolDesc(); }
    else { selected.clear(); renderRoster(); }
  }
  else if (ev.key === 'x' || ev.key === 'Delete' || ev.key === 'Backspace') cullSelected();
  else if (/^[1-4]$/.test(ev.key)) moveSelected(Number(ev.key) - 1);
});

$('.table-wrap').addEventListener('mousedown', () => (rosterPressed = true));
window.addEventListener('mouseup', () => (rosterPressed = false));

// ---- Pen mouse: click select, box select, drag selection to another pen ----

function penPos(i: number, ev: MouseEvent) {
  const r = canvases[i].getBoundingClientRect();
  return { x: ((ev.clientX - r.left) * PEN_W) / r.width, y: ((ev.clientY - r.top) * PEN_H) / r.height };
}

function creatureAt(pen: number, p: { x: number; y: number }) {
  let best: Creature | null = null, bd = Infinity;
  for (const c of lab.creatures) {
    if (c.pen !== pen) continue;
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (d < c.stats.radius + 7 && d < bd) { best = c; bd = d; }
  }
  return best;
}

function penUnder(ev: MouseEvent): number | null {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-canvas]');
  return el ? Number(el.dataset.canvas) : null;
}

const clampCell = (p: { x: number; y: number }) => ({
  c: Math.max(0, Math.min(GW - 1, Math.floor(p.x / TILE))),
  r: Math.max(0, Math.min(PEN_H / TILE - 1, Math.floor(p.y / TILE))),
});

canvases.forEach((cv, i) => {
  cv.addEventListener('contextmenu', ev => ev.preventDefault());
  cv.addEventListener('mousedown', ev => {
    const p = penPos(i, ev);
    if (tool === 'door' && ev.button === 0) {
      const t = lab.tileIndex(p.x, p.y);
      if (t === null) return;
      if (!pendingDoor) {
        if (lab.pens[i].tiles[t] !== 'wall') pendingDoor = { pen: i, tile: t };
      } else {
        lab.setTile(pendingDoor.pen, pendingDoor.tile, 'door', { pen: i, x: p.x, y: p.y });
        pendingDoor = null;
      }
      updateToolDesc();
      ev.preventDefault();
      return;
    }
    if (tool !== 'select') {
      const { c, r } = clampCell(p);
      painting = { pen: i, kind: ev.button === 2 ? 'floor' : tool, c0: c, r0: r, c1: c, r1: r, hollow: ev.shiftKey };
      ev.preventDefault();
      return;
    }
    if (ev.button !== 0) return;
    const c = creatureAt(i, p);
    const wasSelected = !!c && selected.has(c.id);
    if (c && !wasSelected) {
      if (!ev.shiftKey) selected.clear();
      selected.add(c.id);
    }
    press = { pen: i, ...p, creature: c, wasSelected };
    ev.preventDefault();
  });
  cv.addEventListener('mousemove', ev => {
    const p = penPos(i, ev);
    const t = lab.tileIndex(p.x, p.y);
    hoverTile = tool !== 'select' && t !== null && !pendingDoor ? { pen: i, tile: t } : null;
    exitHover = pendingDoor ? { pen: i, ...p } : null;
    hovered = creatureAt(i, p);
    if (hovered && !carrying && tool === 'select') {
      const c = hovered;
      tooltip.innerHTML = `<b>${c.name}</b> · Generation ${c.gen} · ${c.children} children<br>${GENES.map(g => `${GENE_INFO[g].label} ${Math.round(c.genome[g] * 100)}`).join(' · ')}`;
      tooltip.style.display = 'block';
    } else tooltip.style.display = 'none';
  });
  cv.addEventListener('mouseleave', () => { hovered = null; hoverTile = null; exitHover = null; tooltip.style.display = 'none'; });
});

window.addEventListener('mousemove', ev => {
  tooltip.style.left = `${ev.clientX + 14}px`;
  tooltip.style.top = `${ev.clientY + 14}px`;
  carry.style.left = `${ev.clientX + 10}px`;
  carry.style.top = `${ev.clientY - 10}px`;
  if (painting) {
    const { c, r } = clampCell(penPos(painting.pen, ev));
    Object.assign(painting, { c1: c, r1: r, hollow: ev.shiftKey });
  }
  if (carrying) {
    const pen = penUnder(ev);
    carrying.target = pen === null ? null : { pen, ...penPos(pen, ev) };
    return;
  }
  if (!press) return;
  const p = penPos(press.pen, ev);
  if (Math.hypot(p.x - press.x, p.y - press.y) <= 5) return;
  if (press.creature) {
    startCarry(press);
    carrying!.target = { pen: press.pen, ...p };
    press = null;
  } else box = { pen: press.pen, x0: press.x, y0: press.y, x1: p.x, y1: p.y };
});

function startCarry(anchor: { pen: number; x: number; y: number } | null) {
  const offsets = new Map<number, { dx: number; dy: number }>();
  let k = anchor ? 1 : 0;
  for (const c of lab.creatures) {
    if (!selected.has(c.id)) continue;
    if (anchor && c.pen === anchor.pen) offsets.set(c.id, { dx: c.x - anchor.x, dy: c.y - anchor.y });
    else {
      // Creatures from elsewhere gather in a sunflower spiral around the cursor.
      const a = k * 2.4, d = 9 * Math.sqrt(k++);
      offsets.set(c.id, { dx: Math.cos(a) * d, dy: Math.sin(a) * d });
    }
  }
  if (!offsets.size) return;
  carrying = { offsets, target: null };
  carry.textContent = `Carrying ${offsets.size}`;
  carry.style.display = 'block';
  tooltip.style.display = 'none';
}

function ghostsFor(pen: number): Ghost[] {
  if (!carrying?.target || carrying.target.pen !== pen) return [];
  const t = carrying.target;
  const ghosts: Ghost[] = [];
  for (const c of lab.creatures) {
    const o = carrying.offsets.get(c.id);
    if (!o) continue;
    const r = c.stats.radius;
    ghosts.push({ creature: c, x: Math.max(r, Math.min(PEN_W - r, t.x + o.dx)), y: Math.max(r, Math.min(PEN_H - r, t.y + o.dy)) });
  }
  return ghosts;
}

$('#sel-count').addEventListener('mousedown', ev => {
  if (!selected.size) return;
  ev.preventDefault();
  ev.stopPropagation();
  startCarry(null);
});

window.addEventListener('mouseup', ev => {
  if (painting) {
    const p = painting;
    lab.fillRect(p.pen, p.c0, p.r0, p.c1, p.r1, p.kind, p.hollow);
    painting = null;
  }
  if (carrying) {
    if (carrying.target) for (const g of ghostsFor(carrying.target.pen)) lab.place(g.creature, carrying.target.pen, g.x, g.y);
    carrying = null;
    carry.style.display = 'none';
    renderRoster();
    return;
  }
  if (!press) return;
  if (box) {
    if (!ev.shiftKey) selected.clear();
    const [x0, x1] = [Math.min(box.x0, box.x1), Math.max(box.x0, box.x1)];
    const [y0, y1] = [Math.min(box.y0, box.y1), Math.max(box.y0, box.y1)];
    for (const c of lab.inPen(box.pen)) if (c.x >= x0 && c.x <= x1 && c.y >= y0 && c.y <= y1) selected.add(c.id);
  } else {
    const c = press.creature;
    if (c && ev.shiftKey && press.wasSelected) selected.delete(c.id);
    else if (!ev.shiftKey) {
      selected.clear();
      if (c) selected.add(c.id);
    }
  }
  press = null;
  box = null;
  renderRoster();
});

// ---- Loop ----

let last = performance.now();
let acc = 0;
let panelTimer = 0;

function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!paused) {
    acc += dt * speed;
    while (acc >= STEP) {
      lab.step(STEP);
      acc -= STEP;
    }
  }
  contexts.forEach((ctx, i) => {
    let brush: { cells: number[]; erase: boolean } | null = null;
    if (painting?.pen === i) {
      const p = painting;
      brush = { cells: rectCells(p.c0, p.r0, p.c1, p.r1, p.hollow), erase: p.kind === 'floor' };
    } else if (!painting && hoverTile?.pen === i) brush = { cells: [hoverTile.tile], erase: tool === 'floor' };
    drawPen(ctx, lab, i, selected, hovered, box && box.pen === i ? box : null, brush, ghostsFor(i), { pending: pendingDoor, preview: pendingDoor ? exitHover : null });
  });

  panelTimer -= dt;
  if (panelTimer <= 0) {
    panelTimer = 0.3;
    if (!rosterPressed && !rowDrag) renderRoster();
    renderPenInfo();
    renderHud();
  }
  requestAnimationFrame(frame);
}

renderPenInfo();
setTool('select');
requestAnimationFrame(frame);
