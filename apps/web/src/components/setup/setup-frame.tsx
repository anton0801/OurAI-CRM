'use client';
import type { ReactNode } from 'react';
import { setCsrfToken } from '@/lib/api';

export const SetupFrame = ({ csrfToken, children }: { csrfToken: string; children: ReactNode }) => {
  setCsrfToken(csrfToken);
  return (
    <div className="min-h-dvh bg-canvas px-4 py-8 md:py-12">
      <div className="mx-auto w-full max-w-[720px]">
        <div className="mb-8 flex items-center justify-between">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/castlane-wordmark.svg" alt="Castlane" width={160} height={32} />
        </div>
        {children}
      </div>
    </div>
  );
};

export const SetupStepHeader = ({ step, title, description }: { step: 1 | 2 | 3; title: string; description: string }) => (
  <div className="mb-6">
    <p className="text-[12px] font-semibold uppercase tracking-wide text-primary">Step {step} of 3</p>
    <div className="mt-2 flex gap-1" aria-hidden>
      {[1, 2, 3].map((i) => (
        <span key={i} className={`h-1 flex-1 rounded-full ${i <= step ? 'bg-primary' : 'bg-line'}`} />
      ))}
    </div>
    <h1 className="mt-4 text-[28px] font-[650] leading-9 text-fg">{title}</h1>
    <p className="mt-1 text-[14px] leading-[22px] text-fg-2">{description}</p>
  </div>
);
