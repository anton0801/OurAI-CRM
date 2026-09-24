/**
 * Synthetic load-test database for the staging load profile (spec §28.3, acceptance T170).
 *
 *   pnpm perf:seed [--scale 1] [--database castlane_perf] [--admin-url postgres://…/postgres]
 *
 * Drops and recreates a dedicated database (default `castlane_perf`), applies every migration and
 * fills ONE workspace with the spec volumes × scale: 200 members, 1000 projects, 5000 accounts,
 * 100000 content items, 300000 publications, 500000 tasks, 2000000 metric values and 300000
 * financial lines (scale 1). Rows are generated in PostgreSQL (INSERT … SELECT generate_series, in
 * batches) with deterministic pseudo-random values, so two runs at the same scale produce the same
 * shape. All schema rules stay active: foreign keys, CHECK constraints, unique indexes and the
 * append-only / immutable-finance triggers (entries are posted only after their lines exist).
 *
 * The data is synthetic and never meant for production: the script refuses non-local database
 * hosts, NODE_ENV=production and database names without "perf" unless
 * `--i-know-this-is-not-production` is passed.
 */
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { createDatabase, runMigrations, workspaces } from '@castlane/database';
import { createWorkspaceWithDefaults, hashPassword } from '@castlane/application';
import { newId } from '@castlane/domain';
import { eq } from 'drizzle-orm';
import {
  FIRST_NAMES,
  LAST_NAMES,
  NOUNS,
  ADJECTIVES,
  TASK_VERBS,
  TASK_OBJECTS,
  ROLE_MIX,
  SEED_MANIFEST_KEY,
  arg,
  flag,
  sqlTextArray,
  type SeedManifest,
} from './shared';

const OVERRIDE = '--i-know-this-is-not-production';

const scale = Number(arg('scale') ?? process.env.PERF_SCALE ?? '1');
if (!Number.isFinite(scale) || scale <= 0 || scale > 1) {
  console.error('--scale must be a number in (0, 1].');
  process.exit(2);
}
const adminUrl =
  arg('admin-url') ??
  process.env.PERF_ADMIN_URL ??
  process.env.TEST_DATABASE_ADMIN_URL ??
  'postgres://castlane:castlane@127.0.0.1:5432/postgres';
const dbName = arg('database') ?? process.env.PERF_DATABASE ?? 'castlane_perf';

// ——— Safety: synthetic data only ever goes into a local, dedicated database ———

const guard = () => {
  const problems: string[] = [];
  const host = new URL(adminUrl).hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]', ''].includes(host))
    problems.push(`database host "${host}" is not local`);
  if (process.env.NODE_ENV === 'production') problems.push('NODE_ENV is production');
  if (!/perf/i.test(dbName))
    problems.push(
      `database name "${dbName}" does not contain "perf" (the database is dropped and recreated)`,
    );
  if (!/^[a-z0-9_]+$/.test(dbName)) problems.push(`database name "${dbName}" must match [a-z0-9_]+`);
  if (problems.length && !flag(OVERRIDE.slice(2))) {
    console.error(`Refusing to seed synthetic load data: ${problems.join('; ')}.`);
    console.error(
      `The load database must be separate from production. Pass ${OVERRIDE} only for a dedicated staging database.`,
    );
    process.exit(2);
  }
};

const urlFor = (db: string) => {
  const u = new URL(adminUrl);
  u.pathname = `/${db}`;
  return u.toString();
};

// ——— Volumes ———

const SPEC = {
  members: 200,
  projects: 1000,
  accounts: 5000,
  content: 100_000,
  publications: 300_000,
  tasks: 500_000,
  metricValues: 2_000_000,
  financialLines: 300_000,
};
const ACCOUNTS_PER_PROJECT = 5;
const CONTENT_PER_PROJECT = 100;
const PUBLICATIONS_PER_CONTENT = 3;
const TASKS_PER_PROJECT = 500;
const HISTORY_DAYS = 730;
const SNAPSHOT_WEEKS = 104;

const P = Math.max(4, Math.round(SPEC.projects * scale));
const V = {
  members: Math.max(24, Math.round(SPEC.members * scale)),
  directions: Math.max(2, Math.round(10 * Math.sqrt(scale))),
  projects: P,
  accounts: P * ACCOUNTS_PER_PROJECT,
  content: P * CONTENT_PER_PROJECT,
  publications: P * CONTENT_PER_PROJECT * PUBLICATIONS_PER_CONTENT,
  tasks: P * TASKS_PER_PROJECT,
  metricValues: Math.round(SPEC.metricValues * (P / SPEC.projects)),
  financialLines: Math.round(SPEC.financialLines * (P / SPEC.projects)),
};

/** Contiguous member-index ranges per role (index 0 is the Owner created by the application). */
const roleGroups = () => {
  const rest = V.members - 1;
  const groups: Record<string, { start: number; count: number }> = {};
  let next = 1;
  let assigned = 0;
  const keys = Object.keys(ROLE_MIX);
  keys.forEach((key, i) => {
    const mix = ROLE_MIX[key]!;
    const count =
      i === keys.length - 1 ? Math.max(1, rest - assigned) : Math.max(mix.min, Math.round(mix.share * rest));
    groups[key] = { start: next, count };
    next += count;
    assigned += count;
  });
  V.members = next; // the last group absorbs rounding
  return groups;
};

// ——— Runner helpers ———

const t0 = new Date(Math.floor(Date.now() / 60_000) * 60_000);
const T0 = `'${t0.toISOString()}'::timestamptz`;
const started = performance.now();
const secs = (from: number) => ((performance.now() - from) / 1000).toFixed(1);
const log = (m: string) => console.log(`[${secs(started).padStart(6)}s] ${m}`);

let client: pg.Client;
const q = (text: string, values: unknown[] = []) => client.query(text, values);

/** Run a generator statement over [1, total] in batches (`$1` = first index, `$2` = last index). */
const batched = async (label: string, total: number, batch: number, text: string, values: unknown[] = []) => {
  const t = performance.now();
  let rows = 0;
  for (let from = 1; from <= total; from += batch) {
    const to = Math.min(total, from + batch - 1);
    const r = await q(text, [from, to, ...values]);
    rows += r.rowCount ?? 0;
    if (total > batch)
      process.stdout.write(`\r  ${label}: ${to.toLocaleString('en')}/${total.toLocaleString('en')}`);
  }
  if (total > batch) process.stdout.write('\n');
  log(`${label}: ${rows.toLocaleString('en')} rows in ${secs(t)}s`);
  return rows;
};

// ——— Deterministic generators (SQL functions in a scratch schema dropped at the end) ———

