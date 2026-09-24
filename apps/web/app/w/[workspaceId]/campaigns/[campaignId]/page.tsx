import { Suspense } from 'react';
import { CampaignWorkspace } from '@/features/campaigns/campaign-workspace';

export const metadata = { title: 'Campaign' };

export default async function CampaignPage({ params }: { params: Promise<{ campaignId: string }> }) {
  const { campaignId } = await params;
  return (
    <Suspense>
      <CampaignWorkspace campaignId={campaignId} />
    </Suspense>
  );
}
