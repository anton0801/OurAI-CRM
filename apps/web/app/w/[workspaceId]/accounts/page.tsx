import { Suspense } from 'react';
import { AccountsScreen } from '@/features/accounts/accounts-screen';

export const metadata = { title: 'Accounts' };

export default function AccountsPage() {
  return (
    <Suspense>
      <AccountsScreen />
    </Suspense>
  );
}
