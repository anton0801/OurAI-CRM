import '@/features/publications/labels';

/** Query-key prefixes refreshed after campaign commands. */
export const CAMPAIGN_INVALIDATE = ['campaigns.', 'trackingLinks.', 'publications.', 'experiments.', 'deals.', 'finance.'];

/** §31 microcopy for campaigns. */
export const TAGGED_URL_NOTE = 'A tagged URL is an ordinary link with parameters. Castlane does not redirect or count clicks; clicks appear only from source reports you enter.';
export const DUPLICATE_NOTE = 'Duplicate Structure copies the objective, projects, goals and tags. Costs, income, placements and results are not copied.';
export const RESULTS_NOTE = 'Values come only from source reports entered for this campaign. An empty value means the source did not report it.';