const createHelpers = async (g: ReturnType<typeof roleGroups>, ownerUserId: string) => {
  const n = (k: string) => g[k]!;
  await q(`DROP SCHEMA IF EXISTS perf_seed CASCADE; CREATE SCHEMA perf_seed;`);
  await q(`
    -- Stable RFC 4122 v4-shaped UUID for (kind, n): lets every generator reference rows by index.
    -- Every helper is a single SELECT expression without FROM so the planner inlines it.
    CREATE FUNCTION perf_seed.uid(kind text, n bigint) RETURNS uuid LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT overlay(overlay(md5(kind || ':' || n::text) placing '4' from 13) placing '8' from 17)::uuid $$;
    -- Deterministic uniform [0, 1) for (n, salt).
    CREATE FUNCTION perf_seed.rnd(n bigint, salt int) RETURNS double precision LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT ('x' || substr(md5(salt::text || '/' || n::text), 1, 8))::bit(32)::bigint::float8 / 4294967296.0::float8 $$;
    CREATE FUNCTION perf_seed.pick(arr text[], n bigint) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT arr[1 + (n % array_length(arr, 1))::int] $$;
    CREATE FUNCTION perf_seed.person(i bigint) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT perf_seed.pick(${sqlTextArray(FIRST_NAMES)}, i) || ' ' || perf_seed.pick(${sqlTextArray(LAST_NAMES)}, i / ${FIRST_NAMES.length} + i * 7) $$;
    CREATE FUNCTION perf_seed.adj(i bigint) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT perf_seed.pick(${sqlTextArray(ADJECTIVES)}, i) $$;
    CREATE FUNCTION perf_seed.noun(i bigint) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT perf_seed.pick(${sqlTextArray(NOUNS)}, i) $$;
    CREATE FUNCTION perf_seed.verb(i bigint) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT perf_seed.pick(${sqlTextArray(TASK_VERBS)}, i) $$;
    CREATE FUNCTION perf_seed.obj(i bigint) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT perf_seed.pick(${sqlTextArray(TASK_OBJECTS)}, i) $$;

    -- The Owner (created by the application with a random id).
    CREATE FUNCTION perf_seed.owner_user() RETURNS uuid LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT '${ownerUserId}'::uuid $$;
    -- Member index of a role group by position; membership id = uid('m', index), user id = uid('u', index).
    CREATE FUNCTION perf_seed.member_idx(role text, i bigint) RETURNS bigint LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT CASE role
        ${Object.entries(g)
          .map(([k, v]) => `WHEN '${k}' THEN ${v.start} + (i % ${v.count})`)
          .join('\n        ')}
      END $$;
    CREATE FUNCTION perf_seed.member(role text, i bigint) RETURNS uuid LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT perf_seed.uid('m', perf_seed.member_idx(role, i)) $$;

    -- Project team (project index p, 1-based): lead, producer, two creators.
    CREATE FUNCTION perf_seed.project_lead(p bigint) RETURNS uuid LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT perf_seed.member('project_lead', p - 1) $$;
    CREATE FUNCTION perf_seed.project_producer(p bigint) RETURNS uuid LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT perf_seed.member('producer', p - 1) $$;
    CREATE FUNCTION perf_seed.project_creator(p bigint, k int) RETURNS uuid LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT perf_seed.member('creator', p - 1 + k * ${Math.max(1, Math.floor(n('creator').count / 2))}) $$;
    CREATE FUNCTION perf_seed.team_idx(p bigint, k bigint) RETURNS bigint LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT CASE k % 4 WHEN 0 THEN perf_seed.member_idx('project_lead', p - 1) WHEN 1 THEN perf_seed.member_idx('producer', p - 1)
        WHEN 2 THEN perf_seed.member_idx('creator', p - 1) ELSE perf_seed.member_idx('creator', p - 1 + ${Math.max(1, Math.floor(n('creator').count / 2))}) END $$;
    CREATE FUNCTION perf_seed.team(p bigint, k bigint) RETURNS uuid LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT perf_seed.uid('m', perf_seed.team_idx(p, k)) $$;
    -- Account a (1-based) belongs to project ((a-1) % P) + 1 and is run by one publisher.
    CREATE FUNCTION perf_seed.account_project(a bigint) RETURNS bigint LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT ((a - 1) % ${P}) + 1 $$;
    CREATE FUNCTION perf_seed.account_publisher(a bigint) RETURNS uuid LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT perf_seed.member('publisher', a - 1) $$;
    CREATE FUNCTION perf_seed.account_platform(a bigint) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT CASE WHEN perf_seed.rnd(a, 70) < 0.06 THEN 'fansly' ELSE perf_seed.pick(ARRAY['instagram','tiktok','youtube','x','onlyfans'], (a - 1) / ${P}) END $$;
    CREATE FUNCTION perf_seed.account_handle(a bigint) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT lower(perf_seed.noun(a * 7)) || '_' || lower(perf_seed.adj(a * 3)) || '_' || a $$;
    -- Content c belongs to project ((c-1) % P) + 1; most historical content is approved.
    CREATE FUNCTION perf_seed.stage_of(r double precision) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT CASE WHEN r < 0.80 THEN 'approved' WHEN r < 0.83 THEN 'archived' WHEN r < 0.86 THEN 'idea' WHEN r < 0.89 THEN 'brief'
        WHEN r < 0.92 THEN 'ready' WHEN r < 0.96 THEN 'production' WHEN r < 0.98 THEN 'review' ELSE 'changes_requested' END $$;
    CREATE FUNCTION perf_seed.content_stage(c bigint) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT perf_seed.stage_of(perf_seed.rnd(c, 30)) $$;
    CREATE FUNCTION perf_seed.content_account(c bigint) RETURNS bigint LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT ((c - 1) % ${P}) + 1 + ${P} * (((c - 1) / ${P}) % ${ACCOUNTS_PER_PROJECT}) $$;
    CREATE FUNCTION perf_seed.content_created(c bigint) RETURNS timestamptz LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT ${T0} - make_interval(secs => (8 + perf_seed.rnd(c, 31) * ${HISTORY_DAYS - 8}) * 86400) $$;
    -- Publication u: content ((u-1) % C) + 1 placed on one of the project's accounts.
    CREATE FUNCTION perf_seed.pub_content(u bigint) RETURNS bigint LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT ((u - 1) % ${V.content}) + 1 $$;
    CREATE FUNCTION perf_seed.pub_account(u bigint) RETURNS bigint LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT ((u - 1) % ${V.content} % ${P}) + 1 + ${P} * (((((u - 1) % ${V.content}) / ${P}) + ((u - 1) / ${V.content})) % ${ACCOUNTS_PER_PROJECT}) $$;
    CREATE FUNCTION perf_seed.status_of(approved boolean, r double precision) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT CASE WHEN NOT approved THEN 'draft' WHEN r < 0.86 THEN 'published' WHEN r < 0.94 THEN 'scheduled' WHEN r < 0.97 THEN 'cancelled' ELSE 'failed' END $$;
    CREATE FUNCTION perf_seed.pub_status(u bigint) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT perf_seed.status_of(perf_seed.content_stage(perf_seed.pub_content(u)) = 'approved', perf_seed.rnd(u, 40)) $$;
    -- Published: spread over the history window; scheduled: next 30 days.
    CREATE FUNCTION perf_seed.when_of(status text, r double precision) RETURNS timestamptz LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT CASE status
        WHEN 'scheduled' THEN ${T0} + make_interval(secs => 3600 + r * 30 * 86400)
        WHEN 'draft' THEN NULL
        ELSE ${T0} - make_interval(secs => 3600 + r * ${HISTORY_DAYS - 1} * 86400) END $$;
    CREATE FUNCTION perf_seed.pub_when(u bigint) RETURNS timestamptz LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT perf_seed.when_of(perf_seed.pub_status(u), perf_seed.rnd(u, 41)) $$;
    CREATE FUNCTION perf_seed.host(platform text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT CASE platform WHEN 'instagram' THEN 'instagram.com' WHEN 'tiktok' THEN 'tiktok.com' WHEN 'youtube' THEN 'youtube.com'
        WHEN 'x' THEN 'x.com' WHEN 'onlyfans' THEN 'onlyfans.com' WHEN 'fansly' THEN 'fansly.com' ELSE 'example.com' END $$;
    CREATE FUNCTION perf_seed.iso(t timestamptz) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT to_char(t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;
  `);
};

