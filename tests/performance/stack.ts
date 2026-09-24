/**
 * Local server stack for a load measurement: the production build of the web app (the Next.js
 * standalone server, started exactly like infra/docker/web.Dockerfile) plus the worker, both with
 * NODE_ENV=production against the synthetic load database.
 *
 *   NEXT_DIST_DIR=.next-perf pnpm --filter @castlane/web build     # once
 *   pnpm perf:stack [--database-url postgres://…/castlane_perf] [--port 3200] [--logs var/perf]
 *
 * Production configuration validation stays on. The values it demands are satisfied with local
 * placeholders: an https APP_ORIGIN that the load runner sends as Origin (TLS is not terminated
 * locally; the runner talks plain HTTP to the port), random per-start secrets, SCANNER_MODE=clamd and
 * MAIL_TRANSPORT=smtp pointing at 127.0.0.1 (the profile uploads no media and sends no mail), and
 * filesystem storage for export files. Stops both processes on Ctrl-C / SIGTERM.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arg } from './shared';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const distDir = process.env.NEXT_DIST_DIR || '.next-perf';
const server = join(root, 'apps/web', distDir, 'standalone/apps/web/server.js');
const port = Number(arg('port') ?? process.env.PERF_PORT ?? 3200);
const databaseUrl =
  arg('database-url') ??
  process.env.PERF_DATABASE_URL ??
  'postgres://castlane:castlane@127.0.0.1:5432/castlane_perf';
const logs = resolve(root, arg('logs') ?? 'var/perf');
const origin = arg('origin') ?? process.env.PERF_APP_ORIGIN ?? 'https://perf.castlane.invalid';
/** Web server processes on consecutive ports (the Next.js server uses one CPU core per process). */
const webInstances = Math.max(1, Number(arg('web-instances') ?? 1));
/**
 * Caddy binary: with it, the web processes listen on the following ports and Caddy balances them on
 * `--port` with the directives of infra/caddy/Caddyfile (sticky cookie, active health checks), over
 * plain HTTP.
 */
const caddyBin = arg('caddy') ?? process.env.CADDY_BIN;
/** Extra Node.js flags for the web processes, e.g. "--cpu-prof --cpu-prof-dir=var/perf/prof". */
const webNodeArgs = (arg('web-node-args') ?? '').split(' ').filter(Boolean);

if (!existsSync(server)) {
  console.error(`Missing ${server}. Build first: NEXT_DIST_DIR=${distDir} pnpm --filter @castlane/web build`);
  process.exit(2);
}
mkdirSync(logs, { recursive: true });
mkdirSync(join(logs, 'storage'), { recursive: true });

const env: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: 'production',
  NEXT_TELEMETRY_DISABLED: '1',
  APP_ORIGIN: origin,
  DATABASE_URL: databaseUrl,
  DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX ?? '10',
  SESSION_SECRET: randomBytes(36).toString('base64url'),
  MFA_ENCRYPTION_KEY: randomBytes(36).toString('base64url'),
  SCANNER_MODE: 'clamd',
  CLAMD_HOST: '127.0.0.1',
  MAIL_TRANSPORT: 'smtp',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: process.env.SMTP_PORT ?? '2525',
  STORAGE_DRIVER: 'filesystem',
  STORAGE_FS_ROOT: join(logs, 'storage'),
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
  JOB_CONCURRENCY: process.env.JOB_CONCURRENCY ?? '4',
};

const children: ChildProcess[] = [];
const start = (name: string, cmd: string, args: string[], extra: Record<string, string>, cwd = root) => {
  const out = createWriteStream(join(logs, `${name}.log`), { flags: 'a' });
  const child = spawn(cmd, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.pipe(out);
  child.stderr!.pipe(out);
  child.on('exit', (code, signal) => {
    console.log(`${name} exited (${code ?? signal})`);
    if (!stopping) shutdown(1);
  });
  children.push(child);
  console.log(`${name} started (pid ${child.pid}), log ${join(logs, `${name}.log`)}`);
  return child;
};

let stopping = false;
const shutdown = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 3000).unref();
};
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const firstWebPort = caddyBin ? port + 1 : port;
const webs = Array.from({ length: webInstances }, (_, i) =>
  start(webInstances > 1 ? `web-${i + 1}` : 'web', process.execPath, [...webNodeArgs, server], {
    PORT: String(firstWebPort + i),
    HOSTNAME: '127.0.0.1',
    CASTLANE_PROCESS: 'web',
  }),
);
const webPorts = webs.map((_, i) => firstWebPort + i);
let proxy: ChildProcess | null = null;
if (caddyBin) {
  // Same load-balancing directives as infra/caddy/Caddyfile, without TLS.
  const caddyfile = join(logs, 'Caddyfile');
  writeFileSync(
    caddyfile,
    `{\n\tadmin off\n\tauto_https off\n}\n:${port} {\n\treverse_proxy ${webPorts.map((p) => `127.0.0.1:${p}`).join(' ')} {\n` +
      `\t\tlb_policy cookie castlane_upstream\n\t\tlb_try_duration 5s\n\t\tlb_try_interval 250ms\n` +
      `\t\thealth_uri /api/v1/health/ready\n\t\thealth_interval 10s\n\t\thealth_timeout 3s\n\t\thealth_status 2xx\n` +
      `\t\tfail_duration 30s\n\t\tflush_interval -1\n\t}\n}\n`,
  );
  proxy = start('caddy', caddyBin, ['run', '--config', caddyfile, '--adapter', 'caddyfile'], {});
}
const ports = caddyBin ? [port] : webPorts;
const worker = start('worker', 'pnpm', ['--filter', '@castlane/worker', 'exec', 'tsx', 'src/index.ts'], {
  CASTLANE_PROCESS: 'worker',
});
// The runner reads the process ids to attribute CPU time to web and worker (process trees).
writeFileSync(
  join(logs, 'stack.json'),
  JSON.stringify({
    webPids: webs.map((w) => w.pid),
    workerPid: worker.pid,
    proxyPid: proxy?.pid ?? null,
    ports,
    webPorts,
    databaseUrl,
  }),
);

const ready = async () => {
  for (let i = 0; i < 120; i++) {
    const ok = (
      await Promise.all(
        [...new Set([...webPorts, ...ports])].map((p) =>
          fetch(`http://127.0.0.1:${p}/api/v1/health/live`)
            .then((r) => r.ok)
            .catch(() => false),
        ),
      )
    ).every(Boolean);
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};
void ready().then((ok) => {
  if (!ok) {
    console.error('web did not become ready in 60 s');
    shutdown(1);
    return;
  }
  console.log(
    `ready: ${ports.map((p) => `http://127.0.0.1:${p}`).join(', ')}${caddyBin ? ` (Caddy → ${webPorts.length} web processes)` : ''} (APP_ORIGIN ${origin}, database ${databaseUrl.replace(/\/\/[^@]*@/, '//…@')})`,
  );
});
