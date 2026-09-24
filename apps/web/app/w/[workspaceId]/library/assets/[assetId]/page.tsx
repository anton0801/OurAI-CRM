import { Suspense } from 'react';
import { AssetViewer } from '@/features/library/asset-viewer';

export const metadata = { title: 'File' };

export default async function AssetPage({ params }: { params: Promise<{ assetId: string }> }) {
  const { assetId } = await params;
  return (
    <Suspense>
      <AssetViewer assetId={assetId} />
    </Suspense>
  );
}
