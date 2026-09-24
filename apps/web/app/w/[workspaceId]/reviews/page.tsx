import { Suspense } from 'react';
import { ReviewQueue } from '@/features/reviews/review-queue';

export const metadata = { title: 'Review Queue' };

export default function ReviewsPage() {
  return (
    <Suspense>
      <ReviewQueue />
    </Suspense>
  );
}
