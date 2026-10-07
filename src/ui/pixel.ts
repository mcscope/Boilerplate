/**
 * Pixel-art UI chrome, generated at startup: 9-slice frames for panels and buttons, dithered backgrounds, and tool
 * icons, all as tiny images that CSS scales up with no smoothing. One UI pixel = UI_PX screen pixels, so every
 * border and bevel lands on the same chunky grid.
 */

type RGB = [number, number, number];

const UI_PX = 2;

const hex = (c: RGB) => `rgb(${c[0]},${c[1]},${c[2]})`;

function makeCanvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, g: c.getContext('2d')! };
}

function px(g: CanvasRenderingContext2D, x: number, y: number, col: RGB, w = 1, h = 1) {
  g.fillStyle = hex(col);
  g.fillRect(x, y, w, h);
}

interface FrameSpec {
  outline: RGB;
  light: RGB; // top/left bevel
  dark: RGB; // bottom/right bevel
  fill: RGB;
  notched?: boolean; // knock out the outline's corner pixels (pixel-rounded corners)
  rivets?: RGB; // little studs in the corners
}

/**
 * A 9x9 frame: 1px outline, 1px bevel, then fill. Sliced at 3px, so the border is 3 UI pixels wide.
 */
function frame(spec: FrameSpec): string {
  const N = 9;
  const { c, g } = makeCanvas(N, N);
  px(g, 0, 0, spec.outline, N, N);
  px(g, 1, 1, spec.light, N - 2, N - 2);
  px(g, 2, 2, spec.dark, N - 3, N - 3);
  px(g, 2, 2, spec.fill, N - 4, N - 4);
  // Bevel corners: the light and dark edges meet diagonally.
  px(g, 1, N - 2, spec.dark);
  px(g, N - 2, 1, spec.dark);
  if (spec.notched) for (const [x, y] of [[0, 0], [N - 1, 0], [0, N - 1], [N - 1, N - 1]]) g.clearRect(x, y, 1, 1);
  if (spec.rivets) for (const [x, y] of [[2, 2], [N - 3, 2], [2, N - 3], [N - 3, N - 3]]) px(g, x, y, spec.rivets);
  return c.toDataURL();
}

/** A 4x4 ordered-dither tile of two colors. */
function dither(a: RGB, b: RGB, density = 0.25): string {
  const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const { c, g } = makeCanvas(4, 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) px(g, x, y, (bayer[y * 4 + x] + 0.5) / 16 < density ? b : a);
  return c.toDataURL();
}

// ---- Tool icons: 12x12 pixel art, one string per row, characters map to the palette. ----

const ICON_PALETTE: Record<string, RGB> = {
  k: [5, 6, 10], // outline
  w: [236, 240, 248], W: [180, 190, 210], // white / light gray
  g: [96, 100, 118], G: [150, 156, 176], d: [62, 64, 80], // stone grays
  b: [52, 120, 204], B: [168, 222, 255], n: [34, 82, 164], // water blues
  o: [182, 126, 36], O: [252, 216, 112], // oil amber
  m: [112, 84, 56], M: [150, 120, 86], u: [74, 54, 36], // mud browns
  t: [150, 100, 56], T: [190, 140, 80], r: [100, 64, 34], // wood
  i: [166, 214, 238], I: [236, 250, 255], j: [104, 160, 200], // ice
  x: [234, 206, 152], X: [255, 246, 220], // wax
  f: [255, 168, 46], F: [255, 244, 170], e: [226, 64, 26], // fire
  y: [236, 214, 90], Y: [255, 240, 150], h: [170, 140, 40], // sponge
  p: [230, 120, 150], P: [250, 190, 205], // eraser pink
};