// ——— Generators ———

const seedPeople = async (
  workspaceId: string,
  g: ReturnType<typeof roleGroups>,
  roleIds: Map<string, string>,
) => {
  const hash = await hashPassword(`perf-${newId()}-${newId()}`); // nobody knows it; sessions are minted by the runner
  const since = `${T0} - interval '${HISTORY_DAYS + 60} days'`;
  const last = V.members - 1;
  await q(
    `INSERT INTO users (id, normalized_email, display_email, display_name, password_hash, password_changed_at, created_at, updated_at)
     SELECT perf_seed.uid('u', i), 'perf-member-' || i || '@perf.castlane.invalid', 'perf-member-' || i || '@perf.castlane.invalid',
            perf_seed.person(i), $1, ${since}, ${since}, ${since}
     FROM generate_series(1, ${last}) i`,
    [hash],
  );
  await q(
    `INSERT INTO user_preferences (user_id, timezone) SELECT perf_seed.uid('u', i), 'Europe/Berlin' FROM generate_series(1, ${last}) i`,
  );
  await q(
    `INSERT INTO memberships (id, workspace_id, user_id, status, display_name_snapshot, title, skills, joined_at, created_at, updated_at)
     SELECT perf_seed.uid('m', i), $1, perf_seed.uid('u', i), 'active', perf_seed.person(i),
            perf_seed.pick(ARRAY['Producer','Editor','Writer','Publisher','Analyst','Designer','Video Generation','Voice'], i),
            ARRAY[perf_seed.pick(ARRAY['editing','writing','voice','image_generation','video_generation','publishing'], i)],
            ${since}, ${since}, ${since}
     FROM generate_series(1, ${last}) i`,
    [workspaceId],
  );
  for (const [key, grp] of Object.entries(g)) {
    const scope =
      key === 'direction_lead'
        ? `'direction', perf_seed.uid('d', ((i - ${grp.start}) % ${V.directions}) + 1)`
        : ['project_lead', 'producer', 'creator'].includes(key)
          ? `'assigned_projects', NULL`
          : key === 'publisher'
            ? `'assigned_accounts', NULL`
            : `'workspace', NULL`;
    await q(
      `INSERT INTO role_assignments (id, workspace_id, membership_id, role_id, scope_type, scope_id, valid_from, created_at, updated_at, reason)
       SELECT perf_seed.uid('ra', i), $1, perf_seed.uid('m', i), $2, ${scope}, ${since}, ${since}, ${since}, 'Synthetic load-test member'
       FROM generate_series(${grp.start}, ${grp.start + grp.count - 1}) i`,
      [workspaceId, roleIds.get(key)],
    );
  }
  log(
    `members: ${V.members} (${Object.entries(g)
      .map(([k, v]) => `${k} ${v.count}`)
      .join(', ')}, owner 1)`,
  );
};

const seedOrganization = async (workspaceId: string) => {
  await q(
    `INSERT INTO directions (id, workspace_id, name, name_key, description, lead_membership_id, status, sort_order, created_at, updated_at)
     SELECT perf_seed.uid('d', d), $1, 'Direction ' || perf_seed.noun(d * 11) || ' ' || d, lower('Direction ' || perf_seed.noun(d * 11) || ' ' || d),
            'Synthetic direction for the load profile', perf_seed.member('direction_lead', d - 1), 'active', d,
            ${T0} - interval '${HISTORY_DAYS + 30} days', ${T0} - interval '${HISTORY_DAYS + 30} days'
     FROM generate_series(1, ${V.directions}) d`,
    [workspaceId],
  );
  await batched(
    'projects',
    V.projects,
    5000,
    `WITH g AS (SELECT p, ${T0} - make_interval(secs => (60 + perf_seed.rnd(p, 1) * ${HISTORY_DAYS - 60}) * 86400) AS created FROM generate_series($1::int, $2::int) p)
     INSERT INTO projects (id, workspace_id, created_at, updated_at, created_by, updated_by, row_version, type, direction_id, name, owner_membership_id,
                           status, brief_summary, description, language, target_markets, audience, tags, start_date, ofm_enabled, completed_at)
     SELECT perf_seed.uid('p', p), $3, created, created + make_interval(secs => perf_seed.rnd(p, 2) * extract(epoch FROM ${T0} - created)), NULL, NULL, 1,
            perf_seed.pick(ARRAY['series','model','influencer'], p), perf_seed.uid('d', ((p - 1) % ${V.directions}) + 1),
            perf_seed.adj(p) || ' ' || perf_seed.noun(p / 20 + p) || ' ' || p, perf_seed.project_lead(p),
            CASE WHEN p % 20 = 0 THEN 'completed' WHEN p % 20 = 1 THEN 'paused' WHEN p % 20 = 2 THEN 'draft' ELSE 'active' END,
            'Short-form ' || lower(perf_seed.noun(p)) || ' stories for ' || perf_seed.pick(ARRAY['EU','US','LATAM','APAC'], p) || ' audiences',
            'Synthetic project generated for the load profile.', 'en', ARRAY[perf_seed.pick(ARRAY['EU','US','LATAM','APAC'], p)],
            perf_seed.pick(ARRAY['18-24','25-34','35-44'], p), ARRAY[lower(perf_seed.adj(p * 3))],
            (created)::date, p % 7 = 0, CASE WHEN p % 20 = 0 THEN created + interval '40 days' END
     FROM g`,
    [workspaceId],
  );
  await batched(
    'project memberships',
    V.projects,
    5000,
    `INSERT INTO project_memberships (id, workspace_id, project_id, membership_id, responsibility, valid_from, created_at, updated_at)
     SELECT perf_seed.uid('pm', p * 4 + k), $3, perf_seed.uid('p', p), perf_seed.team(p, k),
            (ARRAY['direction_management','producing','writing','editing'])[k + 1],
            ${T0} - interval '${HISTORY_DAYS + 1} days', ${T0} - interval '${HISTORY_DAYS + 1} days', ${T0} - interval '${HISTORY_DAYS + 1} days'
     FROM generate_series($1::int, $2::int) p CROSS JOIN generate_series(0, 3) k
     ON CONFLICT DO NOTHING`,
    [workspaceId],
  );
  await batched(
    'accounts',
    V.accounts,
    10000,
    `WITH g AS (SELECT a, perf_seed.account_platform(a) AS platform, perf_seed.account_handle(a) AS handle,
                       ${T0} - make_interval(secs => (${HISTORY_DAYS} + perf_seed.rnd(a, 3) * 20) * 86400) AS created
                FROM generate_series($1::int, $2::int) a)
     INSERT INTO social_accounts (id, workspace_id, created_at, updated_at, row_version, project_id, platform, original_url, canonical_url, identity_key,
                                  handle, display_name, owner_membership_id, status, language, markets, purpose, tags, metrics_cadence, metrics_day_of_week, metrics_time)
     SELECT perf_seed.uid('a', a), $3, created, created + make_interval(secs => perf_seed.rnd(a, 4) * extract(epoch FROM ${T0} - created)), 1,
            perf_seed.uid('p', perf_seed.account_project(a)), platform,
            'https://www.' || perf_seed.host(platform) || '/' || CASE WHEN platform IN ('tiktok','youtube') THEN '@' ELSE '' END || handle,
            'https://' || perf_seed.host(platform) || '/' || CASE WHEN platform IN ('tiktok','youtube') THEN '@' ELSE '' END || handle,
            platform || '|' || perf_seed.host(platform) || '/' || CASE WHEN platform IN ('tiktok','youtube') THEN '@' ELSE '' END || handle,
            handle, initcap(replace(handle, '_', ' ')), perf_seed.account_publisher(a),
            CASE WHEN perf_seed.rnd(a, 5) < 0.88 THEN 'active' WHEN perf_seed.rnd(a, 5) < 0.93 THEN 'paused' WHEN perf_seed.rnd(a, 5) < 0.97 THEN 'preparing' ELSE 'restricted' END,
            'en', ARRAY['EU'], 'Distribution for ' || perf_seed.noun(a), ARRAY[lower(perf_seed.adj(a))], 'weekly', 1 + (a % 5)::int, '10:00'
     FROM g`,
    [workspaceId],
  );
  await batched(
    'account assignments',
    V.accounts,
    10000,
    `INSERT INTO account_assignments (id, workspace_id, account_id, membership_id, duty, valid_from, created_at, updated_at)
     SELECT perf_seed.uid('aa', a), $3, perf_seed.uid('a', a), perf_seed.account_publisher(a), 'publishing',
            ${T0} - interval '${HISTORY_DAYS + 1} days', ${T0} - interval '${HISTORY_DAYS + 1} days', ${T0} - interval '${HISTORY_DAYS + 1} days'
     FROM generate_series($1::int, $2::int) a`,
    [workspaceId],
  );
};

