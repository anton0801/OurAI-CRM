import { Suspense } from 'react';
import { ProfileSettingsScreen } from '@/features/settings/profile-settings';

export const metadata = { title: 'Personal Settings' };

export default function ProfileSettingsPage() {
  return (
    <Suspense>
      <ProfileSettingsScreen />
    </Suspense>
  );
}
