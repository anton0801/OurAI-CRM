import { Suspense } from 'react';
import { DealForm } from '@/features/partners/deal-form';

export const metadata = { title: 'New Deal' };

export default function NewDealPage() {
  return (
    <Suspense>
      <DealForm />
    </Suspense>
  );
}
