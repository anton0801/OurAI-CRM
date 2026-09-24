import { Suspense } from 'react';
import { TeamScreen } from '@/features/team/team-screen';

export const metadata = { title: 'Team' };

export default function TeamPage() {
  return (
    <Suspense>
      <TeamScreen />
    </Suspense>
  );
}
