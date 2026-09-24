import { Suspense } from 'react';
import { QualityScreen } from '@/features/ofm/quality-screen';

export const metadata = { title: 'Quality Reviews' };

export default function OfmQualityPage() {
  return (
    <Suspense>
      <QualityScreen />
    </Suspense>
  );
}
