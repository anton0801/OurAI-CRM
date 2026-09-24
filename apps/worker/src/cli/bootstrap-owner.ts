/**
 * One-time Owner bootstrap (F01):
 *   pnpm bootstrap:owner --email owner@example.com --name "Owner Name" [--password-stdin]
 * Without --password-stdin a temporary password is generated and printed once; it must be changed
 * at first sign-in. Refused after the first Owner exists.
 */
import { bootstrapOwner, getAppServices } from '@castlane/application';
import { getDatabase } from '@castlane/database';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const readStdin = async () => {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
};

const main = async () => {
  const email = arg('email');
  const name = arg('name');
  if (!email || !name) {
    console.error('Usage: bootstrap-owner --email <email> --name "<display name>" [--password-stdin]');
    process.exit(2);
  }
  const password = process.argv.includes('--password-stdin') ? await readStdin() : undefined;
  const app = getAppServices();
  try {
    const r = await bootstrapOwner(app.db, { email, displayName: name, password, at: app.clock.now() });
    console.log(`Owner created for ${email}. Workspace id: ${r.workspaceId}`);
    if (r.temporaryPassword) console.log(`Temporary password (shown once, change at first sign-in): ${r.temporaryPassword}`);
    console.log('Next: sign in, set up two-factor authentication and complete the three-step workspace setup.');
  } catch (e) {
    console.error(`Bootstrap refused: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    await getDatabase().close();
  }
};

void main();
