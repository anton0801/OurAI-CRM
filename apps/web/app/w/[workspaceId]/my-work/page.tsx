import { Suspense } from 'react';
import { MyWorkScreen } from '@/features/my-work/my-work-screen';

export const metadata = { title: 'My Work' };

export default function MyWorkPage() {
  return (
    <Suspense>
      <MyWorkScreen />
    </Suspense>
  );
}
