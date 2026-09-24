import { Suspense } from 'react';
import { ContactsScreen } from '@/features/ofm/contacts-screen';

export const metadata = { title: 'OFM Contacts' };

export default function OfmContactsPage() {
  return (
    <Suspense>
      <ContactsScreen />
    </Suspense>
  );
}
