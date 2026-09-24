import { hostname } from 'node:os';
import { configureMailer, createMailer, getAppServices } from '@castlane/application';
import '@castlane/application/register-all';
import { dispatchOutboxBatch } from './outbox';
import { JobRunner, sweepCancelled } from './runner';
import { runSchedulerTick } from './scheduler';

process.env.CASTLANE_PROCESS ??= 'worker';

const main = async () => {
  const app = getAppServices();
  configureMailer(createMailer(app.config));
  const workerId = `${hostname()}:${process.pid}`;
  app.logger.info('worker_starting', { workerId, mail: app.config.MAIL_TRANSPORT, storage: app.config.STORAGE_DRIVER, scanner: app.config.SCANNER_MODE });

  // Separate pools: heavy media never delays a password-reset e-mail.
  const runners = [
    new JobRunner(app, 'light', app.config.JOB_CONCURRENCY, `${workerId}:light`),
    new JobRunner(app, 'data', Math.max(1, Math.floor(app.config.JOB_CONCURRENCY / 2)), `${workerId}:data`),
    new JobRunner(app, 'media', app.config.MEDIA_JOB_CONCURRENCY, `${workerId}:media`),
  ];
  runners.forEach((r) => r.start());

  let stopping = false;
  const outboxLoop = async () => {
    while (!stopping) {
      try {
        const n = await dispatchOutboxBatch(app);
        if (n === 0) await new Promise((r) => setTimeout(r, 500));
      } catch (e) {
        app.logger.error('outbox_loop_error', { error: (e as Error).message });
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  };
  void outboxLoop();

  const tick = async () => {
    try {
      await runSchedulerTick(app);
      await sweepCancelled(app);
    } catch (e) {
      app.logger.error('scheduler_error', { error: (e as Error).message });
    }
  };
  await tick();
  const schedTimer = setInterval(() => void tick(), 30_000);

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    app.logger.info('worker_stopping', { signal });
    clearInterval(schedTimer);
    await Promise.all(runners.map((r) => r.stop()));
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
