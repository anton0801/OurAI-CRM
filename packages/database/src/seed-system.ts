import { createHash } from 'node:crypto';
import type pg from 'pg';
import { METRIC_CATALOG } from './metric-catalog';

/** Deterministic UUID from a name (namespace-hashed), so seeds are idempotent across environments. */
export const deterministicUuid = (name: string): string => {
  const h = createHash('sha256').update(`castlane:${name}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export const seedSystemCatalog = async (client: pg.PoolClient | pg.Client): Promise<void> => {
  for (const m of METRIC_CATALOG) {
    await client.query(
      `INSERT INTO metric_definitions (id, key, version, label, description, entity_type, observation_kind, unit, value_type, aggregation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (key, version) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description`,
      [
        deterministicUuid(`metric:${m.key}:${m.version}`),
        m.key,
        m.version,
        m.label,
        m.description,
        m.entityType,
        m.observationKind,
        m.unit,
        m.valueType,
        m.aggregation,
      ],
    );
  }
};
