import { Suspense } from 'react';
import { CampaignsScreen } from '@/features/campaigns/campaigns-screen';

export const metadata = { title: 'Campaigns' };

export default function CampaignsPage() {
  return (
    <Suspense>
      <CampaignsScreen />
    </Suspense>
  );
}
