import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import { AppError } from '@castlane/domain';

export const MAX_IMPORT_ROWS = 20_000;
export const MAX_IMPORT_COLUMNS = 200;
export const MAX_CELL_LENGTH = 10_000;

/** Reserved staging keys (never valid header names) that carry XLSX formula markers per row. */
export const FORMULA_KEY = '\u0001formulas';
export const NO_CACHE_KEY = '\u0001nocache';

export interface ParsedCell {
  value: string;
  /** The cell holds a formula; `value` is the cached result stored in the file (never evaluated). */
  formula?: boolean;
  /** Formula without a stored result. */
  noCachedValue?: boolean;
}

export interface ParsedSheet {
  headers: string[];
  rows: ParsedCell[][];
  delimiter: ',' | ';' | null;
  warnings: string[];
}

const fail = (message: string) => new AppError('VALIDATION_FAILED', message);

/** Decode strict UTF-8 (BOM allowed and removed); anything else is rejected, never guessed. */
export const decodeUtf8 = (buf: Buffer): string => {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw fail('The file is not UTF-8 encoded. Save it as “CSV UTF-8” and upload it again.');
  }
  if (text.includes('\u0000')) throw fail('The file contains binary data and is not a CSV file.');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
};

/**
 * Detect comma vs semicolon from the header line (quoted sections ignored). The detected delimiter
 * is shown in the preview and can be overridden explicitly.
 */
export const detectDelimiter = (text: string): ',' | ';' => {
  let commas = 0;
  let semis = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') i++;
      else quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (ch === '\n' || ch === '\r') break;
    if (ch === ',') commas++;
    else if (ch === ';') semis++;
  }
  return semis > commas ? ';' : ',';
};

/** Header names: trimmed, unique (duplicates numbered), blanks named by position, control characters removed. */
export const normalizeHeaders = (raw: string[]): string[] => {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    let name = h.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200) || `Column ${i + 1}`;
    const key = name.toLowerCase();
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    if (n > 0) name = `${name} (${n + 1})`;
    return name;
  });
};

const isBlankRow = (cells: ParsedCell[]) => cells.every((c) => c.value.trim() === '' && !c.formula);

const finish = (headersRaw: string[], body: ParsedCell[][], delimiter: ',' | ';' | null, warnings: string[]): ParsedSheet => {
  if (headersRaw.length === 0 || headersRaw.every((h) => !h.trim())) throw fail('The file has no header row. The first row must contain column names.');
  if (headersRaw.length > MAX_IMPORT_COLUMNS) throw fail(`The file has ${headersRaw.length} columns; at most ${MAX_IMPORT_COLUMNS} are supported.`);
  const headers = normalizeHeaders(headersRaw);
  const rows = body.filter((r) => !isBlankRow(r));
  if (rows.length === 0) throw fail('The file has a header row but no data rows.');
  if (rows.length > MAX_IMPORT_ROWS)
    throw fail(`The file has ${rows.length.toLocaleString('en-US')} rows; the limit is ${MAX_IMPORT_ROWS.toLocaleString('en-US')} rows per import. Split the file and import the parts separately.`);
  return { headers, rows: rows.map((r) => headers.map((_, i) => r[i] ?? { value: '' })), delimiter, warnings };
};

/** Parse CSV text (RFC 4180 quoting, CRLF/LF, embedded newlines) with the given or detected delimiter. */
export const parseCsv = (buf: Buffer, forcedDelimiter?: ',' | ';'): ParsedSheet => {
  const text = decodeUtf8(buf);
  const delimiter = forcedDelimiter ?? detectDelimiter(text);
  const res = Papa.parse<string[]>(text, { delimiter, skipEmptyLines: false, quoteChar: '"', escapeChar: '"' });
  const warnings: string[] = [];
  const quoteErrors = res.errors.filter((e) => e.type === 'Quotes');
  if (quoteErrors.length) throw fail(`The CSV file has unbalanced quotes near row ${(quoteErrors[0]!.row ?? 0) + 1}. Fix the file and upload it again.`);
  const data = res.data;
  const [header = [], ...body] = data;
  const widths = new Set(body.filter((r) => r.some((v) => v.trim() !== '')).map((r) => r.length));
  if (widths.size > 1 || (widths.size === 1 && !widths.has(header.length)))
    warnings.push('Some rows have a different number of columns than the header. Missing cells are treated as empty; extra cells are ignored.');
  return finish(
    header,
    body.map((r) => r.map((v) => ({ value: v }))),
    delimiter,
    warnings,
  );
};

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Excel serial dates arrive as JS Dates in "UTC" wall time; keep the wall time without inventing a zone. */
const dateToText = (d: Date): string => {
  const hasTime = d.getUTCHours() + d.getUTCMinutes() + d.getUTCSeconds() + d.getUTCMilliseconds() !== 0;
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return hasTime ? `${date}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` : date;
};

