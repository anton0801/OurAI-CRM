import { Suspense } from 'react';
import { KnowledgeScreen } from '@/features/knowledge/knowledge-screen';

export const metadata = { title: 'Knowledge' };

export default function KnowledgePage() {
  return (
    <Suspense>
      <KnowledgeScreen />
    </Suspense>
  );
}
