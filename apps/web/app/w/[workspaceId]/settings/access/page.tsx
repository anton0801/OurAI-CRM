import { Suspense } from 'react';
import { AccessScreen } from '@/features/settings/access-screen';

export const metadata = { title: 'Roles and Access' };

export default function AccessPage() {
  return (
    <Suspense>
      <AccessScreen />
    </Suspense>
  );
}
