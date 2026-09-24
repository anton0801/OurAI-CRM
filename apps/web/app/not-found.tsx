import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="text-[22px] font-[650] text-fg">Not found</h1>
      <p className="max-w-[420px] text-[14px] text-fg-2">This page does not exist or you no longer have access to it.</p>
      <Link href="/" className="text-[14px] font-semibold text-primary hover:underline">
        Go to your workspace
      </Link>
    </div>
  );
}
