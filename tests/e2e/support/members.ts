import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { createDatabase, memberships, roles, users } from '@castlane/database';
import { addMember, sessionFor, type TestWorkspace } from '@castlane/test-fixtures';
import type { ScopeType } from '@castlane/domain';
import { E2EApi } from './api';
import { e2eDatabaseUrl } from './env';
import { readOwner } from './helpers';

export interface E2EMember {
  userId: string;
  membershipId: string;
  name: string;
  api: E2EApi;
}

/**
 * Colleagues for multi-person flows. Inviting through the UI would also need their own password
 * and MFA enrolment, which other specs cover; here the member is written with the shared test
 * builders (like the demo loader does) and gets an MFA-verified server session, so everything the
 * member then does still goes through the HTTP API.
 */
export const withWorkspaceDb = async <T>(fn: (db: ReturnType<typeof createDatabase>['db'], ws: TestWorkspace) => Promise<T>): Promise<T> => {
  const handle = createDatabase(e2eDatabaseUrl(), { max: 2 });
  try {
    const owner = readOwner();
    const [o] = await handle.db
      .select({ userId: users.id, membershipId: memberships.id })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.workspaceId, owner.workspaceId), eq(users.normalizedEmail, owner.email.toLowerCase())));
    if (!o) throw new Error('Owner membership not found in the e2e workspace.');
    const ws: TestWorkspace = {
      workspaceId: owner.workspaceId,
      owner: { ...o, email: owner.email },
      roleId: async (key) => {
        const [r] = await handle.db.select({ id: roles.id }).from(roles).where(and(eq(roles.workspaceId, owner.workspaceId), eq(roles.key, key)));
        if (!r) throw new Error(`Role ${key} not found`);
        return r.id;
      },
    };
    return await fn(handle.db, ws);
  } finally {
    await handle.close();
  }
};

/** The Owner's membership id in the e2e workspace. */
export const ownerMembershipId = () => withWorkspaceDb(async (_db, ws) => ws.owner.membershipId);

export const createMember = (input: { name: string; roleKey: string; scopeType?: ScopeType }): Promise<E2EMember> =>
  withWorkspaceDb(async (db, ws) => {
    const email = `${input.name.toLowerCase().replace(/[^a-z]+/g, '.')}.${randomBytes(3).toString('hex')}@team.castlane.test`;
    const m = await addMember(db, ws, { name: input.name, email, roleKey: input.roleKey, scopeType: input.scopeType ?? 'workspace' });
    const token = await sessionFor(db, m.userId, { workspaceId: ws.workspaceId });
    return { userId: m.userId, membershipId: m.membershipId, name: input.name, api: await E2EApi.forSessionToken(token) };
  });