const seedContent = async (workspaceId: string) => {
  await batched(
    'content items',
    V.content,
    25000,
    `WITH g AS (SELECT c, ((c - 1) % ${P}) + 1 AS p, (c - 1) / ${P} AS k, perf_seed.content_stage(c) AS stage, perf_seed.content_created(c) AS created
                FROM generate_series($1::int, $2::int) c)
     INSERT INTO content_items (id, workspace_id, created_at, updated_at, row_version, project_id, title, format, stage, owner_membership_id, reviewer_membership_id,
                                brief, language, due_at, no_deadline, tags, first_approved_at, entered_ready_at, account_id)
     SELECT perf_seed.uid('c', c), $3, created,
            CASE WHEN stage IN ('approved','archived') THEN created + interval '6 days' ELSE created + make_interval(secs => perf_seed.rnd(c, 32) * extract(epoch FROM ${T0} - created)) END,
            1, perf_seed.uid('p', p),
            perf_seed.noun(c * 5) || ' ' || perf_seed.obj(c) || ' ' || c,
            perf_seed.pick(ARRAY['short_video','short_video','short_video','episode','trailer','image','carousel','photo_set','story','text_post'], c * 3),
            stage, perf_seed.project_creator(p, (k % 2)::int), perf_seed.project_lead(p),
            jsonb_build_object('summary', perf_seed.adj(c) || ' ' || lower(perf_seed.noun(c)) || ' piece for the ' || lower(perf_seed.noun(p)) || ' audience',
                               'objective', 'Grow reach', 'hook', 'Open on the ' || lower(perf_seed.obj(c * 7))),
            'en', CASE WHEN stage NOT IN ('approved','archived') THEN created + interval '10 days' END, false,
            CASE WHEN perf_seed.rnd(c, 33) < 0.2 THEN ARRAY[lower(perf_seed.adj(c * 13))] ELSE '{}'::text[] END,
            CASE WHEN stage IN ('approved','archived') THEN created + interval '6 days' END,
            CASE WHEN stage NOT IN ('idea','brief') THEN created + interval '2 days' END,
            perf_seed.uid('a', perf_seed.content_account(c))
     FROM g`,
    [workspaceId],
  );
  await batched(
    'content stage events',
    V.content,
    25000,
    `INSERT INTO content_stage_events (id, workspace_id, created_at, updated_at, content_item_id, from_stage, to_stage, occurred_at, actor_membership_id)
     SELECT perf_seed.uid('cse', c), $3, perf_seed.content_created(c) + interval '6 days', perf_seed.content_created(c) + interval '6 days', perf_seed.uid('c', c),
            'review', 'approved', perf_seed.content_created(c) + interval '6 days', perf_seed.project_lead(((c - 1) % ${P}) + 1)
     FROM generate_series($1::int, $2::int) c WHERE perf_seed.content_stage(c) IN ('approved', 'archived')`,
    [workspaceId],
  );
  await batched(
    'publications',
    V.publications,
    25000,
    `WITH g AS (SELECT u, perf_seed.pub_content(u) AS c, perf_seed.pub_account(u) AS a, perf_seed.pub_status(u) AS status, perf_seed.pub_when(u) AS at
                FROM generate_series($1::int, $2::int) u),
          h AS (SELECT g.*, perf_seed.account_platform(a) AS platform, ((c - 1) % ${P}) + 1 AS p,
                       COALESCE(at - interval '3 days', perf_seed.content_created(c) + interval '7 days') AS created FROM g)
     INSERT INTO publications (id, workspace_id, created_at, updated_at, row_version, content_item_id, account_id, project_id, owner_membership_id, caption, cta,
                               descriptive_tags, status, scheduled_at, schedule_timezone, original_scheduled_at, actual_published_at, external_post_url,
                               normalized_post_url, failure_reason, cancel_reason, confirmed_by_membership_id)
     SELECT perf_seed.uid('u', u), $3, created, LEAST(${T0}, COALESCE(at, created) + interval '1 hour'), 1, perf_seed.uid('c', c), perf_seed.uid('a', a), perf_seed.uid('p', p),
            perf_seed.account_publisher(a),
            'New ' || lower(perf_seed.noun(c * 5)) || ' ' || perf_seed.obj(c) || ' out now #' || lower(perf_seed.adj(u)) || ' #' || lower(perf_seed.noun(p)),
            perf_seed.pick(ARRAY['Link in bio','Follow for part 2','Save for later'], u),
            CASE WHEN perf_seed.rnd(u, 42) < 0.15 THEN ARRAY[lower(perf_seed.adj(u * 3))] ELSE '{}'::text[] END,
            status, CASE WHEN status <> 'draft' THEN at - make_interval(secs => perf_seed.rnd(u, 43) * 1800) END,
            CASE WHEN status <> 'draft' THEN 'Europe/Berlin' END,
            CASE WHEN status <> 'draft' THEN at - make_interval(secs => perf_seed.rnd(u, 43) * 1800) END,
            CASE WHEN status = 'published' THEN at END,
            CASE WHEN status = 'published' THEN 'https://www.' || perf_seed.host(platform) || '/p/perf' || u END,
            CASE WHEN status = 'published' THEN 'https://' || perf_seed.host(platform) || '/p/perf' || u END,
            CASE WHEN status = 'failed' THEN 'Platform rejected the upload' END,
            CASE WHEN status = 'cancelled' THEN 'Plan changed' END,
            CASE WHEN status = 'published' THEN perf_seed.account_publisher(a) END
     FROM h`,
    [workspaceId],
  );
};

