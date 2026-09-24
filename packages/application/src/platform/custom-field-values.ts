import { isDecimalString, isIsoDate, isSafeUrl, isUuid, LIMITS } from '@castlane/domain';

export type CustomFieldType =
  | 'short_text'
  | 'long_text'
  | 'number'
  | 'date'
  | 'datetime'
  | 'single_select'
  | 'multi_select'
  | 'checkbox'
  | 'url'
  | 'member_reference';

export interface FieldDef {
  type: CustomFieldType;
  options: { key: string; label: string; archivedAt?: string | null }[];
  precision: number | null;
  unit?: string | null;
}

export type ValueCheck = { ok: true; value: unknown } | { ok: false; message: string };

const ok = (value: unknown): ValueCheck => ({ ok: true, value });
const bad = (message: string): ValueCheck => ({ ok: false, message });

/** Empty means "no value": null, empty string, empty list. `false` is a real checkbox value. */
export const isEmptyValue = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * Validate and normalise a custom field value for its definition. Numbers are decimal strings
 * limited to the field precision (never floats); selects accept only active option keys.
 */
export const validateCustomFieldValue = (def: FieldDef, value: unknown): ValueCheck => {
  if (isEmptyValue(value)) return ok(null);
  const activeKeys = new Set(def.options.filter((o) => !o.archivedAt).map((o) => o.key));
  switch (def.type) {
    case 'short_text':
      if (typeof value !== 'string') return bad('Enter text.');
      if (value.trim().length > 500) return bad('Use at most 500 characters.');
      return ok(value.trim());
    case 'long_text':
      if (typeof value !== 'string') return bad('Enter text.');
      if (value.length > LIMITS.noteMax) return bad(`Use at most ${LIMITS.noteMax.toLocaleString('en-US')} characters.`);
      return ok(value);
    case 'number': {
      const s = typeof value === 'number' ? String(value) : value;
      if (typeof s !== 'string' || !isDecimalString(s)) return bad('Enter a number (use “.” as decimal separator).');
      const t = s.trim();
      const scale = t.includes('.') ? t.length - t.indexOf('.') - 1 : 0;
      if (def.precision !== null && scale > def.precision) return bad(`Use at most ${def.precision} decimal places.`);
      if (t.replace(/^-/, '').replace('.', '').length > 30) return bad('The number is too long.');
      return ok(t);
    }
    case 'date':
      return typeof value === 'string' && isIsoDate(value) ? ok(value) : bad('Enter a date (YYYY-MM-DD).');
    case 'datetime': {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return bad('Enter a date and time with its time zone offset.');
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? bad('Enter a valid date and time.') : ok(d.toISOString());
    }
    case 'single_select':
      return typeof value === 'string' && activeKeys.has(value) ? ok(value) : bad('Choose one of the available options.');
    case 'multi_select': {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) return bad('Choose options from the list.');
      const uniq = [...new Set(value as string[])];
      if (uniq.some((v) => !activeKeys.has(v))) return bad('Choose options from the list.');
      if (uniq.length > 50) return bad('Choose at most 50 options.');
      return ok(uniq);
    }
    case 'checkbox':
      return typeof value === 'boolean' ? ok(value) : bad('Choose yes or no.');
    case 'url':
      return typeof value === 'string' && isSafeUrl(value.trim()) ? ok(value.trim()) : bad('Enter a valid http(s) link.');
    case 'member_reference':
      return typeof value === 'string' && isUuid(value) ? ok(value) : bad('Choose a member.');
    default:
      return bad('Unsupported field type.');
  }
};

/** Human-readable value; archived options keep their historical label. */
export const displayCustomFieldValue = (def: FieldDef, value: unknown, memberName?: (id: string) => string | null): string | null => {
  if (isEmptyValue(value)) return null;
  const label = (k: string) => def.options.find((o) => o.key === k)?.label ?? k;
  switch (def.type) {
    case 'single_select':
      return label(String(value));
    case 'multi_select':
      return (value as string[]).map(label).join(', ');
    case 'checkbox':
      return value ? 'Yes' : 'No';
    case 'number':
      return def.unit ? `${String(value)} ${def.unit}` : String(value);
    case 'member_reference':
      return memberName?.(String(value)) ?? 'Unknown member';
    default:
      return String(value);
  }
};

/**
 * Convert an existing value to another field type for the replace-with-migration preview.
 * Returns undefined when the value cannot be converted without guessing.
 */
export const convertCustomFieldValue = (from: FieldDef, to: FieldDef, value: unknown): unknown | undefined => {
  if (isEmptyValue(value)) return null;
  const text =
    from.type === 'single_select'
      ? (from.options.find((o) => o.key === value)?.label ?? String(value))
      : from.type === 'multi_select'
        ? (value as string[]).map((k) => from.options.find((o) => o.key === k)?.label ?? k).join(', ')
        : from.type === 'checkbox'
          ? value
            ? 'true'
            : 'false'
          : String(value);
  const byLabel = (s: string) => to.options.find((o) => !o.archivedAt && (o.label.toLowerCase() === s.trim().toLowerCase() || o.key === s.trim()))?.key;
  let candidate: unknown;
  switch (to.type) {
    case 'short_text':
    case 'long_text':
    case 'url':
      candidate = text;
      break;
    case 'number':
    case 'date':
    case 'datetime':
    case 'member_reference':
      candidate = typeof text === 'string' ? text.trim() : text;
      break;
    case 'checkbox':
      candidate = ['true', 'yes', '1'].includes(String(text).toLowerCase()) ? true : ['false', 'no', '0'].includes(String(text).toLowerCase()) ? false : undefined;
      break;
    case 'single_select':
      candidate = byLabel(String(text));
      break;
    case 'multi_select': {
      const parts = String(text).split(',').map((p) => byLabel(p));
      candidate = parts.every(Boolean) ? parts : undefined;
      break;
    }
  }
  if (candidate === undefined) return undefined;
  const check = validateCustomFieldValue(to, candidate);
  return check.ok ? check.value : undefined;
};
