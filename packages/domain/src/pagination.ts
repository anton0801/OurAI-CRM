/** Opaque cursor pagination (stable sort key + id). */
export interface CursorPayload {
  /** Sort values of the last row, in sort order. */
  v: (string | number | null)[];
  id: string;
}

const toBase64Url = (s: string): string => {
  const b64 = typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(s))) : Buffer.from(s, 'utf8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromBase64Url = (s: string): string => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return typeof atob === 'function' ? decodeURIComponent(escape(atob(b64))) : Buffer.from(b64, 'base64').toString('utf8');
};

export const encodeCursor = (payload: CursorPayload): string => toBase64Url(JSON.stringify(payload));
export const decodeCursor = (cursor: string): CursorPayload | null => {
  try {
    const parsed = JSON.parse(fromBase64Url(cursor)) as CursorPayload;
    if (!parsed || typeof parsed.id !== 'string' || !Array.isArray(parsed.v)) return null;
    return parsed;
  } catch {
    return null;
  }
};

export const PAGE_SIZE_DEFAULT = 50;
export const PAGE_SIZE_MAX = 200;
export const clampPageSize = (n: number | undefined): number =>
  Math.min(PAGE_SIZE_MAX, Math.max(1, Math.floor(n ?? PAGE_SIZE_DEFAULT)));
