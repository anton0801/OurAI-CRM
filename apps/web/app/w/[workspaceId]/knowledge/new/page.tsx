import { Suspense } from 'react';
import { ArticleNew } from '@/features/knowledge/article-new';

export const metadata = { title: 'New Article' };

export default function NewArticlePage() {
  return (
    <Suspense>
      <ArticleNew />
    </Suspense>
  );
}
