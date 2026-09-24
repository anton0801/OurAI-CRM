import { Suspense } from 'react';
import { DirectionsScreen } from '@/features/directions/directions-screen';

export const metadata = { title: 'Directions' };

export default function DirectionsPage() {
  return (
    <Suspense>
      <DirectionsScreen />
    </Suspense>
  );
}
