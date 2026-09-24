import { Suspense } from 'react';
import { HandoversScreen } from '@/features/ofm/handovers-screen';

export const metadata = { title: 'Handover Desk' };

export default function OfmHandoversPage() {
  return (
    <Suspense>
      <HandoversScreen />
    </Suspense>
  );
}
