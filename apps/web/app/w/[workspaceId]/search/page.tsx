import { Suspense } from 'react';
import { SearchScreen } from '@/features/search/search-screen';

export const metadata = { title: 'Search' };

export default function SearchPage() {
  return (
    <Suspense>
      <SearchScreen />
    </Suspense>
  );
}
