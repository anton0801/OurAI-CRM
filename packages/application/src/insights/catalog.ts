import { and, desc, eq } from 'drizzle-orm';
import { checkpointPolicies, metricDefinitions, type CheckpointPolicyConfig } from '@castlane/database';
import { OBSERVATION_DATASETS, type EnumValue } from '@castlane/domain';
import { dbOf } from '../core/context';
import { memo, type Ctx } from './common';

export type ObservationDatasetKey = EnumValue<typeof OBSERVATION_DATASETS>;
export type MetricEntityType = 'account' | 'publication' | 'ofm_account';
export type ObservationKind = 'snapshot' | 'period' | 'cumulative';

/** Observation datasets of §15.2: the entity type and time semantics decide the permitted fields. */
export const OBSERVATION_DATASET_DEFS: Record<ObservationDatasetKey, { entityType: MetricEntityType; kind: ObservationKind; label: string; description: string }> = {
  account_snapshot: {
    entityType: 'account',
    kind: 'snapshot',
    label: 'Account Snapshot',
    description: 'State of the account at the moment of observation: followers, following, posts, active paid subscribers.',
  },
  account_period: {
    entityType: 'account',
    kind: 'period',
    label: 'Account Period',
    description: 'Results the platform reports for a period [start, end): views, impressions, reach, profile visits, link clicks, follows.',
  },
  publication_cumulative: {
    entityType: 'publication',
    kind: 'cumulative',
    label: 'Publication Cumulative',
    description: 'Totals of one publication at the moment of observation: views, reach, interactions, watch time, clicks.',
  },
  ofm_period: {
    entityType: 'ofm_account',
    kind: 'period',
    label: 'OFM Period',
    description: 'Subscriptions and platform-reported sales of an OFM account for a period. Analytics only — the ledger changes only after reconciliation.',
  },
};

export const datasetKeyOf = (entityType: MetricEntityType, kind: ObservationKind): ObservationDatasetKey | null =>
  (Object.entries(OBSERVATION_DATASET_DEFS).find(([, d]) => d.entityType === entityType && d.kind === kind)?.[0] as ObservationDatasetKey | undefined) ?? null;

export type FieldDefinition = typeof metricDefinitions.$inferSelect;

/** System catalogue rows (all versions). */
export const loadFieldDefinitions = (ctx: Ctx): Promise<FieldDefinition[]> =>
  memo(ctx, 'fieldDefinitions', () => dbOf(ctx).select().from(metricDefinitions).orderBy(metricDefinitions.key, metricDefinitions.version));

/** Fields permitted for a dataset in one definition set version. */
export const fieldsFor = (defs: FieldDefinition[], entityType: MetricEntityType, kind: ObservationKind, version: number) =>
  defs.filter((d) => d.entityType === entityType && d.observationKind === kind && d.version === version && d.active);

export const definitionSetVersions = (defs: FieldDefinition[]) => [...new Set(defs.filter((d) => d.active).map((d) => d.version))].sort((a, b) => a - b);

export const fieldLabel = (defs: FieldDefinition[], key: string) => defs.find((d) => d.key === key)?.label ?? key;

export interface PolicyRow {
  id: string;
  version: number;
  config: CheckpointPolicyConfig;
}

const DEFAULT_POLICY: CheckpointPolicyConfig = {
  publication: [
    { key: 'pub_24h', offsetHours: 24, toleranceHours: 2, requiredMetrics: ['publication.views', 'publication.likes', 'publication.comments', 'publication.shares', 'publication.saves'] },
    { key: 'pub_7d', offsetHours: 168, toleranceHours: 12, requiredMetrics: ['publication.views', 'publication.likes', 'publication.comments', 'publication.shares', 'publication.saves'] },
  ],
  account: { requiredMetrics: ['account.followers'], graceHours: 24 },
};

/** Active checkpoint policy (versioned; the 24 h / 7 d default when a workspace has none). */
export const activePolicy = (ctx: Ctx): Promise<PolicyRow> =>
  memo(ctx, 'policy', async () => {
    const [p] = await dbOf(ctx)
      .select()
      .from(checkpointPolicies)
      .where(and(eq(checkpointPolicies.workspaceId, ctx.actor.workspaceId), eq(checkpointPolicies.active, true)))
      .orderBy(desc(checkpointPolicies.version))
      .limit(1);
    // No configured policy: the 24 h / 7 d default, version 0 (as the publications module records it).
    return p ? { id: p.id, version: p.version, config: p.config } : { id: 'default', version: 0, config: DEFAULT_POLICY };
  });

export const ACCOUNT_CHECKPOINT_KEY = 'account_snapshot';

/** Human label of a checkpoint key. */
export const checkpointLabel = (key: string, policy?: CheckpointPolicyConfig) => {
  if (key === ACCOUNT_CHECKPOINT_KEY) return 'Account snapshot';
  // Checkpoints created by an automation rule carry their label in the key.
  if (key.startsWith('automation:')) return key.slice('automation:'.length) || 'Automation checkpoint';
  const hours = policy?.publication.find((r) => r.key === key)?.offsetHours ?? (key === 'pub_24h' ? 24 : key === 'pub_7d' ? 168 : null);
  if (hours === null) return key;
  return hours >= 48 && hours % 24 === 0 ? `${hours / 24} d after publication` : `${hours} h after publication`;
};

/** Required fields of a checkpoint (policy version fixed on the checkpoint). */
export const requiredMetricsFor = (key: string, policy: CheckpointPolicyConfig) =>
  key === ACCOUNT_CHECKPOINT_KEY ? policy.account.requiredMetrics : (policy.publication.find((r) => r.key === key)?.requiredMetrics ?? []);

/** Headline fields shown in observation tables. */
export const HEADLINE_FIELDS: Record<ObservationDatasetKey, string[]> = {
  account_snapshot: ['account.followers', 'account.active_paid_subscribers'],
  account_period: ['account.views', 'account.impressions', 'account.link_clicks'],
  publication_cumulative: ['publication.views', 'publication.likes', 'publication.comments'],
  ofm_period: ['ofm.new_paid_subscribers', 'ofm.cancellations', 'ofm.gross_sales'],
};