const scalarText = (v: unknown): string | null => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return dateToText(v);
  if (typeof v === 'object') {
    const o = v as { richText?: { text: string }[]; text?: unknown; error?: string };
    if (Array.isArray(o.richText)) return o.richText.map((t) => t.text).join('');
    if (o.error !== undefined) return null;
    if (o.text !== undefined) return scalarText(o.text);
  }
  return '';
};

/** Read one XLSX cell: literal values as-is, formula cells only through their cached result. */
export const xlsxCell = (value: ExcelJS.CellValue): ParsedCell => {
  if (value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) {
    const result = (value as { result?: unknown }).result;
    if (result === undefined || result === null) return { value: '', formula: true, noCachedValue: true };
    const text = scalarText(result);
    return text === null ? { value: '', formula: true, noCachedValue: true } : { value: text, formula: true };
  }
  const text = scalarText(value);
  return { value: text ?? '' };
};

/**
 * Parse the first worksheet of an XLSX workbook. Nothing is executed: formulas are never evaluated
 * (only cached results are read and flagged), macro-enabled content is rejected and external links
 * are ignored (T152).
 */
export const parseXlsx = async (buf: Buffer): Promise<ParsedSheet> => {
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw fail('The file is not a valid XLSX workbook.');
  const latin = buf.toString('latin1');
  if (latin.includes('vbaProject.bin')) throw fail('Macro-enabled workbooks are not accepted. Save the workbook as .xlsx without macros.');
  const warnings: string[] = [];
  if (latin.includes('xl/externalLinks/')) warnings.push('The workbook contains links to external workbooks. They were ignored; only stored values were read.');
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw fail('The workbook could not be read. Save it again as .xlsx and upload it.');
  }
  const ws = wb.worksheets.find((w) => w.actualRowCount > 0) ?? wb.worksheets[0];
  if (!ws) throw fail('The workbook has no worksheets.');
  if (wb.worksheets.filter((w) => w.actualRowCount > 0).length > 1) warnings.push(`Only the first worksheet (“${ws.name}”) was read.`);
  if (ws.rowCount > MAX_IMPORT_ROWS + 1 && ws.actualRowCount > MAX_IMPORT_ROWS + 1)
    throw fail(`The worksheet has more than ${MAX_IMPORT_ROWS.toLocaleString('en-US')} rows; split the file and import the parts separately.`);
  const width = Math.min(ws.columnCount, MAX_IMPORT_COLUMNS + 1);
  const readRow = (n: number): ParsedCell[] => {
    const row = ws.getRow(n);
    const out: ParsedCell[] = [];
    for (let c = 1; c <= width; c++) out.push(xlsxCell(row.getCell(c).value));
    return out;
  };
  const header = readRow(1).map((c) => c.value);
  while (header.length && !header[header.length - 1]!.trim()) header.pop();
  const body: ParsedCell[][] = [];
  for (let r = 2; r <= ws.rowCount; r++) body.push(readRow(r).slice(0, header.length));
  return finish(header, body, null, warnings);
};

export const parseImportFile = async (buf: Buffer, kind: 'csv' | 'xlsx', forcedDelimiter?: ',' | ';') =>
  kind === 'csv' ? parseCsv(buf, forcedDelimiter) : parseXlsx(buf);

/** Staging representation of a row: raw strings by header plus formula markers. */
export const toStagedRaw = (headers: string[], cells: ParsedCell[]): Record<string, string> => {
  const raw: Record<string, string> = {};
  const formulas: string[] = [];
  const noCache: string[] = [];
  headers.forEach((h, i) => {
    const c = cells[i] ?? { value: '' };
    raw[h] = c.value;
    if (c.formula) formulas.push(h);
    if (c.noCachedValue) noCache.push(h);
  });
  if (formulas.length) raw[FORMULA_KEY] = JSON.stringify(formulas);
  if (noCache.length) raw[NO_CACHE_KEY] = JSON.stringify(noCache);
  return raw;
};

export const formulaHeaders = (raw: Record<string, string>) => ({
  formulas: new Set<string>(raw[FORMULA_KEY] ? (JSON.parse(raw[FORMULA_KEY]) as string[]) : []),
  noCache: new Set<string>(raw[NO_CACHE_KEY] ? (JSON.parse(raw[NO_CACHE_KEY]) as string[]) : []),
});

/** Visible raw values (without internal markers). */
export const visibleRaw = (raw: Record<string, string>) =>
  Object.fromEntries(Object.entries(raw).filter(([k]) => k !== FORMULA_KEY && k !== NO_CACHE_KEY));