const seedTasks = async (workspaceId: string) => {
  await batched(
    'tasks',
    V.tasks,
    50000,
    `WITH g AS (SELECT t, ((t - 1) % ${P}) + 1 AS p, (t - 1) / ${P} AS k, perf_seed.rnd(t, 50) AS r FROM generate_series($1::int, $2::int) t),
          -- Two years of history: 78 % done, 7 % cancelled, 15 % open (open work is recent, see created below).
          s AS (SELECT g.*, CASE WHEN r < 0.78 THEN 'done' WHEN r < 0.85 THEN 'cancelled' WHEN r < 0.87 THEN 'draft' WHEN r < 0.91 THEN 'backlog'
                                 WHEN r < 0.94 THEN 'ready' WHEN r < 0.98 THEN 'in_progress' ELSE 'in_review' END AS status FROM g),
          d AS (SELECT s.*,
                       CASE WHEN status IN ('done','cancelled') THEN ${T0} - make_interval(secs => (30 + perf_seed.rnd(t, 51) * ${HISTORY_DAYS - 30}) * 86400)
                            ELSE ${T0} - make_interval(secs => perf_seed.rnd(t, 51) * 120 * 86400) END AS created,
                       CASE WHEN status IN ('draft','backlog') AND perf_seed.rnd(t, 52) < 0.3 THEN NULL ELSE perf_seed.team_idx(p, k) END AS assignee_idx
                FROM s),
          e AS (SELECT d.*, CASE WHEN perf_seed.rnd(t, 53) < 0.85 THEN created + make_interval(secs => (2 + perf_seed.rnd(t, 54) * 20) * 86400) END AS due,
                       CASE WHEN status = 'done' THEN created + make_interval(secs => (1 + perf_seed.rnd(t, 55) * 20) * 86400) END AS completed
                FROM d)
     INSERT INTO tasks (id, workspace_id, created_at, updated_at, created_by, row_version, project_id, title, description, status, priority,
                        assignee_membership_id, reviewer_membership_id, start_at, due_at, baseline_due_at, estimate_minutes, account_id, content_item_id,
                        blocked_at, blocked_reason, completed_at, completed_by, completion_effective_at, assignee_at_completion, cancelled_at, cancel_reason, tags)
     SELECT perf_seed.uid('t', t), $3, created,
            CASE WHEN completed IS NOT NULL THEN completed WHEN status = 'cancelled' THEN created + interval '3 days'
                 ELSE created + make_interval(secs => perf_seed.rnd(t, 56) * extract(epoch FROM ${T0} - created)) END,
            NULL, 1, perf_seed.uid('p', p),
            perf_seed.verb(t * 7) || ' ' || lower(perf_seed.obj(t * 13)) || ' — ' || perf_seed.noun(t * 3) || ' ' || t,
            CASE WHEN perf_seed.rnd(t, 57) < 0.5 THEN 'Deliver the ' || lower(perf_seed.obj(t)) || ' following the brief of the ' || lower(perf_seed.noun(p)) || ' project.' END,
            status,
            CASE WHEN perf_seed.rnd(t, 58) < 0.1 THEN 'low' WHEN perf_seed.rnd(t, 58) < 0.75 THEN 'normal' WHEN perf_seed.rnd(t, 58) < 0.93 THEN 'high' ELSE 'urgent' END,
            perf_seed.uid('m', assignee_idx), CASE WHEN perf_seed.rnd(t, 59) < 0.5 THEN perf_seed.project_lead(p) END,
            CASE WHEN status IN ('in_progress','in_review','done') AND due IS NOT NULL THEN created + interval '1 day' END,
            due, CASE WHEN status NOT IN ('draft','backlog') THEN due END,
            (30 + floor(perf_seed.rnd(t, 60) * 16) * 30)::int,
            CASE WHEN perf_seed.rnd(t, 61) >= 0.9 THEN perf_seed.uid('a', p + ${P} * (k % ${ACCOUNTS_PER_PROJECT})) END,
            CASE WHEN perf_seed.rnd(t, 61) < 0.4 THEN perf_seed.uid('c', p + ${P} * (k % ${CONTENT_PER_PROJECT})) END,
            CASE WHEN status = 'in_progress' AND perf_seed.rnd(t, 62) < 0.05 THEN created + interval '2 days' END,
            CASE WHEN status = 'in_progress' AND perf_seed.rnd(t, 62) < 0.05 THEN 'Waiting for source files' END,
            completed, CASE WHEN completed IS NOT NULL THEN coalesce(perf_seed.uid('u', assignee_idx), perf_seed.owner_user()) END, completed,
            CASE WHEN completed IS NOT NULL THEN perf_seed.uid('m', assignee_idx) END,
            CASE WHEN status = 'cancelled' THEN created + interval '3 days' END, CASE WHEN status = 'cancelled' THEN 'No longer needed' END,
            CASE WHEN perf_seed.rnd(t, 63) < 0.2 THEN ARRAY[perf_seed.pick(ARRAY['rush','client','reshoot','evergreen','seasonal'], t)] ELSE '{}'::text[] END
     FROM e`,
    [workspaceId],
  );
  await batched(
    'task status events',
    V.tasks,
    100000,
    `INSERT INTO task_status_events (id, workspace_id, created_at, updated_at, task_id, from_status, to_status, occurred_at, effective_at, actor_membership_id, cycle)
     SELECT perf_seed.uid('tse', i), t.workspace_id, t.completed_at, t.completed_at, t.id, 'in_progress', 'done', t.completed_at, t.completed_at, t.assignee_at_completion, 1
     FROM generate_series($1::int, $2::int) i JOIN tasks t ON t.id = perf_seed.uid('t', i)
     WHERE t.workspace_id = $3 AND t.status = 'done'`,
    [workspaceId],
  );
};

const PUB_METRICS: [string, number, number][] = [
  // key, share of views (lower bound), spread
  ['publication.views', 1, 0],
  ['publication.reach', 0.55, 0.4],
  ['publication.likes', 0.02, 0.08],
  ['publication.comments', 0.002, 0.01],
  ['publication.shares', 0.001, 0.01],
  ['publication.saves', 0.002, 0.02],
];

