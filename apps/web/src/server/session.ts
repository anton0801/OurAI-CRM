import 'server-only';
import { cookies, headers } from 'next/headers';
import { redirect, notFound } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { ALL_PERMISSIONS, effectivePermissionKeys } from '@castlane/authorization';
import {
  getAppServices,
  resolveSession,
  resolveWorkspaceActor,
  userRequiresMfa,
  SESSION_COOKIE,
  type Actor,
  type SessionRow,
} from '@castlane/application';
import { memberships, userPreferences, users, workspaces } from '@castlane/database';
import { sessionCsrfToken } from './http/pipeline';

export const currentPath = async (): Promise<string> => (await headers()).get('x-castlane-path') ?? '/';

/** Session for server components; redirects to sign-in when absent or expired. */
export const requireSession = async (returnTo?: string): Promise<SessionRow> => {
  const app = getAppServices();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = token ? await resolveSession(app.db, token, app.clock.now()) : null;
  if (!session) redirect(`/auth/sign-in${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`);
  return session;
};

export const optionalSession = async (): Promise<SessionRow | null> => {
  const app = getAppServices();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? resolveSession(app.db, token, app.clock.now()) : null;
};

export interface WorkspacePageSession {
  actor: Actor;
  session: SessionRow;
  value: {
    workspace: { id: string; name: string; timezone: string; baseCurrency: string; weekStartsOn: 'monday' | 'sunday'; logoUrl: string | null };
    user: { id: string; displayName: string; email: string; avatarUrl: string | null; timezone: string; theme: 'system' | 'light' | 'dark'; density: 'comfortable' | 'compact' };
    membershipId: string;
    isOwner: boolean;
    permissions: string[];
    workspaces: { id: string; name: string }[];
    csrfToken: string;
  };
}

/**
 * Resolve everything a workspace page needs: session, MFA/password gates, membership (404 when
 * absent — existence is not revealed), setup redirect for the Owner, effective permissions.
 */
export const requireWorkspaceSession = async (workspaceId: string, path: string): Promise<WorkspacePageSession> => {
  const app = getAppServices();
  const session = await requireSession(path);
  const at = app.clock.now();
  const [user] = await app.db.select().from(users).where(eq(users.id, session.userId));
  if (!user || user.status !== 'active') redirect('/auth/sign-in');
  if (user.mustChangePassword) redirect(`/auth/change-password?returnTo=${encodeURIComponent(path)}`);
  if (!session.mfaVerifiedAt && (await userRequiresMfa(app.db, user.id, at)))
    redirect(`/auth/mfa?mode=session&returnTo=${encodeURIComponent(path)}`);
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) notFound();
  const actor = await resolveWorkspaceActor(app.db, session, workspaceId, at);
  if (!actor || actor.access.membershipStatus !== 'active') notFound();
  const [ws] = await app.db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!ws) notFound();
  if (ws.setupStep !== 'completed' && actor.access.isOwner) redirect(`/setup/${ws.setupStep}?w=${ws.id}`);
  const [pref] = await app.db.select().from(userPreferences).where(eq(userPreferences.userId, user.id));
  const others = await app.db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(and(eq(memberships.userId, user.id), eq(memberships.status, 'active')));
  return {
    actor,
    session,
    value: {
      workspace: {
        id: ws.id,
        name: ws.name,
        timezone: ws.timezone,
        baseCurrency: ws.baseCurrency,
        weekStartsOn: ws.weekStartsOn,
        logoUrl: ws.logoAssetId ? `/api/v1/workspaces/${ws.id}/logo` : null,
      },
      user: {
        id: user.id,
        displayName: user.displayName,
        email: user.displayEmail,
        avatarUrl: user.avatarAssetId ? `/api/v1/avatars/${user.id}` : null,
        timezone: pref?.timezone ?? ws.timezone,
        theme: pref?.theme ?? 'system',
        density: pref?.density ?? 'comfortable',
      },
      membershipId: actor.membershipId!,
      isOwner: actor.access.isOwner,
      permissions: effectivePermissionKeys(actor.access, ALL_PERMISSIONS),
      workspaces: others,
      csrfToken: sessionCsrfToken(app, session),
    },
  };
};
