import { hasAnywhere } from '@castlane/authorization';
import type { MetricCatalog } from '@castlane/api-contracts';
import { AppError, OBSERVATION_DATASETS } from '@castlane/domain';
import { forbidden } from '@castlane/domain';
import type { QueryContext } from '../core/context';
import { OBSERVATION_DATASET_DEFS, definitionSetVersions, fieldsFor, loadFieldDefinitions } from './catalog';
import { availableInsightMetrics } from './semantic/registry';

const ANALYTICS = ['analytics.production.read', 'analytics.accounts.read', 'analytics.content.read', 'analytics.ofm.read', 'analytics.team.read', 'analytics.finance.read', 'reports.read'];

/** Metric catalogue: versioned observation fields per dataset and the semantic metrics the member may use. */
export const metricCatalog = async (ctx: QueryContext): Promise<MetricCatalog> => {
  if (!hasAnywhere(ctx.actor.access, 'metrics.read') && !ANALYTICS.some((p) => hasAnywhere(ctx.actor.access, p))) throw forbidden();
  const defs = await loadFieldDefinitions(ctx);
  const versions = definitionSetVersions(defs);
  const current = versions[versions.length - 1] ?? 1;
  return {
    fields: defs.map((d) => ({ id: d.id, key: d.key, version: d.version, label: d.label, description: d.description, entityType: d.entityType, observationKind: d.observationKind, unit: d.unit, valueType: d.valueType, aggregation: d.aggregation, active: d.active })),
    datasets: OBSERVATION_DATASETS.map((k) => {
      const ds = OBSERVATION_DATASET_DEFS[k];
      return { key: k, label: ds.label, description: ds.description, entityType: ds.entityType, kind: ds.kind, fields: fieldsFor(defs, ds.entityType, ds.kind, current).map((f) => f.key) };
    }),
    definitionSets: versions.map((v) => ({ version: v, label: `Definition set v${v}`, current: v === current })),
    semantic: availableInsightMetrics(ctx).map((m) => ({
      id: m.id,
      key: m.key,
      label: m.label,
      description: m.description,
      unit: m.unit,
      rate: !!m.rate,
      family: m.family,
      dimensions: m.dimensions,
      grains: m.grains,
      definitionVersion: m.definitionVersion ?? 1,
      additive: m.additive,
    })),
  };
};

export const metricFieldDefinition = async (ctx: QueryContext, id: string) => {
  if (!hasAnywhere(ctx.actor.access, 'metrics.read')) throw forbidden();
  const d = (await loadFieldDefinitions(ctx)).find((x) => x.id === id);
  if (!d) throw new AppError('NOT_FOUND', 'Metric definition was not found.');
  return { id: d.id, key: d.key, version: d.version, label: d.label, description: d.description, entityType: d.entityType, observationKind: d.observationKind, unit: d.unit, valueType: d.valueType, aggregation: d.aggregation, active: d.active };
};
