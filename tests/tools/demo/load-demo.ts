/**
 * Opt-in demo data for a local walkthrough of Castlane CRM.
 *
 *   pnpm fixtures:load --workspace <workspaceId> [--owner-email <email>]
 *
 * Every record is created through the real HTTP API pipeline in-process (validation, permissions,
 * idempotency, audit, search indexing), acting as the workspace Owner. Demo colleagues are created
 * with random, unusable passwords under the reserved `.invalid` domain. The loader refuses to run
 * in production and refuses a workspace that already received demo data.
 */
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { getAppServices, hashPassword } from '@castlane/application';
import { memberships, roleAssignments, roles, systemState, users, workspaces } from '@castlane/database';
import { addMember, sessionFor, type TestWorkspace } from '@castlane/test-fixtures';
import { TestClient } from '../../support/client';
import { stageBase } from './stage-base';
import { stageWork } from './stage-work';
import { stageContent } from './stage-content';
import { stageOps } from './stage-ops';
import { stageInsights } from './stage-insights';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const main = async () => {
  const app = getAppServices();
  if (app.config.isProduction) {
    console.error('Refusing to load demo data: this is a production configuration. Demo data is for local walkthroughs only.');
    process.exit(2);
  }
  const workspaceId = arg('workspace');
  if (!workspaceId) {
    console.error('Usage: pnpm fixtures:load --workspace <workspaceId> [--owner-email <email>]');
    process.exit(2);
  }
  const db = app.db;
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!ws) throw new Error('Workspace not found.');
  const marker = `demo_fixture:${workspaceId}`;
  const [done] = await db.select().from(systemState).where(eq(systemState.key, marker));
  if (done) {
    console.error('This workspace already received demo data. Use a new workspace for another demo.');
    process.exit(2);
  }
  // Act as the workspace Owner (role 'owner', workspace scope), optionally a specific one by e-mail.
  const ownerEmail = arg('owner-email');
  const [owner] = await db
    .select({ membershipId: memberships.id, userId: users.id, email: users.displayEmail })
    .from(roleAssignments)
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .innerJoin(memberships, eq(memberships.id, roleAssignments.membershipId))
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(roleAssignments.workspaceId, workspaceId),
        eq(roles.key, 'owner'),
        eq(memberships.status, 'active'),
        ownerEmail ? eq(users.normalizedEmail, ownerEmail.trim().toLowerCase()) : undefined,
      ),
    )
    .limit(1);
  if (!owner) throw new Error('No active Owner found in this workspace.');
  const ownerRow = owner;
  const tw: TestWorkspace = {
    workspaceId,
    owner: { userId: ownerRow.userId, membershipId: ownerRow.membershipId, email: owner.email },
    roleId: async (key: string) => {
      const [r] = await db.select({ id: roles.id }).from(roles).where(and(eq(roles.workspaceId, workspaceId), eq(roles.key, key)));
      if (!r) throw new Error(`Role ${key} not found`);
      return r.id;
    },
  };
  const client = await new TestClient(await sessionFor(db, ownerRow.userId, { workspaceId })).init();

  // Demo colleagues (cannot sign in: random password, reserved .invalid domain).
  const person = async (name: string, roleKey: string, scopeType: 'workspace' | 'assigned_projects' | 'assigned_accounts' = 'workspace') =>
    addMember(db, tw, { name, email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@demo.castlane.invalid`, roleKey, scopeType });
  const team = {
    producer: await person('Ruslan Petrov', 'project_lead', 'assigned_projects'),
    modelLead: await person('Andrey Volkov', 'project_lead', 'assigned_projects'),
    creator: await person('Mila Sokolova', 'creator', 'assigned_projects'),
    publisher: await person('Timur Kim', 'publisher'),
    ofmManager: await person('Kira Lebedeva', 'ofm_manager', 'assigned_accounts'),
    finance: await person('Oleg Morozov', 'finance_manager'),
  };
  // The builder sets a known test password: replace it with a random one nobody knows.
  for (const m of Object.values(team))
    await db.update(users).set({ passwordHash: await hashPassword(randomBytes(32).toString('base64url')) }).where(eq(users.id, m.userId));

  const png = (w: number, h: number, bg: string) => sharp({ create: { width: w, height: h, channels: 3, background: bg } }).png().toBuffer();
  const base = await stageBase({ client, workspaceId, ownerMembershipId: ownerRow.membershipId, team, png, tz: ws.timezone });
  await stageWork({ client, workspaceId, ownerMembershipId: ownerRow.membershipId, team, base, tz: ws.timezone });
  const content = await stageContent({ client, workspaceId, ownerMembershipId: ownerRow.membershipId, team, base, tz: ws.timezone, png });
  const clientOf = async (m: { userId: string }) => new TestClient(await sessionFor(db, m.userId, { workspaceId })).init();
  await stageOps({ client, workspaceId, ownerMembershipId: ownerRow.membershipId, team, base, tz: ws.timezone, clientOf });
  await stageInsights({ client, workspaceId, ownerMembershipId: ownerRow.membershipId, team, base, tz: ws.timezone, teaserPublicationId: content.publications.teaser });

  await db.insert(systemState).values({ key: marker, value: { loadedAt: new Date().toISOString(), projects: base.projects } });
  console.log('Demo data loaded:', JSON.stringify({ projects: Object.keys(base.projects).length, accounts: Object.keys(base.accounts).length }));
  process.exit(0);
};

main().catch((e) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : e);
  const fe = (e as { fieldErrors?: unknown }).fieldErrors;
  if (fe) console.error(JSON.stringify(fe, null, 2));
  process.exit(1);
});
