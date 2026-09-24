import { redirect } from 'next/navigation';

export default async function Completed({ searchParams }: { searchParams: Promise<{ w?: string }> }) {
  const { w } = await searchParams;
  redirect(w ? `/w/${w}/overview` : '/');
}
