import { Suspense } from 'react';
import { GoalDetailScreen } from '@/features/goals/goal-detail';

export const metadata = { title: 'Goal' };

export default async function GoalPage({ params }: { params: Promise<{ goalId: string }> }) {
  const { goalId } = await params;
  return (
    <Suspense>
      <GoalDetailScreen goalId={goalId} />
    </Suspense>
  );
}
