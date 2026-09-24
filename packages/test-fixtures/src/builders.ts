import { and, eq } from 'drizzle-orm';
import {
  directions,
  memberships,
  projectMemberships,
  projects,
  roleAssignments,
  roles,
  sessions,
  socialAccounts,
  userPreferences,
  users,
  workspaces,
  type Db,
} from '@castlane/database';
import { createSession, createWorkspaceWithDefaults, hashPassword } from '@castlane/application';
import { newId, normalizeEmail, normalizeKey, normalizeProfileUrl, type ScopeType } from '@castlane/domain';

/** Test-data builders. They write directly for speed; behaviour under test goes through the API. */
export const DEFAULT_TEST_PASSWORD = 'test password 1234';

export const createUser = async (db: Db, input: { email: string; name?: string; password?: string; at?: Date }) => {
  const id = newId();
  const at = input.at ?? new Date();
  await db.insert(users).values({
    id,
    normalizedEmail: normalizeEmail(input.email),
    displayEmail: input.email,
    displayName: input.name ?? input.email.split('@')[0]!,
    passwordHash: await hashPassword(input.password ?? DEFAULT_TEST_PASSWORD),
    passwordChangedAt: at,
    createdAt: at,
    updatedAt: at,
  });
  await db.insert(userPreferences).values({ userId: id }).onConflictDoNothing();
  return { id, email: input.email, name: input.name ?? input.email.split('@')[0]! };
};

export interface TestWorkspace {
  workspaceId: string;
  owner: { userId: string; membershipId: string; email: string };
  roleId: (key: string) => Promise<string>;
}

export const createWorkspace = async (
  db: Db,
  input: { ownerEmail?: string; name?: string; timezone?: string; currency?: string; setupCompleted?: boolean } = {},
): Promise<TestWorkspace> => {
  const owner = await createUser(db, { email: input.ownerEmail ?? `owner-${newId().slice(0, 8)}@test.invalid`, name: 'Owner' });
  const { workspaceId, membershipId } = await createWorkspaceWithDefaults(db, {
    name: input.name ?? 'Test Workspace',
    timezone: input.timezone ?? 'Europe/Berlin',
    baseCurrency: input.currency ?? 'EUR',
    ownerUserId: owner.id,
    ownerDisplayName: owner.name,
    at: new Date(),
  });
  if (input.setupCompleted !== false)
    await db.update(workspaces).set({ setupStep: 'completed', setupCompletedAt: new Date() }).where(eq(workspaces.id, workspaceId));
  return {
    workspaceId,
    owner: { userId: owner.id, membershipId, email: owner.email },
    roleId: async (key: string) => {
      const [r] = await db.select({ id: roles.id }).from(roles).where(and(eq(roles.workspaceId, workspaceId), eq(roles.key, key)));
      if (!r) throw new Error(`Role ${key} not found`);
      return r.id;
    },
  };
};

export const addMember = async (
  db: Db,
  ws: TestWorkspace,
  input: { email?: string; name?: string; roleKey: string; scopeType?: ScopeType; scopeId?: string | null; grants?: { roleKey: string; scopeType: ScopeType; scopeId?: string | null }[] },
) => {
  const user = await createUser(db, { email: input.email ?? `${input.roleKey}-${newId().slice(0, 8)}@test.invalid`, name: input.name });
  const membershipId = newId();
  const at = new Date();
  await db.insert(memberships).values({
    id: membershipId,
    workspaceId: ws.workspaceId,
    userId: user.id,
    displayNameSnapshot: user.name,
    status: 'active',
    joinedAt: at,
    createdAt: at,
    updatedAt: at,
  });
  const grants = input.grants ?? [{ roleKey: input.roleKey, scopeType: input.scopeType ?? 'workspace', scopeId: input.scopeId ?? null }];
  for (const g of grants) {
    await db.insert(roleAssignments).values({
      id: newId(),
      workspaceId: ws.workspaceId,
      membershipId,
      roleId: await ws.roleId(g.roleKey),
      scopeType: g.scopeType,
      scopeId: g.scopeId ?? null,
      validFrom: new Date(at.getTime() - 1000),
      createdAt: at,
      updatedAt: at,
    });
  }
  return { userId: user.id, membershipId, email: user.email, name: user.name };
};

/** Session cookie token for a user, already MFA-verified (tests exercise MFA separately). */
export const sessionFor = async (db: Db, userId: string, opts: { mfaVerified?: boolean; workspaceId?: string } = {}) => {
  const s = await createSession(db, userId, new Date(), { userAgent: 'vitest', workspaceId: opts.workspaceId }, { mfaVerified: opts.mfaVerified ?? true });
  return s.token;
};

export const expireSession = async (db: Db, userId: string) => {
  await db.update(sessions).set({ idleExpiresAt: new Date(Date.now() - 1000) }).where(eq(sessions.userId, userId));
};

export const createDirection = async (db: Db, ws: TestWorkspace, name = `Direction ${newId().slice(0, 4)}`) => {
  const id = newId();
  const at = new Date();
  await db.insert(directions).values({ id, workspaceId: ws.workspaceId, name, nameKey: normalizeKey(name), createdAt: at, updatedAt: at });
  return id;
};

export const createProject = async (
  db: Db,
  ws: TestWorkspace,
  input: { directionId?: string; name?: string; type?: 'series' | 'model' | 'influencer'; ownerMembershipId?: string; status?: 'draft' | 'active'; ofmEnabled?: boolean } = {},
) => {
  const id = newId();
  const at = new Date();
  const directionId = input.directionId ?? (await createDirection(db, ws));
  await db.insert(projects).values({
    id,
    workspaceId: ws.workspaceId,
    type: input.type ?? 'series',
    directionId,
    name: input.name ?? `Project ${id.slice(0, 4)}`,
    ownerMembershipId: input.ownerMembershipId ?? ws.owner.membershipId,
    status: input.status ?? 'active',
    briefSummary: 'Test brief',
    ofmEnabled: input.ofmEnabled ?? false,
    createdAt: at,
    updatedAt: at,
  });
  return { id, directionId };
};

export const assignToProject = async (db: Db, ws: TestWorkspace, projectId: string, membershipId: string) => {
  const at = new Date();
  await db.insert(projectMemberships).values({
    id: newId(),
    workspaceId: ws.workspaceId,
    projectId,
    membershipId,
    validFrom: new Date(at.getTime() - 1000),
    createdAt: at,
    updatedAt: at,
  });
};

export const createAccount = async (
  db: Db,
  ws: TestWorkspace,
  input: { projectId: string; platform?: 'instagram' | 'tiktok' | 'onlyfans' | 'other'; url?: string; status?: 'preparing' | 'active'; ownerMembershipId?: string },
) => {
  const id = newId();
  const at = new Date();
  const platform = input.platform ?? 'instagram';
  const url = input.url ?? `https://www.instagram.com/test_${id.slice(0, 8)}`;
  const n = normalizeProfileUrl(url, platform);
  if (!n.ok) throw new Error(`Invalid test URL ${url}`);
  await db.insert(socialAccounts).values({
    id,
    workspaceId: ws.workspaceId,
    projectId: input.projectId,
    platform,
    originalUrl: url,
    canonicalUrl: n.value.canonicalUrl,
    identityKey: n.value.identityKey,
    handle: n.value.handle,
    ownerMembershipId: input.ownerMembershipId ?? ws.owner.membershipId,
    status: input.status ?? 'active',
    createdAt: at,
    updatedAt: at,
  });
  return id;
};
