import { getDatabase } from '@castlane/database';
import { systemClock, type Clock } from '@castlane/domain';
import { ClamdScanner, DevBypassScanner, FilesystemStorage, S3Storage, type MalwareScanner, type StorageAdapter } from '@castlane/storage';
import { loadConfig, type AppConfig } from './config';
import type { AppServices, Logger } from './context';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

/** Structured JSON logger. Callers must never pass secrets, raw contact notes or signed URLs. */
/** Keys whose values never reach logs (T171): credentials, MFA, tokens, signed URLs, private notes. */
const SENSITIVE_KEY = /pass(word|phrase)?|secret|token|otp|totp|recovery|cookie|authorization|signature|signed|credential|private|notes?$|^body$|excerpt|^code$|^(mfa|totp|recovery)Code$/i;
const SIGNED_QUERY = /([?&](?:sig|signature|token|x-amz-signature|x-amz-credential|x-amz-security-token)=)[^&\s"]+/gi;

/** Redact sensitive fields recursively and strip signatures from URLs in string values. */
export const redactForLog = (value: unknown, depth = 0): unknown => {
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') return value.replace(SIGNED_QUERY, '$1[redacted]');
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactForLog(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redactForLog(value.message, depth + 1) };
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redactForLog(v, depth + 1);
    return out;
  }
  return value;
};

export const createLogger = (level: keyof typeof LEVELS = 'info', base: Record<string, unknown> = {}): Logger => {
  const min = LEVELS[level];
  const write = (lvl: keyof typeof LEVELS, msg: string, meta?: Record<string, unknown>) => {
    if (LEVELS[lvl] < min) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...base, ...(meta ? (redactForLog(meta) as Record<string, unknown>) : {}) });
    if (lvl === 'error' || lvl === 'warn') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };
  return {
    debug: (m, meta) => write('debug', m, meta),
    info: (m, meta) => write('info', m, meta),
    warn: (m, meta) => write('warn', m, meta),
    error: (m, meta) => write('error', m, meta),
  };
};

export const createStorage = (cfg: AppConfig): StorageAdapter =>
  cfg.STORAGE_DRIVER === 's3'
    ? new S3Storage({
        endpoint: cfg.STORAGE_ENDPOINT,
        region: cfg.STORAGE_REGION,
        bucket: cfg.STORAGE_BUCKET_PRIVATE,
        accessKeyId: cfg.STORAGE_ACCESS_KEY_ID ?? '',
        secretAccessKey: cfg.STORAGE_SECRET_ACCESS_KEY ?? '',
        forcePathStyle: cfg.STORAGE_FORCE_PATH_STYLE,
      })
    : new FilesystemStorage(cfg.STORAGE_FS_ROOT, cfg.SESSION_SECRET, cfg.APP_ORIGIN);

export const createScanner = (cfg: AppConfig): MalwareScanner =>
  cfg.SCANNER_MODE === 'clamd' ? new ClamdScanner(cfg.CLAMD_HOST ?? '127.0.0.1', cfg.CLAMD_PORT) : new DevBypassScanner();

let services: AppServices | undefined;

export const getAppServices = (overrides: Partial<AppServices> = {}): AppServices => {
  if (!services) {
    const config = loadConfig();
    services = {
      db: getDatabase().db,
      clock: systemClock,
      config,
      storage: createStorage(config),
      scanner: createScanner(config),
      logger: createLogger(config.LOG_LEVEL, { process: process.env.CASTLANE_PROCESS ?? 'app' }),
    };
  }
  return { ...services, ...overrides };
};

export const setAppServices = (s: AppServices | undefined, clock?: Clock) => {
  services = s && clock ? { ...s, clock } : s;
};