const ICONS: Record<string, string[]> = {
  wall: [
    '............',
    '.kkkkkkkkkk.',
    '.kGGGGkGGGk.',
    '.kggggkgggk.',
    '.kkkkkkkkkk.',
    '.kGGkGGGGGk.',
    '.kggkgggggk.',
    '.kkkkkkkkkk.',
    '.kGGGGkGGGk.',
    '.kddddkdddk.',
    '.kkkkkkkkkk.',
    '............',
  ],
  erase: [
    '............',
    '......kkkk..',
    '.....kPPPPk.',
    '....kPPPPpk.',
    '...kPPPPppk.',
    '..kwkPPpppk.',
    '.kwwwkppppk.',
    '.kwwWWkppk..',
    '.kwWWWWkk...',
    '..kkWWWk....',
    '....kkk.....',
    '............',
  ],
  water: [
    '.....kk.....',
    '.....kBk....',
    '....kBbk....',
    '....kBbbk...',
    '...kBbbbbk..',
    '...kBbbbbk..',
    '..kBbbbbbnk.',
    '..kBwbbbbnk.',
    '..kbwbbbnnk.',
    '...kbbbnnk..',
    '....kkkkk...',
    '............',
  ],
  muddy: [
    '.....kk.....',
    '.....kMk....',
    '....kMmk....',
    '....kMmmk...',
    '...kMmmmmk..',
    '...kMmmmmk..',
    '..kMmmmmmuk.',
    '..kMwmmmmuk.',
    '..kmwmmmuuk.',
    '...kmmmuuk..',
    '....kkkkk...',
    '............',
  ],
  oil: [
    '.....kk.....',
    '.....kOk....',
    '....kOok....',
    '....kOook...',
    '...kOooook..',
    '...kOooook..',
    '..kOoooooak.',
    '..kOwoooork.',
    '..kowooorrk.',
    '...kooorrk..',
    '....kkkkk...',
    '............',
  ],
  mud: [
    '............',
    '............',
    '............',
    '....kkkk....',
    '..kkMMMMkk..',
    '.kMMMmmmMMk.',
    '.kMmGmmmmmk.',
    'kmmmmmmGmmuk',
    'kmmmmmmmmuuk',
    'kuuummuuuuuk',
    'kkkkkkkkkkkk',
    '............',
  ],
  wood: [
    '............',
    '..kkkkkkkk..',
    '.kTTTTTTTTk.',
    'kTttttttttrk',
    'kTtrrrrrttrk',
    'kTtrTTTrttrk',
    'kTtrTrTrttrk',
    'kTtrTTTrttrk',
    'kTtrrrrrttrk',
    'kTttttttttrk',
    '.krrrrrrrrk.',
    '..kkkkkkkk..',
  ],
  ice: [
    '............',
    '...kkkkkkk..',
    '..kIIIIIIjk.',
    '.kIIIIIIjjk.',
    '.kkkkkkkjjk.',
    '.kIiiiiikjk.',
    '.kIiIiiikjk.',
    '.kIiiIiikjk.',
    '.kIiiiiikk..',
    '.kjjjjjjk...',
    '.kkkkkkkk...',
    '............',
  ],
  wax: [
    '.....kk.....',
    '.....kFk....',
    '....kFfk....',
    '.....kk.....',
    '....kWWk....',
    '...kXXXXk...',
    '...kXxxxk...',
    '...kXxxxk...',
    '...kXxxxk...',
    '...kXxxxk...',
    '..kkkkkkkk..',
    '............',
  ],
  heater: [
    '............',
    '.kkkkkkkkkk.',
    '.kddddddddk.',
    '.kdeeeeeedk.',
    '.kdfddddddk.',
    '.kdeeeeeedk.',
    '.kddddddfdk.',
    '.kdeeeeeedk.',
    '.kdfddddddk.',
    '.kdeeeeeedk.',
    '.kkkkkkkkkk.',
    '............',
  ],
  steam: [
    '............',
    '.....kkk....',
    '....kwwwk...',
    '..kkwwwwwk..',
    '.kwwWwwwwwk.',
    '.kwwwwwWwwk.',
    'kwwwwwwwwwwk',
    'kWwwwwwwwWWk',
    '.kWWWWWWWWk.',
    '..kkkkkkkk..',
    '...k..k..k..',
    '..k..k..k...',
  ],
  fire: [
    '.....k......',
    '....kfk.....',
    '....kfk..k..',
    '...kfefk.kk.',
    '..kfeeefkfk.',
    '..kfeFeefek.',
    '.kfeFFFeeefk',
    '.kfeFYFFeefk',
    '.kfeFYYFeefk',
    '..kfeFFFefk.',
    '...kkkkkkk..',
    '............',
  ],
  chill: [
    '.....kk.....',
    '..k..ik..k..',
    '..kk.ik.kk..',
    '...kkIIkk...',
    '.....II.....',
    'kiiIIIIIIiik',
    'kiiIIIIIIiik',
    '.....II.....',
    '...kkIIkk...',
    '..kk.ik.kk..',
    '..k..ik..k..',
    '.....kk.....',
  ],
  sponge: [
    '............',
    '............',
    '.kkkkkkkkkk.',
    'kYYYYYYYYYYk',
    'kYyykyyyyyhk',
    'kyyyyyykyyhk',
    'kykyyyyyyyhk',
    'kyyyyykyyyhk',
    'kyyyykyyykhk',
    'khhhhhhhhhhk',
    '.kkkkkkkkkk.',
    '............',
  ],
};
ICON_PALETTE.a = [252, 216, 112];

