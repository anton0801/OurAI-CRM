import { and, eq, sql } from 'drizzle-orm';
import { getAppServices } from '@castlane/application';
import { jobs, sessions, users } from '@castlane/database';
import { clientFor, createWorkspace, sessionFor, type TestClient } from '../../support';

export const db = () => getAppServices().db;

/** A workspace with a signed-in Owner client. */
export const ownerSetup = async () => {
  const ws = await createWorkspace(db());
  const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
  return { ws, owner };
};

export const signedIn = async (userId: string) => clientFor(await sessionFor(db(), userId));

/** Make every session of a user look like the last password/TOTP confirmation was an hour ago. */
export const expireRecentAuth = async (userId: string) => {
  await db()
    .update(sessions)
    .set({ recentAuthAt: new Date(Date.now() - 3_600_000) })
    .where(eq(sessions.userId, userId));
};

export const enableMfaFlag = async (userId: string) => {
  await db().update(users).set({ mfaEnabledAt: new Date() }).where(eq(users.id, userId));
};

/** Raw invitation token from the newest queued invitation mail (only hashes are stored). */
export const latestInviteToken = async (email?: string): Promise<string> => {
  const rows = await db()
    .select({ payload: jobs.payload })
    .from(jobs)
    .where(and(eq(jobs.type, 'mail.send'), sql`${jobs.payload}->>'template' = 'invitation'`, email ? sql`${jobs.payload}->>'to' = ${email}` : undefined))
    .orderBy(sql`${jobs.createdAt} DESC`)
    .limit(1);
  const url = (rows[0]?.payload as { vars?: { inviteUrl?: string } } | undefined)?.vars?.inviteUrl;
  if (!url) throw new Error('No invitation mail queued');
  return url.split('/').pop()!;
};

export const ws = (w: { workspaceId: string }) => ({ workspaceId: w.workspaceId });

export type { TestClient };
