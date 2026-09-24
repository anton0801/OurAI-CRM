import { getDatabase } from '@castlane/database';
import { systemClock, type Clock } from '@castlane/domain';
import { ClamdScanner, DevBypassScanner, FilesystemStorage, S3Storage, type MalwareScanner, type StorageAdapter } from '@castlane/storage';
import { loadConfig, type AppConfig } from './config';
import type { AppServices, Logger } from './context';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

/** Structured JSON logger. Callers must never pass secrets, raw contact notes or signed URLs. */
export const createLogger = (level: keyof typeof LEVELS = 'info', base: Record<string, unknown> = {}): Logger => {
  const min = LEVELS[level];
  const write = (lvl: keyof typeof LEVELS, msg: string, meta?: Record<string, unknown>) => {
    if (LEVELS[lvl] < min) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...base, ...meta });
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
