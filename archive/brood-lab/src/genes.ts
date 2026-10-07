export const GENES = ['size', 'speed', 'bite', 'armor', 'fertility'] as const;
export type Gene = (typeof GENES)[number];
export type Genome = Record<Gene, number>; // each gene is 0..1

export const GENE_INFO: Record<Gene, { label: string; hint: string }> = {
  size: { label: 'Size', hint: 'Bigger body: stores more energy, but burns more' },
  speed: { label: 'Speed', hint: 'Reaches food and mates first, but burns energy' },
  bite: { label: 'Bite', hint: 'Fighting power. Costs energy to maintain' },
  armor: { label: 'Armor', hint: 'Toughness. Costs energy to maintain and slows' },
  fertility: { label: 'Fertility', hint: 'Mating urge: breeds sooner, more often, even when hungry' },
};

export interface Stats {
  radius: number;
  speed: number; // px/s
  maxEnergy: number;
  metabolism: number; // energy burned per second
  mateThreshold: number; // fraction of max energy needed before it wants to mate
  mateCooldown: number; // seconds
}

// Every useful trait has an upkeep, so scarce food pushes the swarm toward small and cheap.
export function deriveStats(g: Genome): Stats {
  return {
    radius: 4 + g.size * 5,
    speed: (25 + g.speed * 70) * (1 - g.armor * 0.3),
    maxEnergy: 60 + g.size * 60,
    metabolism: 0.5 + g.size * 0.8 + g.speed * 0.6 + g.bite * 0.5 + g.armor * 0.5,
    mateThreshold: 0.85 - g.fertility * 0.45,
    mateCooldown: 25 - g.fertility * 15,
  };
}

function gauss(): number {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function wildGenome(): Genome {
  const g = {} as Genome;
  for (const k of GENES) g[k] = clamp01(0.2 + Math.random() * 0.3);
  return g;
}

/** Each gene comes from one parent, then drifts. Radiation (0..1) widens the drift and adds wild jumps. */
export function breed(a: Genome, b: Genome, radiation: number): Genome {
  const sd = 0.03 + radiation * 0.12;
  const jump = radiation * 0.12;
  const g = {} as Genome;
  for (const k of GENES) {
    const v = Math.random() < 0.5 ? a[k] : b[k];
    g[k] = clamp01(Math.random() < jump ? Math.random() : v + gauss() * sd);
  }
  return g;
}

const SYLLABLES = ['zk', 'ra', 'xi', 'th', 'ul', 'ka', 'ss', 'or', 'vex', 'ny', 'gr', 'ix', 'ak', 'zu', 'ch', 'ee', 'ma', 'ty'];

export function makeName(): string {
  const n = 2 + Math.floor(Math.random() * 2);
  let s = '';
  for (let i = 0; i < n; i++) s += SYLLABLES[Math.floor(Math.random() * SYLLABLES.length)];
  return s[0].toUpperCase() + s.slice(1);
}
