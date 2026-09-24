import { Suspense } from 'react';
import { PartnersScreen } from '@/features/partners/partners-screen';

export const metadata = { title: 'Partners' };

export default function PartnersPage() {
  return (
    <Suspense>
      <PartnersScreen />
    </Suspense>
  );
}
