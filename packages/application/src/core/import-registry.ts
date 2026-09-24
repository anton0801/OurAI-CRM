import type { DUPLICATE_POLICIES, EnumValue, IMPORT_DATASETS } from '@castlane/domain';
import type { CommandContext, QueryContext } from './context';

/**
 * Import Center datasets (spec §22.1). The platform module owns the engine (upload → parse →
 * mapping → validation report → preview → confirm → atomic commit → result/undo); each module
 * registers the dataset it owns. Datasets never auto-create hidden referenced entities, financial
 * datasets only create drafts / sale candidates.
 */
type DuplicatePolicy = EnumValue<typeof DUPLICATE_POLICIES>;
type ImportDatasetKey = EnumValue<typeof IMPORT_DATASETS>;

export type ImportColumnType =
  | 'text'
  | 'long_text'
  | 'integer'
  | 'decimal'
  | 'amount'
  | 'currency'
  | 'date'
  | 'datetime'
  | 'enum'
  | 'boolean'
  | 'email'
  | 'url'
  | 'timezone'
  | 'tags'
  /** Reference resolved by the dataset (stable id, or unambiguous name/handle). */
  | 'reference';

export interface ImportColumn {
  key: string;
  label: string;
  type: ImportColumnType;
  required?: boolean;
  enumValues?: readonly string[];
  /** Header names that auto-map to this column (case-insensitive). */
  aliases?: string[];
  description?: string;
}

export interface ImportIssue {
  field: string;
  code: string;
  message: string;
}

export interface ImportRowValidation<N> {
  action: 'create' | 'update' | 'skip';
  /** Normalised values the dataset will apply (JSON-serialisable; stored in import_rows.mapped). */
  normalized: N;
  errors: ImportIssue[];
  warnings: ImportIssue[];
  /** For updates: the target row and its version (re-checked at commit → Needs Revalidation). */
  targetId?: string;
  targetRowVersion?: number;
  /** Key used to detect duplicates within the same file. */
  dedupeKey?: string;
}

export interface ImportDatasetDefinition<N = Record<string, unknown>> {
  key: ImportDatasetKey;
  label: string;
  /** Permission needed to import (checked for the requester and per referenced scope). */
  permission: string;
  columns: ImportColumn[];
  duplicatePolicies: readonly DuplicatePolicy[];
  /** Values already parsed per column type (strings trimmed, numbers as decimal strings, dates ISO). */
  validate(
    ctx: QueryContext,
    row: Record<string, unknown>,
    opts: { duplicatePolicy: DuplicatePolicy; rowNo: number },
  ): Promise<ImportRowValidation<N>>;
  /** Apply one row inside the commit transaction. Must audit with source 'import'. Returns the entity id. */
  apply(ctx: CommandContext, row: N, v: { action: 'create' | 'update'; targetId?: string; targetRowVersion?: number }): Promise<string>;
  /** Undo Import: remove/void an unmodified record created by this job, or throw INVALID_STATE with details. */
  undo?(ctx: CommandContext, entityId: string): Promise<void>;
}

export const IMPORT_DATASETS_REGISTRY = new Map<string, ImportDatasetDefinition<any>>();

export const defineImportDataset = <N>(d: ImportDatasetDefinition<N>) => {
  IMPORT_DATASETS_REGISTRY.set(d.key, d);
};
