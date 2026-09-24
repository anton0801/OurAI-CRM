'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OfflineNotice, Toaster, TooltipProvider } from '@castlane/ui';
import { useEffect, useState, type ReactNode } from 'react';

const OfflineWatcher = () => {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    setOnline(navigator.onLine);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online ? null : (
    <div className="fixed inset-x-0 top-0 z-[95]">
      <OfflineNotice />
    </div>
  );
};

export const Providers = ({ children }: { children: ReactNode }) => {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 15_000, refetchOnWindowFocus: true, gcTime: 5 * 60_000 },
          mutations: { retry: false },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <OfflineWatcher />
        {children}
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
};