const iconCache = new Map<string, string>();

/** Data URL of a tool's pixel icon (12x12), or '' if there is none. */
export function toolIcon(id: string): string {
  if (iconCache.has(id)) return iconCache.get(id)!;
  const art = ICONS[id];
  if (!art) return '';
  const { c, g } = makeCanvas(12, 12);
  art.forEach((row, y) => [...row].forEach((ch, x) => { const col = ICON_PALETTE[ch]; if (col) px(g, x, y, col); }));
  const url = c.toDataURL();
  iconCache.set(id, url);
  return url;
}

/** Generate the chrome images and expose them (and the UI pixel size) as CSS custom properties. */
export function installPixelUI() {
  const root = document.documentElement.style;
  const set = (name: string, url: string) => root.setProperty(name, `url(${url})`);
  root.setProperty('--px', `${UI_PX}px`);
  set('--frame-panel', frame({ outline: [5, 6, 10], light: [58, 64, 88], dark: [12, 13, 20], fill: [24, 26, 38], rivets: [110, 90, 52] }));
  set('--frame-button', frame({ outline: [5, 6, 10], light: [74, 82, 112], dark: [18, 20, 32], fill: [38, 43, 60], notched: true }));
  set('--frame-button-hover', frame({ outline: [5, 6, 10], light: [92, 102, 136], dark: [24, 27, 42], fill: [48, 54, 74], notched: true }));
  set('--frame-button-down', frame({ outline: [5, 6, 10], light: [12, 34, 54], dark: [60, 124, 176], fill: [31, 74, 110], notched: true }));
  set('--frame-button-brass', frame({ outline: [5, 6, 10], light: [34, 24, 10], dark: [176, 138, 60], fill: [74, 58, 26], notched: true }));
  set('--frame-inset', frame({ outline: [58, 64, 88], light: [5, 6, 10], dark: [40, 44, 62], fill: [8, 9, 14] }));
  set('--frame-header', frame({ outline: [5, 6, 10], light: [58, 64, 88], dark: [12, 13, 20], fill: [24, 26, 38], rivets: [110, 90, 52] }));
  set('--frame-solved', frame({ outline: [5, 6, 10], light: [123, 224, 138], dark: [20, 60, 30], fill: [31, 74, 44], notched: true }));
  set('--dither-bg', dither([14, 15, 22], [20, 22, 32], 0.25));
  set('--dither-panel', dither([24, 26, 38], [28, 31, 45], 0.12));
}

/** A 12x12 icon for a brush size: a filled pixel disc, bigger for bigger brushes (index 0..3). */
export function brushIcon(index: number): string {
  const key = `brush${index}`;
  if (iconCache.has(key)) return iconCache.get(key)!;
  const r = [1.6, 2.6, 3.7, 5.4][index] ?? 5.4;
  const { c, g } = makeCanvas(12, 12);
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) {
    const d = Math.hypot(x + 0.5 - 6, y + 0.5 - 6);
    if (d <= r) px(g, x, y, d > r - 1 ? [5, 6, 10] : d < r * 0.45 && x < 6 && y < 6 ? [236, 240, 248] : [150, 156, 176]);
  }
  const url = c.toDataURL();
  iconCache.set(key, url);
  return url;
}
