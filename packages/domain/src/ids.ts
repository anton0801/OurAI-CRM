// Browser-safe: relies on the Web Crypto API available in Node 22 and modern browsers.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const newId = (): string => globalThis.crypto.randomUUID();
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID_RE.test(value);
