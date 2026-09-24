import { redirect } from 'next/navigation';
import { getAppServices, landingPath } from '@castlane/application';
import { optionalSession } from '@/server/session';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const session = await optionalSession();
  if (!session) redirect('/auth/sign-in');
  redirect(await landingPath(getAppServices().db, session.userId));
}
