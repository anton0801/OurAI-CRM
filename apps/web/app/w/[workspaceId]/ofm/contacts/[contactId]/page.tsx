import { Suspense } from 'react';
import { ContactWorkspace } from '@/features/ofm/contact-workspace';

export const metadata = { title: 'Contact' };

export default async function OfmContactPage({ params }: { params: Promise<{ contactId: string }> }) {
  const { contactId } = await params;
  return (
    <Suspense>
      <ContactWorkspace contactId={contactId} />
    </Suspense>
  );
}