const seedMetrics = async (workspaceId: string) => {
  const obsInsert = (idKind: string, offsetHours: number, when: string) => `
    INSERT INTO metric_observations (id, workspace_id, created_at, updated_at, entity_type, entity_id, account_id, project_id, publication_id, kind, observed_at,
                                     platform_timezone, definition_set_version, segment, source_type, source_namespace, source_note, entered_at, entered_by_membership_id,
                                     quality_state, revision_no, root_observation_id, reviewed_by, reviewed_at, dedupe_key, canonical)
    SELECT perf_seed.uid('${idKind}', u), $3, obs + interval '1 hour', obs + interval '1 hour', 'publication', perf_seed.uid('u', u),
           perf_seed.uid('a', perf_seed.pub_account(u)), perf_seed.uid('p', ((perf_seed.pub_content(u) - 1) % ${P}) + 1), perf_seed.uid('u', u), 'cumulative', obs,
           'UTC', 1, 'combined', 'manual', 'manual', 'Synthetic load-test observation', obs + interval '1 hour', perf_seed.account_publisher(perf_seed.pub_account(u)),
           CASE WHEN perf_seed.rnd(u, 70) < 0.3 THEN 'reviewed' ELSE 'unverified' END, 1, perf_seed.uid('${idKind}', u),
           CASE WHEN perf_seed.rnd(u, 70) < 0.3 THEN perf_seed.owner_user() END, CASE WHEN perf_seed.rnd(u, 70) < 0.3 THEN obs + interval '2 hours' END,
           'publication:' || perf_seed.uid('u', u) || ':v1:cumulative:' || perf_seed.iso(obs) || ':combined:manual', true
    FROM (SELECT u, perf_seed.pub_when(u) + interval '${offsetHours} hours' + make_interval(secs => (perf_seed.rnd(u, 71) - 0.5) * 3600) AS obs
          FROM generate_series($1::int, $2::int) u WHERE perf_seed.pub_status(u) = 'published') x
    WHERE ${when}`;
  const valuesInsert = (idKind: string, keys: [string, number, number][]) => `
    INSERT INTO metric_values (id, workspace_id, created_at, updated_at, observation_id, metric_key, definition_version, value, availability, unit)
    SELECT perf_seed.uid('${idKind}v', u * 16 + k.i), $3, o.entered_at, o.entered_at, o.id, k.key, 1,
           round(exp(5 + 7 * perf_seed.rnd(u, 80)) * (k.lo + k.spread * perf_seed.rnd(u * 16 + k.i, 81)) * ${idKind === 'o7' ? '1.8' : '1'}), 'known', 'count'
    FROM generate_series($1::int, $2::int) u
    JOIN metric_observations o ON o.id = perf_seed.uid('${idKind}', u)
    CROSS JOIN (VALUES ${keys.map(([key, lo, spread], i) => `('${key}', ${lo}::float8, ${spread}::float8, ${i})`).join(', ')}) AS k(key, lo, spread, i)`;

  await batched(
    'publication observations (24 h checkpoint)',
    V.publications,
    50000,
    obsInsert('o24', 24, `obs + interval '1 hour' < ${T0}`),
    [workspaceId],
  );
  await batched('publication metric values (24 h)', V.publications, 50000, valuesInsert('o24', PUB_METRICS), [
    workspaceId,
  ]);
  const countValues = async () =>
    Number(
      (
        (await q(`SELECT count(*)::int AS n FROM metric_values WHERE workspace_id = $1`, [workspaceId]))
          .rows[0] as { n: number }
      ).n,
    );
  const pubValues = await countValues();

  // Account follower snapshots: weekly, newest first, as many weeks as the history allows.
  const snapshotWeeks = Math.min(
    SNAPSHOT_WEEKS,
    Math.max(1, Math.floor((V.metricValues - pubValues) / V.accounts)),
  );
  const snapshots = V.accounts * snapshotWeeks;
  await batched(
    'account follower snapshots',
    snapshots,
    100000,
    `WITH g AS (SELECT i, ((i - 1) / ${snapshotWeeks}) + 1 AS a, (i - 1) % ${snapshotWeeks} AS w FROM generate_series($1::int, $2::int) i),
          h AS (SELECT g.*, ${T0} - make_interval(days => (w * 7 + (a % 7))::int, hours => 2) AS obs FROM g)
     INSERT INTO metric_observations (id, workspace_id, created_at, updated_at, entity_type, entity_id, account_id, project_id, kind, observed_at, platform_timezone,
                                      definition_set_version, segment, source_type, source_namespace, source_note, entered_at, entered_by_membership_id,
                                      quality_state, revision_no, root_observation_id, dedupe_key, canonical)
     SELECT perf_seed.uid('os', i), $3, obs + interval '1 hour', obs + interval '1 hour', 'account', perf_seed.uid('a', a), perf_seed.uid('a', a),
            perf_seed.uid('p', perf_seed.account_project(a)), 'snapshot', obs, 'UTC', 1, 'combined', 'manual', 'manual', 'Weekly follower snapshot (synthetic)',
            obs + interval '1 hour', perf_seed.account_publisher(a), 'unverified', 1, perf_seed.uid('os', i),
            'account:' || perf_seed.uid('a', a) || ':v1:snapshot:' || perf_seed.iso(obs) || ':combined:manual', true
     FROM h`,
    [workspaceId],
  );
  await batched(
    'account follower values',
    snapshots,
    100000,
    `INSERT INTO metric_values (id, workspace_id, created_at, updated_at, observation_id, metric_key, definition_version, value, availability, unit)
     SELECT perf_seed.uid('osv', i), $3, now(), now(), perf_seed.uid('os', i), 'account.followers', 1,
            round(exp(7 + 5 * perf_seed.rnd(((i - 1) / ${snapshotWeeks}) + 1, 90)) * (1 - ((i - 1) % ${snapshotWeeks}) * 0.004)), 'known', 'count'
     FROM generate_series($1::int, $2::int) i`,
    [workspaceId],
  );
  // Fill the remainder with 7-day checkpoint observations (4 values each) on older publications.
  const remaining = V.metricValues - (await countValues());
  if (remaining > 0) {
    const keys = PUB_METRICS.filter(([k]) => !k.endsWith('reach') && !k.endsWith('saves'));
    const want = Math.ceil(remaining / keys.length);
    // A deterministic sample of the publications old enough for a 7-day checkpoint fills the target.
    const eligible = Number(
      (
        (
          await q(
            `SELECT count(*)::int AS n FROM publications WHERE workspace_id = $1 AND status = 'published' AND actual_published_at < ${T0} - interval '169 hours'`,
            [workspaceId],
          )
        ).rows[0] as { n: number }
      ).n,
    );
    const share = Math.min(1, want / Math.max(1, eligible));
    await batched(
      'publication observations (7 d checkpoint)',
      V.publications,
      50000,
      obsInsert('o7', 168, `perf_seed.rnd(u, 72) < ${share} AND obs + interval '1 hour' < ${T0}`),
      [workspaceId],
    );
    await batched('publication metric values (7 d)', V.publications, 50000, valuesInsert('o7', keys), [
      workspaceId,
    ]);
  }
};

