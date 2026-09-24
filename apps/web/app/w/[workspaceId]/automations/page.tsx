import { Suspense } from 'react';
import { AutomationsScreen } from '@/features/automations/automations-screen';

export const metadata = { title: 'Automations' };

export default function AutomationsPage() {
  return (
    <Suspense>
      <AutomationsScreen />
    </Suspense>
  );
}
