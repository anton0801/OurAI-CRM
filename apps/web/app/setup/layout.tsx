import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getAppServices, userRequiresMfa } from '@castlane/application';
import { users } from '@castlane/database';
import { SetupFrame } from '@/components/setup/setup-frame';
import { sessionCsrfToken } from '@/server/http/pipeline';
import { currentPath, requireSession } from '@/server/session';

export const dynamic = 'force-dynamic';

export default async function SetupLayout({ children }: { children: ReactNode }) {
  const path = await currentPath();
  const session = await requireSession(path);
  const app = getAppServices();
  const [user] = await app.db.select().from(users).where(eq(users.id, session.userId));
  if (!user || user.status !== 'active') redirect('/auth/sign-in');
  if (user.mustChangePassword) redirect(`/auth/change-password?returnTo=${encodeURIComponent(path)}`);
  if (!session.mfaVerifiedAt && (await userRequiresMfa(app.db, user.id, app.clock.now())))
    redirect(`/auth/mfa?mode=session&returnTo=${encodeURIComponent(path)}`);
  return <SetupFrame csrfToken={sessionCsrfToken(getAppServices(), session)}>{children}</SetupFrame>;
}
