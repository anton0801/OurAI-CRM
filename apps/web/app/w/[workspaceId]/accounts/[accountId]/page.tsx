import { Suspense } from 'react';
import { AccountDetailScreen } from '@/features/accounts/account-detail';

export const metadata = { title: 'Account' };

export default async function AccountPage({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  return (
    <Suspense>
      <AccountDetailScreen accountId={accountId} />
    </Suspense>
  );
}
