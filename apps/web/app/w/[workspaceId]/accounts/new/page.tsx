import { Suspense } from 'react';
import { AccountEditor } from '@/features/accounts/account-editor';

export const metadata = { title: 'Add Account' };

export default function NewAccountPage() {
  return (
    <Suspense>
      <AccountEditor />
    </Suspense>
  );
}
