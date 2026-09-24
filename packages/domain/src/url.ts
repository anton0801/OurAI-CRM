import type { EnumValue } from './enums';
import { PLATFORMS } from './enums';
import { LIMITS } from './text';

export type Platform = EnumValue<typeof PLATFORMS>;

/**
 * Only http(s) URLs are ever stored for user-entered links; javascript:, data:, file: and
 * app-internal schemes are rejected. Returns the parsed URL or null.
 */
export const parseSafeUrl = (raw: string, opts: { httpsOnly?: boolean } = {}): URL | null => {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > LIMITS.urlMax) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (opts.httpsOnly ? url.protocol !== 'https:' : url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!url.hostname || url.username || url.password) return null;
  return url;
};

export const isSafeUrl = (raw: string, opts?: { httpsOnly?: boolean }): boolean => parseSafeUrl(raw, opts) !== null;

const PLATFORM_HOSTS: Record<Exclude<Platform, 'other'>, string[]> = {
  instagram: ['instagram.com'],
  tiktok: ['tiktok.com'],
  youtube: ['youtube.com', 'youtu.be'],
  x: ['x.com', 'twitter.com'],
  onlyfans: ['onlyfans.com'],
  fansly: ['fansly.com'],
};

/** Hosts whose profile paths are case-insensitive, so the path may be lower-cased for identity. */
const CASE_INSENSITIVE_PATH_PLATFORMS: Platform[] = ['instagram', 'tiktok', 'x', 'onlyfans', 'fansly', 'youtube'];

const TRACKING_PARAMS = /^(utm_[a-z]+|igsh|igshid|si|fbclid|gclid|ref|ref_src|_t|_r|is_from_webapp|sender_device|feature)$/i;

export interface NormalizedProfileUrl {
  canonicalUrl: string;
  /** Identity key used for duplicate detection: platform + host + normalized path. */
  identityKey: string;
  handle: string | null;
  host: string;
}

export type ProfileUrlError = 'INVALID_URL' | 'HTTPS_REQUIRED' | 'HOST_MISMATCH';

/**
 * Normalize an external profile URL for identity comparison. The original URL is stored
 * separately; this never fetches anything over the network.
 */
export const normalizeProfileUrl = (
  raw: string,
  platform: Platform,
): { ok: true; value: NormalizedProfileUrl } | { ok: false; error: ProfileUrlError } => {
  const url = parseSafeUrl(raw);
  if (!url) return { ok: false, error: 'INVALID_URL' };
  if (url.protocol !== 'https:') return { ok: false, error: 'HTTPS_REQUIRED' };
  let host = url.hostname.toLowerCase().replace(/\.$/, '');
  host = host.replace(/^(www\.|m\.|mobile\.)/, '');
  if (platform !== 'other') {
    const allowed = PLATFORM_HOSTS[platform];
    if (!allowed.some((h) => host === h || host.endsWith(`.${h}`))) return { ok: false, error: 'HOST_MISMATCH' };
    if (platform === 'x' && host === 'twitter.com') host = 'x.com';
  }
  const kept = [...url.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k));
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  let path = url.pathname.replace(/\/+$/, '') || '/';
  path = path.replace(/\/{2,}/g, '/');
  const identityPath = CASE_INSENSITIVE_PATH_PLATFORMS.includes(platform) ? path.toLowerCase() : path;
  const query = platform === 'youtube' ? kept.filter(([k]) => k === 'channel' || k === 'c').map(([k, v]) => `${k}=${v}`).join('&') : '';
  const canonicalUrl = `https://${host}${path}${query ? `?${query}` : ''}`;
  let handle: string | null = null;
  if (platform !== 'other') {
    const first = path.split('/').filter(Boolean)[0] ?? null;
    handle = first ? decodeURIComponent(first).replace(/^@/, '') : null;
  }
  return {
    ok: true,
    value: { canonicalUrl, identityKey: `${platform}|${host}${identityPath}${query ? `?${query}` : ''}`, handle, host },
  };
};

/** Normalize a published post URL for uniqueness per account. */
export const normalizePostUrl = (raw: string): string | null => {
  const url = parseSafeUrl(raw, { httpsOnly: true });
  if (!url) return null;
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
  const kept = [...url.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k));
  kept.sort(([a], [b]) => (a < b ? -1 : 1));
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const q = kept.map(([k, v]) => `${k}=${v}`).join('&');
  return `https://${host}${path}${q ? `?${q}` : ''}`;
};

/** Build a tagged (UTM) URL. Existing parameters are preserved; conflicts are reported, not overwritten. */
export const buildTaggedUrl = (
  destination: string,
  params: Partial<Record<'utm_source' | 'utm_medium' | 'utm_campaign' | 'utm_content' | 'utm_term', string>>,
  opts: { overwrite?: boolean } = {},
): { url: string; conflicts: string[] } | null => {
  const url = parseSafeUrl(destination, { httpsOnly: true });
  if (!url) return null;
  const conflicts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (!v) continue;
    const existing = url.searchParams.get(k);
    if (existing !== null && existing !== v) {
      conflicts.push(k);
      if (!opts.overwrite) continue;
    }
    url.searchParams.set(k, v);
  }
  return { url: url.toString(), conflicts };
};
