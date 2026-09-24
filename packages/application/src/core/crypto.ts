import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export const hmac = (secret: string, value: string): string => createHmac('sha256', secret).update(value).digest('base64url');

export const safeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

const keyFrom = (secret: string) => createHash('sha256').update(secret).digest();

/** AES-256-GCM envelope: v1.<iv>.<tag>.<ciphertext> (base64url). Used for TOTP secrets. */
export const encryptSecret = (plaintext: string, secret: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
};

export const decryptSecret = (envelope: string, secret: string): string => {
  const [v, iv, tag, ct] = envelope.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unsupported secret envelope');
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
};

/** Stable hash of a request payload for idempotency comparison (key order independent). */
export const stableHash = (value: unknown): string => sha256(stableStringify(value));

export const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
};
