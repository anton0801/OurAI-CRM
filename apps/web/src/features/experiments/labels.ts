import '@/features/publications/labels';

/** Query-key prefixes refreshed after experiment commands. */
export const EXPERIMENT_INVALIDATE = ['experiments.', 'publications.', 'campaigns.'];

export const WINDOW_PRESETS = [
  { hours: 24, label: '24 h' },
  { hours: 72, label: '72 h' },
  { hours: 168, label: '7 days' },
  { hours: 720, label: '30 days' },
];

/** §31 microcopy: never present an organic comparison as a randomized A/B test. */
export const ORGANIC_CAVEAT = 'Organic comparison, not a randomized A/B test. No statistical significance is calculated.';
export const NOT_COMPARABLE_NOTE = 'Placements are compared only at the same post age. Values observed at other ages are marked Not Comparable.';

export const windowText = (hours: number) => (hours % 24 === 0 ? `${hours / 24} day${hours === 24 ? '' : 's'} (${hours} h)` : `${hours} h`);
