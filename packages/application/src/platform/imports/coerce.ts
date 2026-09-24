import { isEmail, isIsoDate, isSafeUrl, isSupportedCurrency, isValidTimeZone, normalizeEmail, zonedDateTimeToUtc } from '@castlane/domain';
import type { ImportColumn } from '../../core/import-registry';
import { MAX_CELL_LENGTH } from './parse';

export interface CoerceOptions {
  timezone: string;
  dateFormat: 'iso' | 'dd.mm.yyyy' | 'mm/dd/yyyy' | 'dd/mm/yyyy';
  decimalSeparator: '.' | ',';
}

export type Coerced = { ok: true; value: unknown } | { ok: false; code: string; message: string };

const ok = (value: unknown): Coerced => ({ ok: true, value });
const bad = (code: string, message: string): Coerced => ({ ok: false, code, message });

/**
 * Decimal numbers use only the explicitly chosen decimal separator. Grouping separators are never
 * guessed: "1,234" with "." as decimal separator is rejected instead of becoming 1234 or 1.234 (T149).
 */
export const parseDecimal = (raw: string, sep: '.' | ','): Coerced => {
  const v = raw.trim().replace(/^\+/, '');
  const other = sep === '.' ? ',' : '.';
  if (v.includes(other))
    return bad('AMBIGUOUS_NUMBER', `“${raw}” is ambiguous: use “${sep}” as the decimal separator and no thousands separators.`);
  if (/\s/.test(v)) return bad('AMBIGUOUS_NUMBER', `“${raw}” contains spaces; remove thousands separators.`);
  const re = sep === '.' ? /^-?\d+(\.\d+)?$/ : /^-?\d+(,\d+)?$/;
  if (!re.test(v)) return bad('INVALID_NUMBER', `“${raw}” is not a number.`);
  const canonical = sep === ',' ? v.replace(',', '.') : v;
  return ok(canonical.replace(/^(-?)0+(\d)/, '$1$2'));
};

const DATE_PATTERNS: Record<Exclude<CoerceOptions['dateFormat'], 'iso'>, { re: RegExp; order: ['d' | 'm' | 'y', 'd' | 'm' | 'y', 'd' | 'm' | 'y'] }> = {
  'dd.mm.yyyy': { re: /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/, order: ['d', 'm', 'y'] },
  'dd/mm/yyyy': { re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, order: ['d', 'm', 'y'] },
  'mm/dd/yyyy': { re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, order: ['m', 'd', 'y'] },
};

/** Calendar date in ISO or exactly the chosen format; anything else needs an explicit format choice. */
export const parseDate = (raw: string, format: CoerceOptions['dateFormat']): Coerced => {
  const v = raw.trim();
  const isoPart = /^(\d{4}-\d{2}-\d{2})(T00:00(:00(\.0+)?)?)?$/.exec(v);
  if (isoPart && isIsoDate(isoPart[1])) return ok(isoPart[1]);
  if (format !== 'iso') {
    const p = DATE_PATTERNS[format];
    const m = p.re.exec(v);
    if (m) {
      const parts: Record<string, string> = {};
      p.order.forEach((k, i) => (parts[k] = m[i + 1]!));
      const iso = `${parts.y}-${parts.m!.padStart(2, '0')}-${parts.d!.padStart(2, '0')}`;
      if (isIsoDate(iso)) return ok(iso);
      return bad('INVALID_DATE', `“${raw}” is not a valid calendar date.`);
    }
  }
  return bad('DATE_FORMAT', format === 'iso' ? `“${raw}” is not an ISO date (YYYY-MM-DD). Choose the date format used in the file.` : `“${raw}” does not match the chosen date format (${format}).`);
};

