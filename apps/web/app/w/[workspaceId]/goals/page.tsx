import { Suspense } from 'react';
import { GoalsScreen } from '@/features/goals/goals-screen';

export const metadata = { title: 'Goals' };

export default function GoalsPage() {
  return (
    <Suspense>
      <GoalsScreen />
    </Suspense>
  );
}
