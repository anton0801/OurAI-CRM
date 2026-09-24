import type { QueryContext } from './context';

/**
 * Export Center datasets (spec §22.2): CSV/XLSX of permitted raw records. The platform module
 * owns jobs, files (TTL 7 days), spreadsheet-injection neutralisation and short-lived downloads;
 * modules register datasets. PDF reports (report builder) and ZIP content packages are produced by
 * their modules through the same export job table with their own dataset keys.
 */
export interface ExportColumn {
  key: string;
  label: string;
  type: 'text' | 'integer' | 'decimal' | 'amount' | 'currency' | 'date' | 'datetime' | 'boolean' | 'id';
  /** Column included only when the requester holds this permission (e.g. finance amounts). */
  permission?: string;
  /** Column is selected by default. */
  default?: boolean;
}

export interface ExportDatasetDefinition {
  key: string;
  label: string;
  /** Permission needed to export (in addition to the read scope applied in `rows`). */
  permission: string;
  classification: 'normal' | 'private' | 'finance' | 'ofm';
  columns: ExportColumn[];
  /** Describes accepted filters for the UI (keys are the same as the module list filters). */
  filters?: { key: string; label: string; type: 'text' | 'enum' | 'date' | 'reference'; enumValues?: readonly string[]; lookup?: string }[];
  /**
   * Yield rows visible to the requester as of `boundAt` (records created later are excluded),
   * in stable order, in pages. Values: strings/numbers/booleans/null only.
   */
  rows(ctx: QueryContext, input: { filters: Record<string, unknown>; boundAt: Date; fields: string[] }): AsyncIterable<Record<string, string | number | boolean | null>>;
}

export const EXPORT_DATASETS_REGISTRY = new Map<string, ExportDatasetDefinition>();

export const defineExportDataset = (d: ExportDatasetDefinition) => {
  EXPORT_DATASETS_REGISTRY.set(d.key, d);
};