/** Moments: explicit offsets are kept; local wall times are interpreted in the chosen timezone. */
export const parseDateTime = (raw: string, opts: CoerceOptions): Coerced => {
  const v = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? bad('INVALID_DATETIME', `“${raw}” is not a valid date and time.`) : ok(d.toISOString());
  }
  const m = /^(.+?)[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(v);
  if (!m) return bad('DATETIME_FORMAT', `“${raw}” needs a date and a time (e.g. 2026-10-01 14:30).`);
  const date = parseDate(m[1]!, opts.dateFormat);
  if (!date.ok) return date;
  const h = Number(m[2]);
  const min = Number(m[3]);
  if (h > 23 || min > 59) return bad('INVALID_DATETIME', `“${raw}” has an invalid time.`);
  const r = zonedDateTimeToUtc(date.value as string, `${String(h).padStart(2, '0')}:${m[3]}`, opts.timezone);
  const withSeconds = m[4] ? new Date(r.utc.getTime() + Number(m[4]) * 1000) : r.utc;
  return ok(withSeconds.toISOString());
};

const enumKey = (v: string) => v.trim().toLowerCase().replace(/[\s-]+/g, '_');

/** Convert one raw cell to the column's type. Empty cells become null (required-ness is checked separately). */
export const coerceValue = (raw: string | undefined, col: ImportColumn, opts: CoerceOptions): Coerced => {
  const v = (raw ?? '').trim();
  if (v === '') return ok(null);
  if (v.length > MAX_CELL_LENGTH) return bad('TOO_LONG', `The value is longer than ${MAX_CELL_LENGTH.toLocaleString('en-US')} characters.`);
  switch (col.type) {
    case 'text':
    case 'reference':
      return ok(v);
    case 'long_text':
      return ok((raw ?? '').replace(/\r\n/g, '\n').trim());
    case 'integer': {
      const d = parseDecimal(v, opts.decimalSeparator);
      if (!d.ok) return d;
      if (!/^-?\d+$/.test(d.value as string)) return bad('INVALID_INTEGER', `“${raw}” must be a whole number.`);
      const n = Number(d.value);
      return Number.isSafeInteger(n) ? ok(n) : bad('INVALID_INTEGER', `“${raw}” is too large.`);
    }
    case 'decimal':
    case 'amount':
      return parseDecimal(v, opts.decimalSeparator);
    case 'currency': {
      const c = v.toUpperCase();
      return isSupportedCurrency(c) ? ok(c) : bad('INVALID_CURRENCY', `“${raw}” is not a supported ISO currency code.`);
    }
    case 'date':
      return parseDate(v, opts.dateFormat);
    case 'datetime':
      return parseDateTime(v, opts);
    case 'enum': {
      const k = enumKey(v);
      const values = col.enumValues ?? [];
      if (values.includes(k)) return ok(k);
      return bad('INVALID_VALUE', `“${raw}” is not allowed. Use one of: ${values.slice(0, 10).join(', ')}${values.length > 10 ? ', …' : ''}.`);
    }
    case 'boolean': {
      const k = v.toLowerCase();
      if (['true', 'yes', 'y', '1'].includes(k)) return ok(true);
      if (['false', 'no', 'n', '0'].includes(k)) return ok(false);
      return bad('INVALID_BOOLEAN', `“${raw}” must be yes/no or true/false.`);
    }
    case 'email':
      return isEmail(v) ? ok(normalizeEmail(v)) : bad('INVALID_EMAIL', `“${raw}” is not a valid e-mail address.`);
    case 'url':
      return isSafeUrl(v) ? ok(v) : bad('INVALID_URL', 'Enter a valid http(s) link.');
    case 'timezone':
      return isValidTimeZone(v) ? ok(v) : bad('INVALID_TIMEZONE', `“${raw}” is not an IANA time zone.`);
    case 'tags':
      return ok([...new Set(v.split(/[,|;]/).map((t) => t.trim()).filter(Boolean))]);
    default:
      return ok(v);
  }
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Proposed mapping column → header from keys, labels and aliases (case/punctuation-insensitive). */
export const suggestMapping = (columns: ImportColumn[], headers: string[]): Record<string, string | null> => {
  const byNorm = new Map(headers.map((h) => [norm(h), h]));
  const used = new Set<string>();
  const out: Record<string, string | null> = {};
  for (const c of columns) {
    const candidates = [c.key, c.label, ...(c.aliases ?? [])].map(norm);
    const hit = candidates.map((n) => byNorm.get(n)).find((h) => h && !used.has(h));
    out[c.key] = hit ?? null;
    if (hit) used.add(hit);
  }
  return out;
};
