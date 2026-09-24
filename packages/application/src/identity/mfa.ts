import { Secret, TOTP } from 'otpauth';
import QRCode from 'qrcode';
import { randomBytes } from 'node:crypto';
import { sha256 } from '../core/crypto';

const PERIOD = 30;

export const newTotpSecret = (): string => new Secret({ size: 20 }).base32;

export const totpFor = (secretBase32: string, label: string) =>
  new TOTP({ issuer: 'Castlane CRM', label, algorithm: 'SHA1', digits: 6, period: PERIOD, secret: Secret.fromBase32(secretBase32) });

/**
 * Verify a TOTP code allowing ±1 step of clock drift. Returns the accepted time-step so the
 * caller can reject replays (a step at or before the last accepted one).
 */
export const verifyTotp = (secretBase32: string, code: string, at: Date): number | null => {
  const delta = totpFor(secretBase32, 'x').validate({ token: code.trim(), timestamp: at.getTime(), window: 1 });
  if (delta === null) return null;
  return Math.floor(at.getTime() / 1000 / PERIOD) + delta;
};

export const otpauthUrl = (secretBase32: string, email: string) => totpFor(secretBase32, email).toString();

export const qrSvg = (url: string): Promise<string> => QRCode.toString(url, { type: 'svg', margin: 1, width: 192, errorCorrectionLevel: 'M' });

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Recovery codes: 10 × "xxxxx-xxxxx", shown once, stored as hashes. */
export const generateRecoveryCodes = (count = 10): string[] =>
  Array.from({ length: count }, () => {
    const bytes = randomBytes(10);
    const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
    return `${chars.slice(0, 5)}-${chars.slice(5, 10)}`;
  });

export const normalizeRecoveryCode = (code: string) => code.trim().toLowerCase().replace(/\s+/g, '');
export const hashRecoveryCode = (code: string) => sha256(`recovery:${normalizeRecoveryCode(code)}`);
