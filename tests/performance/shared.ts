/** Shared constants and helpers of the load-test harness (seed, runner, report). */

export const SEED_MANIFEST_KEY = 'perf_seed_manifest';

export const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
};

export const flag = (name: string): boolean => process.argv.includes(`--${name}`);

/** SQL text[] literal of plain words (vocabulary constants only; never user input). */
export const sqlTextArray = (xs: readonly string[]) =>
  `ARRAY[${xs.map((x) => `'${x.replace(/'/g, "''")}'`).join(',')}]`;

/** Role mix of the 200 members (share of the non-owner members, minimum count at small scales). */
export const ROLE_MIX: Record<string, { share: number; min: number }> = {
  admin: { share: 0.02, min: 1 },
  direction_lead: { share: 0.05, min: 2 },
  project_lead: { share: 0.15, min: 3 },
  producer: { share: 0.2, min: 3 },
  creator: { share: 0.25, min: 4 },
  publisher: { share: 0.15, min: 3 },
  analyst: { share: 0.075, min: 2 },
  finance_manager: { share: 0.05, min: 1 },
  viewer: { share: 0.055, min: 1 },
};

export const ADJECTIVES = [
  'Silver',
  'Crimson',
  'Golden',
  'Midnight',
  'Velvet',
  'Neon',
  'Quiet',
  'Wild',
  'Electric',
  'Frozen',
  'Hidden',
  'Lunar',
  'Solar',
  'Urban',
  'Coastal',
  'Northern',
  'Secret',
  'Lucky',
  'Rapid',
  'Gentle',
] as const;

export const NOUNS = [
  'Aurora',
  'Nebula',
  'Harbor',
  'Orchid',
  'Falcon',
  'Summit',
  'Lagoon',
  'Ember',
  'Cascade',
  'Meadow',
  'Canyon',
  'Comet',
  'Horizon',
  'Willow',
  'Atlas',
  'Echo',
  'Prism',
  'Tundra',
  'Mosaic',
  'Voyage',
  'Juniper',
  'Sierra',
  'Onyx',
  'Marble',
  'Saffron',
  'Cobalt',
  'Driftwood',
  'Lantern',
  'Monsoon',
  'Pioneer',
  'Quartz',
  'Riviera',
  'Sequoia',
  'Tempest',
  'Valley',
  'Zephyr',
  'Beacon',
  'Citadel',
  'Dune',
  'Fjord',
] as const;

export const TASK_VERBS = [
  'Draft',
  'Edit',
  'Review',
  'Render',
  'Script',
  'Storyboard',
  'Grade',
  'Caption',
  'Schedule',
  'Publish',
  'Retouch',
  'Voice',
  'Subtitle',
  'Research',
  'Approve',
  'Plan',
  'Cut',
  'Mix',
  'Export',
  'Upload',
] as const;

export const TASK_OBJECTS = [
  'Hook',
  'Intro',
  'Teaser',
  'Episode',
  'Thumbnail',
  'Caption',
  'Cover',
  'Reel',
  'Carousel',
  'Story',
  'Trailer',
  'Script',
  'Shot list',
  'Moodboard',
  'Voice track',
  'Music bed',
  'Subtitles',
  'Post copy',
  'Brief',
  'Outline',
] as const;

export const FIRST_NAMES = [
  'Anna',
  'Boris',
  'Clara',
  'Daniel',
  'Elena',
  'Felix',
  'Greta',
  'Hugo',
  'Irina',
  'Jonas',
  'Katya',
  'Lukas',
  'Maria',
  'Nikita',
  'Olga',
  'Pavel',
  'Quinn',
  'Rosa',
  'Sasha',
  'Timur',
  'Ulla',
  'Viktor',
  'Wanda',
  'Xenia',
  'Yuri',
  'Zoe',
  'Adrian',
  'Bianca',
  'Carlos',
  'Dina',
] as const;

export const LAST_NAMES = [
  'Ivanova',
  'Keller',
  'Novak',
  'Petrov',
  'Schmidt',
  'Horvat',
  'Kowalski',
  'Lebedev',
  'Moreau',
  'Nielsen',
  'Orlova',
  'Popescu',
  'Rossi',
  'Sokolov',
  'Tanaka',
  'Urban',
  'Vasquez',
  'Weber',
  'Yilmaz',
  'Zeller',
  'Andersen',
  'Bauer',
  'Costa',
  'Dubois',
  'Esposito',
  'Fischer',
  'Garcia',
  'Hoffmann',
  'Jansen',
  'Kuznetsova',
] as const;

export interface SeedManifest {
  workspaceId: string;
  ownerUserId: string;
  ownerMembershipId: string;
  scale: number;
  seededAt: string;
  /** Time anchor of the synthetic history ("now" at seeding). */
  anchor: string;
  targets: Record<string, number>;
  counts: Record<string, number>;
  databaseBytes: number;
  seedSeconds: number;
  roleGroups: Record<string, { start: number; count: number }>;
}

/** Spec §28.3 volumes per workspace (scale 1). */
export const SPEC_VOLUMES: Record<string, number> = {
  memberships: 200,
  projects: 1000,
  social_accounts: 5000,
  content_items: 100_000,
  publications: 300_000,
  tasks: 500_000,
  metric_values: 2_000_000,
  financial_entry_lines: 300_000,
};

/** Spec §28.3 thresholds (p95, milliseconds) per request class. */
export const THRESHOLDS: Record<string, { p95: number; label: string }> = {
  list: { p95: 500, label: 'API list' },
  detail: { p95: 500, label: 'API detail' },
  search: { p95: 700, label: 'Search' },
  analytics: { p95: 2000, label: 'Standard 90-day analytics' },
  write: { p95: 800, label: 'Critical writes' },
  heavy: { p95: 1000, label: 'Heavy request returns a job' },
};