const seedFinance = async (workspaceId: string) => {
  const cats = (
    await q(`SELECT key, id, accounting_class FROM finance_categories WHERE workspace_id = $1`, [workspaceId])
  ).rows as { key: string; id: string; accounting_class: string }[];
  const byKey = new Map(cats.map((c) => [c.key, c]));
  const arr = (keys: string[]) => `ARRAY[${keys.map((k) => `'${byKey.get(k)!.id}'::uuid`).join(',')}]`;
  const revenue = ['subscriptions', 'renewals', 'content_sales', 'tips', 'sponsorship'];
  const fees = ['platform_fee', 'payment_processing_fee'];
  const expenses = [
    'production_services',
    'ai_tools',
    'editing',
    'voice',
    'advertising',
    'contractors',
    'software',
  ];
  const entries = Math.floor(V.financialLines / 2);
  // 1) documents as drafts, 2) their lines and project allocations, 3) post them (posted documents are immutable).
  await batched(
    'financial entries',
    entries,
    50000,
    `WITH g AS (SELECT e, perf_seed.rnd(e, 100) < 0.6 AS rev, (${T0} - make_interval(days => (1 + floor(perf_seed.rnd(e, 101) * ${HISTORY_DAYS}))::int))::date AS day
                FROM generate_series($1::int, $2::int) e)
     INSERT INTO financial_entries (id, workspace_id, created_at, updated_at, created_by, type, state, recognition_date, title, counterparty, account_id, note)
     SELECT perf_seed.uid('fe', e), $3, day + time '12:00', day + time '12:00', perf_seed.owner_user(),
            CASE WHEN rev THEN 'revenue' ELSE 'expense' END, 'draft', day,
            CASE WHEN rev THEN 'Platform payout ' || perf_seed.account_handle(((e - 1) % ${V.accounts}) + 1) ELSE perf_seed.pick(ARRAY['Editing invoice','Voice session','Tool subscription','Ad spend','Contractor invoice'], e) || ' #' || e END,
            CASE WHEN rev THEN 'Platform' ELSE perf_seed.person(e) END,
            CASE WHEN rev THEN perf_seed.uid('a', ((e - 1) % ${V.accounts}) + 1) END, 'Synthetic ledger entry'
     FROM g`,
    [workspaceId],
  );
  await batched(
    'financial lines',
    entries,
    50000,
    `WITH g AS (SELECT e, l, fe.type = 'revenue' AS rev, fe.recognition_date AS day,
                       CASE WHEN fe.account_id IS NOT NULL THEN perf_seed.account_project(((e - 1) % ${V.accounts}) + 1) ELSE ((e - 1) % ${P}) + 1 END AS p,
                       (1000 + floor(perf_seed.rnd(e * 2 + l, 110) * 250000))::bigint AS amount
                FROM generate_series($1::int, $2::int) e CROSS JOIN generate_series(1, 2) l
                JOIN financial_entries fe ON fe.id = perf_seed.uid('fe', e))
     INSERT INTO financial_entry_lines (id, workspace_id, created_at, updated_at, entry_id, line_no, category_id, accounting_class, amount_minor, currency,
                                        base_amount_minor, base_currency, description, source_namespace)
     SELECT perf_seed.uid('fl', e * 2 + l), $3, day + time '12:00', day + time '12:00', perf_seed.uid('fe', e), l,
            CASE WHEN rev AND l = 1 THEN perf_seed.pick(${arr(revenue)}::text[], e)::uuid WHEN rev THEN perf_seed.pick(${arr(fees)}::text[], e)::uuid
                 ELSE perf_seed.pick(${arr(expenses)}::text[], e + l)::uuid END,
            CASE WHEN rev AND l = 1 THEN 'revenue' WHEN rev THEN 'fee' ELSE 'operating_expense' END,
            CASE WHEN rev AND l = 2 THEN amount / 5 ELSE amount END, 'EUR', CASE WHEN rev AND l = 2 THEN amount / 5 ELSE amount END, 'EUR',
            CASE WHEN l = 1 THEN 'Gross' ELSE 'Fees / second item' END, 'manual'
     FROM g`,
    [workspaceId],
  );
  await batched(
    'financial allocations',
    entries,
    50000,
    `INSERT INTO financial_allocations (id, workspace_id, created_at, updated_at, line_id, entry_id, project_id, amount_minor, base_amount_minor, share_percent, effective_date)
     SELECT perf_seed.uid('fa', e * 2 + l), $3, fl.created_at, fl.created_at, fl.id, fl.entry_id,
            CASE WHEN fe.account_id IS NOT NULL THEN perf_seed.uid('p', perf_seed.account_project(((e - 1) % ${V.accounts}) + 1)) ELSE perf_seed.uid('p', ((e - 1) % ${P}) + 1) END,
            fl.amount_minor, fl.base_amount_minor, 100, fe.recognition_date
     FROM generate_series($1::int, $2::int) e CROSS JOIN generate_series(1, 2) l
     JOIN financial_entry_lines fl ON fl.id = perf_seed.uid('fl', e * 2 + l)
     JOIN financial_entries fe ON fe.id = fl.entry_id`,
    [workspaceId],
  );
  await batched(
    'post financial entries',
    entries,
    50000,
    `UPDATE financial_entries SET state = 'posted', submitted_at = recognition_date + time '13:00', submitted_by = perf_seed.owner_user(),
            posted_at = recognition_date + time '14:00', posted_by = perf_seed.owner_user(), row_version = 3
     WHERE workspace_id = $3 AND id IN (SELECT perf_seed.uid('fe', i) FROM generate_series($1::int, $2::int) i)`,
    [workspaceId],
  );
};

/** Search projection rows, built exactly like the application's index functions. */
const seedSearch = async (workspaceId: string) => {
  const t = performance.now();
  await q(
    `INSERT INTO search_documents (workspace_id, entity_type, entity_id, title, body, project_id, direction_id, permission, owner_membership_id, archived, status, updated_at)
     SELECT workspace_id, 'direction', id, name, coalesce(description, ''), NULL, id, 'directions.read', NULL, status = 'archived', NULL, updated_at FROM directions WHERE workspace_id = $1;
     `,
    [workspaceId],
  );
  await q(
    `INSERT INTO search_documents (workspace_id, entity_type, entity_id, title, body, permission, owner_membership_id, archived, status, updated_at)
     SELECT m.workspace_id, 'member', m.id, u.display_name, concat_ws(E'\\n', m.title, u.display_email, array_to_string(m.skills, ' ')), 'members.read', m.id,
            m.status = 'deactivated', m.status, m.updated_at
     FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1`,
    [workspaceId],
  );
  await q(
    `INSERT INTO search_documents (workspace_id, entity_type, entity_id, title, body, project_id, direction_id, permission, owner_membership_id, archived, status, updated_at)
     SELECT workspace_id, 'project', id, name, concat_ws(E'\\n', brief_summary, description, audience, nullif(array_to_string(tags, ' '), '')), id, direction_id,
            'projects.read', owner_membership_id, status = 'archived' OR deleted_at IS NOT NULL, status, updated_at
     FROM projects WHERE workspace_id = $1`,
    [workspaceId],
  );
  await q(
    `INSERT INTO search_documents (workspace_id, entity_type, entity_id, title, body, project_id, account_id, permission, owner_membership_id, assignee_membership_ids, archived, status, updated_at)
     SELECT a.workspace_id, 'account', a.id, '@' || a.handle,
            concat_ws(E'\\n', a.canonical_url, a.handle, a.display_name, initcap(a.platform), a.purpose, nullif(array_to_string(a.tags, ' '), '')),
            a.project_id, a.id, 'accounts.read', a.owner_membership_id,
            coalesce((SELECT array_agg(x.membership_id) FROM account_assignments x WHERE x.account_id = a.id AND x.valid_to IS NULL), '{}'),
            a.status = 'archived' OR a.deleted_at IS NOT NULL, a.status, a.updated_at
     FROM social_accounts a WHERE a.workspace_id = $1`,
    [workspaceId],
  );
  log(`search documents (directions, members, projects, accounts) in ${secs(t)}s`);
  await batched(
    'search documents: content',
    V.content,
    25000,
    `INSERT INTO search_documents (workspace_id, entity_type, entity_id, title, body, project_id, account_id, permission, owner_membership_id, assignee_membership_ids, archived, status, updated_at)
     SELECT c.workspace_id, 'content_item', c.id, c.title,
            concat_ws(E'\\n', c.brief->>'summary', c.brief->>'objective', c.brief->>'hook', c.brief->>'audience', nullif(array_to_string(c.tags, ' '), '')),
            c.project_id, c.account_id, 'content.read', c.owner_membership_id, array_remove(ARRAY[c.owner_membership_id, c.reviewer_membership_id], NULL),
            c.archived_at IS NOT NULL, c.stage, c.updated_at
     FROM generate_series($1::int, $2::int) i JOIN content_items c ON c.id = perf_seed.uid('c', i) WHERE c.workspace_id = $3`,
    [workspaceId],
  );
  await batched(
    'search documents: tasks',
    V.tasks,
    50000,
    `INSERT INTO search_documents (workspace_id, entity_type, entity_id, title, body, project_id, account_id, permission, assignee_membership_ids, archived, status, updated_at)
     SELECT t.workspace_id, 'task', t.id, t.title, concat_ws(E'\\n', t.description, nullif(array_to_string(t.tags, ' '), '')), t.project_id, t.account_id, 'tasks.read',
            array_remove(ARRAY[t.assignee_membership_id, t.reviewer_membership_id], NULL), t.archived_at IS NOT NULL, t.status, t.updated_at
     FROM generate_series($1::int, $2::int) i JOIN tasks t ON t.id = perf_seed.uid('t', i) WHERE t.workspace_id = $3`,
    [workspaceId],
  );
  await batched(
    'search documents: publications',
    V.publications,
    50000,
    `INSERT INTO search_documents (workspace_id, entity_type, entity_id, title, body, project_id, account_id, direction_id, permission, owner_membership_id,
                                   assignee_membership_ids, archived, status, updated_at)
     SELECT p.workspace_id, 'publication', p.id, c.title || ' — @' || a.handle,
            concat_ws(E'\\n', p.caption, p.external_post_url,
                      CASE WHEN p.external_post_url IS NOT NULL THEN regexp_replace(regexp_replace(p.external_post_url, '^https?://(www\\.)?', ''), '/', ' ', 'g') END,
                      p.cta, p.destination_url, nullif(array_to_string(p.descriptive_tags, ' '), '')),
            p.project_id, p.account_id, pr.direction_id, 'publications.read', p.owner_membership_id, ARRAY[p.owner_membership_id],
            p.archived_at IS NOT NULL OR p.deleted_at IS NOT NULL, p.status, p.updated_at
     FROM generate_series($1::int, $2::int) i JOIN publications p ON p.id = perf_seed.uid('u', i)
     JOIN content_items c ON c.id = p.content_item_id JOIN social_accounts a ON a.id = p.account_id JOIN projects pr ON pr.id = p.project_id
     WHERE p.workspace_id = $3`,
    [workspaceId],
  );
};

