import { z } from 'zod';

/**
 * Runtime configuration schema shared by web and worker. Production refuses to start when a
 * required setting is missing; development gets explicit local defaults (never secrets for prod).
 */
const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ORIGIN: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  MFA_ENCRYPTION_KEY: z.string().min(32),
  /** Encrypts secrets entered in the UI (SMTP password). Defaults to MFA_ENCRYPTION_KEY when unset. */
  SECRETS_ENCRYPTION_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(32).optional()),
  PASSWORD_PEPPER: z.string().optional(),
  STORAGE_DRIVER: z.enum(['s3', 'filesystem']).default('filesystem'),
  STORAGE_ENDPOINT: z.string().optional(),
  STORAGE_REGION: z.string().default('us-east-1'),
  STORAGE_BUCKET_PRIVATE: z.string().default('castlane-private'),
  STORAGE_ACCESS_KEY_ID: z.string().optional(),
  STORAGE_SECRET_ACCESS_KEY: z.string().optional(),
  STORAGE_FORCE_PATH_STYLE: bool,
  STORAGE_FS_ROOT: z.string().default('./var/storage'),
  SCANNER_MODE: z.enum(['clamd', 'disabled-dev-only']).default('disabled-dev-only'),
  CLAMD_HOST: z.string().optional(),
  CLAMD_PORT: z.coerce.number().default(3310),
  FFPROBE_PATH: z.string().optional(),
  FFMPEG_PATH: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USERNAME: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().default('Castlane <no-reply@castlane.invalid>'),
  SMTP_SECURE: bool,
  MAIL_TRANSPORT: z.enum(['smtp', 'dev_sink']).default('dev_sink'),
  JOB_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  MEDIA_JOB_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
  MAX_UPLOAD_BYTES: z.coerce.number().int().default(5 * 1024 * 1024 * 1024),
  BACKUP_STATUS_ENDPOINT_INTERNAL: z.string().optional(),
  TRUST_PROXY: bool,
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type AppConfig = z.infer<typeof schema> & { isProduction: boolean };

const DEV_DEFAULTS: Record<string, string> = {
  DATABASE_URL: 'postgres://castlane:castlane@127.0.0.1:5432/castlane_dev',
  SESSION_SECRET: 'dev-only-session-secret-change-me-0123456789',
  MFA_ENCRYPTION_KEY: 'dev-only-mfa-encryption-key-change-me-0123456789',
};

let cached: AppConfig | undefined;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => {
  if (cached && env === process.env) return cached;
  const isProduction = env.NODE_ENV === 'production';
  const source: Record<string, string | undefined> = { ...env };
  if (!isProduction) for (const [k, v] of Object.entries(DEV_DEFAULTS)) if (!source[k]) source[k] = v;
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const cfg = { ...parsed.data, isProduction } as AppConfig;
  if (isProduction) {
    const problems: string[] = [];
    if (cfg.SCANNER_MODE !== 'clamd') problems.push('SCANNER_MODE must be clamd in production');
    if (cfg.MAIL_TRANSPORT !== 'smtp') problems.push('MAIL_TRANSPORT must be smtp in production');
    if (cfg.STORAGE_DRIVER === 's3' && (!cfg.STORAGE_ACCESS_KEY_ID || !cfg.STORAGE_SECRET_ACCESS_KEY))
      problems.push('S3 credentials are required');
    if (!cfg.APP_ORIGIN.startsWith('https://')) problems.push('APP_ORIGIN must be https in production');
    // The SMTP server may come from the environment or be entered in Workspace Settings (S67).
    if (Object.values(DEV_DEFAULTS).includes(cfg.SESSION_SECRET) || Object.values(DEV_DEFAULTS).includes(cfg.MFA_ENCRYPTION_KEY) || (cfg.SECRETS_ENCRYPTION_KEY && Object.values(DEV_DEFAULTS).includes(cfg.SECRETS_ENCRYPTION_KEY)))
      problems.push('development secrets must not be used in production');
    if (problems.length) throw new Error(`Production configuration invalid: ${problems.join('; ')}`);
  }
  if (env === process.env) cached = cfg;
  return cfg;
};

export const resetConfigCache = () => {
  cached = undefined;
};

/** Key for secrets entered through the UI (never the session secret). */
export const secretsKey = (cfg: AppConfig) => cfg.SECRETS_ENCRYPTION_KEY ?? cfg.MFA_ENCRYPTION_KEY;
