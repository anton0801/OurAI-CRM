import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { MemberWorkspace } from '@/features/team/member-workspace';

export const metadata = { title: 'Team Member' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function MemberPage({ params }: { params: Promise<{ memberId: string }> }) {
  const { memberId } = await params;
  if (!UUID.test(memberId)) notFound();
  return (
    <Suspense>
      <MemberWorkspace memberId={memberId} />
    </Suspense>
  );
}
