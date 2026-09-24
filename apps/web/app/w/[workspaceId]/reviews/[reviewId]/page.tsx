import { Suspense } from 'react';
import { ReviewStudio } from '@/features/reviews/review-studio';

export const metadata = { title: 'Review Studio' };

export default async function ReviewStudioPage({ params }: { params: Promise<{ reviewId: string }> }) {
  const { reviewId } = await params;
  return (
    <Suspense>
      <ReviewStudio reviewId={reviewId} />
    </Suspense>
  );
}
