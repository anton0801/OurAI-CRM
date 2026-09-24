import { Suspense } from 'react';
import { TemplatesScreen } from '@/features/templates/templates-screen';

export const metadata = { title: 'Templates & Custom Fields' };

export default function TemplatesPage() {
  return (
    <Suspense>
      <TemplatesScreen />
    </Suspense>
  );
}
