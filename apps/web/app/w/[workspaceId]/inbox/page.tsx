import { Suspense } from 'react';
import { InboxScreen } from '@/features/inbox/inbox-screen';

export const metadata = { title: 'Inbox' };

export default function InboxPage() {
  return (
    <Suspense>
      <InboxScreen />
    </Suspense>
  );
}
