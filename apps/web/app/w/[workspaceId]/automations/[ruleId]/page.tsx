import { Suspense } from 'react';
import { RuleScreen } from '@/features/automations/rule-screen';

export const metadata = { title: 'Automation Rule' };

export default async function AutomationRulePage({ params }: { params: Promise<{ ruleId: string }> }) {
  const { ruleId } = await params;
  return (
    <Suspense>
      <RuleScreen ruleId={ruleId} />
    </Suspense>
  );
}