const COUNTED_TABLES = [
  'memberships',
  'directions',
  'projects',
  'project_memberships',
  'social_accounts',
  'account_assignments',
  'content_items',
  'publications',
  'tasks',
  'task_status_events',
  'metric_observations',
  'metric_values',
  'financial_entries',
  'financial_entry_lines',
  'financial_allocations',
  'search_documents',
] as const;

const main = async () => {
  guard();
  const groups = roleGroups();
  console.log(`Castlane load database: ${dbName} (scale ${scale})`);
  console.log(`Targets: ${JSON.stringify(V)}`);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin
    .query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    )
    .catch(() => undefined);
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();
  const url = urlFor(dbName);
  await runMigrations(url, (m) => log(`migrate: ${m}`));

  // Workspace, role presets, finance categories and templates through the application code.
  const handle = createDatabase(url, { max: 2 });
  const ownerId = newId();
  const ownerHash = await hashPassword(`perf-owner-${newId()}`);
  await handle.pool.query(
    `INSERT INTO users (id, normalized_email, display_email, display_name, password_hash, password_changed_at, created_at, updated_at)
     VALUES ($1, 'perf-owner@perf.castlane.invalid', 'perf-owner@perf.castlane.invalid', 'Perf Owner', $2, now(), now(), now())`,
    [ownerId, ownerHash],
  );
  const { workspaceId, membershipId: ownerMembershipId } = await createWorkspaceWithDefaults(handle.db, {
    name: 'Load Profile Workspace',
    timezone: 'Europe/Berlin',
    baseCurrency: 'EUR',
    ownerUserId: ownerId,
    ownerDisplayName: 'Perf Owner',
    at: new Date(t0.getTime() - (HISTORY_DAYS + 90) * 86_400_000),
  });
  await handle.db
    .update(workspaces)
    .set({
      setupStep: 'completed',
      setupCompletedAt: new Date(t0.getTime() - (HISTORY_DAYS + 89) * 86_400_000),
    })
    .where(eq(workspaces.id, workspaceId));
  const roleIds = new Map(
    (
      (await handle.pool.query(`SELECT key, id FROM roles WHERE workspace_id = $1`, [workspaceId])).rows as {
        key: string;
        id: string;
      }[]
    ).map((r) => [r.key, r.id]),
  );
  await handle.close();
  log(`workspace ${workspaceId} created through the application defaults`);

  client = new pg.Client({ connectionString: url, application_name: 'castlane-perf-seed' });
  await client.connect();
  await q(`SET synchronous_commit = off`); // bulk load only; the data is disposable
  await createHelpers(groups, ownerId);
  await seedPeople(workspaceId, groups, roleIds);
  await seedOrganization(workspaceId);
  await seedContent(workspaceId);
  await seedTasks(workspaceId);
  await seedMetrics(workspaceId);
  await seedFinance(workspaceId);
  await seedSearch(workspaceId);

  await q(`DROP SCHEMA perf_seed CASCADE`);

  const tv = performance.now();
  await q(`VACUUM (ANALYZE)`);
  log(`VACUUM ANALYZE in ${secs(tv)}s`);

  const counts: Record<string, number> = {};
  for (const t of COUNTED_TABLES) {
    const r = await q(`SELECT count(*)::bigint AS n FROM "${t}" WHERE workspace_id = $1`, [workspaceId]);
    counts[t] = Number((r.rows[0] as { n: string }).n);
  }
  const size = (await q(`SELECT pg_database_size(current_database())::bigint AS b`)).rows[0] as { b: string };
  const manifest: SeedManifest = {
    workspaceId,
    ownerUserId: ownerId,
    ownerMembershipId,
    scale,
    seededAt: new Date().toISOString(),
    anchor: t0.toISOString(),
    targets: V,
    counts,
    databaseBytes: Number(size.b),
    seedSeconds: Math.round((performance.now() - started) / 1000),
    roleGroups: groups,
  };
  await q(
    `INSERT INTO system_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
    [SEED_MANIFEST_KEY, JSON.stringify(manifest)],
  );
  await client.end();

  console.log('\nAchieved row counts (workspace-scoped):');
  const spec: Record<string, number> = {
    memberships: SPEC.members,
    projects: SPEC.projects,
    social_accounts: SPEC.accounts,
    content_items: SPEC.content,
    publications: SPEC.publications,
    tasks: SPEC.tasks,
    metric_values: SPEC.metricValues,
    financial_entry_lines: SPEC.financialLines,
  };
  for (const [k, n] of Object.entries(counts))
    console.log(
      `  ${k.padEnd(24)} ${n.toLocaleString('en').padStart(12)}${spec[k] ? `   (spec ${spec[k]!.toLocaleString('en')} × ${scale})` : ''}`,
    );
  console.log(`Database size: ${(Number(size.b) / 1024 ** 3).toFixed(2)} GiB; total ${secs(started)}s`);
  console.log(`DATABASE_URL=${url}`);
};

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
