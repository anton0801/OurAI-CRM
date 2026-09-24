/** Shared text limits (section 8.1). Truncation without warning is forbidden: validate instead. */
export const LIMITS = {
  shortNameMin: 2,
  shortNameMax: 120,
  taskTitleMin: 3,
  taskTitleMax: 200,
  handleMax: 100,
  urlMax: 2048,
  noteMax: 10_000,
  richTextMax: 200_000,
  tagsPerObject: 30,
  tagMin: 2,
  tagMax: 40,
  displayNameMin: 2,
  displayNameMax: 80,
  commentMax: 5_000,
  reasonMin: 3,
  reasonMax: 2_000,
  noUrlReasonMin: 10,
  noUrlReasonMax: 500,
  passwordMin: 12,
  passwordMax: 128,
} as const;

/** Unicode-aware normalisation for case-insensitive uniqueness (names, tags). */
export const normalizeKey = (value: string): string => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');

export const normalizeTag = (value: string): string => value.normalize('NFKC').trim().replace(/\s+/g, ' ');

export const normalizeEmail = (value: string): string => value.normalize('NFKC').trim().toLowerCase();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isEmail = (value: string): boolean => value.length <= 254 && EMAIL_RE.test(value);

/** Values that spreadsheet software could interpret as formulas (CSV/XLSX injection guard). */
export const neutralizeSpreadsheetText = (value: string): string =>
  /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
