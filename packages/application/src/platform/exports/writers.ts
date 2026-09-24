import { createWriteStream, type WriteStream } from 'node:fs';
import ExcelJS from 'exceljs';
import { neutralizeSpreadsheetText } from '@castlane/domain';
import type { ExportColumn } from '../../core/export-registry';

export type CellValue = string | number | boolean | null;
type ColumnType = ExportColumn['type'];

const NUMERIC_TYPES: ReadonlySet<ColumnType> = new Set(['integer', 'decimal', 'amount']);
const NUMERIC_RE = /^-?\d+(\.\d+)?$/;

/**
 * Normalise one cell for a spreadsheet (section 22.2): typed numeric columns keep real numbers
 * (including negatives), while untrusted text that starts with =, +, -, @, tab or CR is prefixed
 * so spreadsheet software shows it as text instead of evaluating it (T151).
 */
export const safeCell = (value: CellValue | undefined, type: ColumnType): CellValue => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (NUMERIC_TYPES.has(type) && NUMERIC_RE.test(value.trim())) return value.trim();
  return neutralizeSpreadsheetText(value);
};

/** RFC 4180 field quoting. */
export const csvField = (v: CellValue): string => {
  if (v === null) return '';
  const s = typeof v === 'string' ? v : String(v);
  return /[",\r\n;]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
};

export const csvLine = (values: CellValue[]): string => `${values.map(csvField).join(',')}\r\n`;

export interface SheetWriter {
  writeRow(values: CellValue[]): Promise<void>;
  finish(): Promise<void>;
  abort(): Promise<void>;
}

const drain = (s: WriteStream) => new Promise<void>((r) => s.once('drain', () => r()));

/** Streaming CSV writer (UTF-8 with BOM so spreadsheet software detects the encoding). */
export const createCsvWriter = (path: string, header: string[]): SheetWriter => {
  const out = createWriteStream(path, { mode: 0o600 });
  let failed: Error | null = null;
  out.on('error', (e) => (failed = e));
  const write = async (chunk: string) => {
    if (failed) throw failed;
    if (!out.write(chunk)) await drain(out);
  };
  let started = false;
  return {
    async writeRow(values) {
      if (!started) {
        started = true;
        await write(`﻿${csvLine(header.map((h) => neutralizeSpreadsheetText(h)))}`);
      }
      await write(csvLine(values));
    },
    async finish() {
      if (!started) await write(`﻿${csvLine(header.map((h) => neutralizeSpreadsheetText(h)))}`);
      await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
      if (failed) throw failed;
    },
    async abort() {
      out.destroy();
    },
  };
};

const toXlsxValue = (v: CellValue, type: ColumnType): ExcelJS.CellValue => {
  if (v === null) return null;
  if (typeof v === 'boolean' || typeof v === 'number') return v;
  // Exact decimals stay exact: numbers only when they survive the float round-trip.
  if (NUMERIC_TYPES.has(type) && NUMERIC_RE.test(v)) {
    const n = Number(v);
    const digits = v.replace(/^-/, '').replace('.', '').replace(/^0+/, '').length;
    return Number.isFinite(n) && digits <= 15 ? n : v;
  }
  return v;
};

/**
 * Streaming XLSX writer. Values are written as plain cells — never formulas; text cells are already
 * neutralised by `safeCell`.
 */
export const createXlsxWriter = (path: string, header: string[], types: ColumnType[], sheetName = 'Export'): SheetWriter => {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: path, useStyles: false, useSharedStrings: false });
  const ws = wb.addWorksheet(sheetName.slice(0, 31));
  ws.addRow(header.map((h) => neutralizeSpreadsheetText(h))).commit();
  return {
    async writeRow(values) {
      ws.addRow(values.map((v, i) => toXlsxValue(v, types[i] ?? 'text'))).commit();
    },
    async finish() {
      ws.commit();
      await wb.commit();
    },
    async abort() {
      try {
        ws.commit();
        await wb.commit();
      } catch {
        /* the partial file is removed by the caller */
      }
    },
  };
};
