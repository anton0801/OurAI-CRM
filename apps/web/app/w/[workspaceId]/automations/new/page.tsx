import { Suspense } from 'react';
import { NewRuleScreen } from '@/features/automations/new-rule-screen';

export const metadata = { title: 'New Automation Rule' };

export default function NewAutomationPage() {
  return (
    <Suspense>
      <NewRuleScreen />
    </Suspense>
  );
}
