import { Suspense } from 'react';
import { ArticleScreen } from '@/features/knowledge/article-screen';

export const metadata = { title: 'Article' };

export default async function ArticlePage({ params }: { params: Promise<{ articleId: string }> }) {
  const { articleId } = await params;
  return (
    <Suspense>
      <ArticleScreen articleId={articleId} />
    </Suspense>
  );
}
