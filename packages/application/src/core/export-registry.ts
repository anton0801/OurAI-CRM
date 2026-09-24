import type { CommandContext, QueryContext } from './context';

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

/**
 * Module-produced exports (ZIP content packages) share the export job table, the Export Center
 * list, downloads and retention; the module names them and queues its own generation job again on
 * Retry Failed.
 */
export interface ExportProducerDefinition {
  key: string;
  label: string;
  /** Permissions the requester must still hold to download the file (in addition to exports.download). */
  downloadPermissions: string[];
  /**
   * Retry Failed: re-check that the request is still allowed (throw otherwise; the transaction rolls
   * back) and enqueue generation for the already re-queued row. Returns the job id (null when already queued).
   */
  requeue(ctx: CommandContext, row: { id: string; filters: unknown; rowVersion: number }): Promise<string | null>;
}

export const EXPORT_PRODUCERS = new Map<string, ExportProducerDefinition>();

export const defineExportProducer = (d: ExportProducerDefinition) => {
  EXPORT_PRODUCERS.set(d.key, d);
};
