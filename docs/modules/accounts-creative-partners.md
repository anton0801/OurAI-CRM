# Accounts, characters, series, references, partners & deals (S16–S21, S73, S74)

Code: `packages/application/src/{accounts,creative,partners}/`, contracts of the same names.

Helpers: `accountScope`, `scopeOfAccount`, `accountVisibility`, `loadAccount`, `characterScope`, `canDeal`, `canPartner`, `loadDealRow`,
`createIdeaDraftFromReference` (placeholder insert into `content_items`; the content module should own it),
`createCampaignForDeal` (placeholder insert into `campaigns`; the campaigns module should own it).

Rules worth knowing: account identity is canonical per workspace (tracking params stripped, case-sensitive custom paths kept);
archiving an account is blocked by scheduled publications, active/scheduled shifts and open OFM assignments; transfer is blocked by
active shifts, pending content reviews and submitted shift reports. Character version submit/approve writes `reviews`/`review_decisions`
(target type character version) and flags content `needsConsistencyReview`.

Registries: lookups account, character, season, episode, scene, reference, partner, deal; link access for the same; archive handlers;
responsibility `accounts.owner`, `accounts.assignment`, `deals.owner`, `partners.owner`; import `accounts`, `references`; export
accounts, references, partners, deals. Renders `ACCOUNT_TABS`, `CHARACTER_PANELS`, `EPISODE_PANELS`, `DEAL_PANELS`.

Open items for later modules: S17 Generate Production Tasks / Export Episode Package; S74 Generate Deliverable Tasks and Register Income
Draft; S18 bulk Schedule Metrics Check; S20 Log Incident, New Publication, Add Metrics actions.
