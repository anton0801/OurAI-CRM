import { Suspense } from 'react';
import { CategoriesScreen } from '@/features/finance/settings-screens';

export const metadata = { title: 'Finance Categories' };

export default function CategoriesPage() {
  return (
    <Suspense>
      <CategoriesScreen />
    </Suspense>
  );
}
