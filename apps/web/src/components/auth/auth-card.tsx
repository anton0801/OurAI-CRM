import type { ReactNode } from 'react';

export const AuthCard = ({ title, description, children, footer }: { title: string; description?: ReactNode; children: ReactNode; footer?: ReactNode }) => (
  <div className="flex min-h-dvh items-start justify-center bg-canvas px-4 py-10 md:items-center">
    <div className="w-full max-w-[400px]">
      <div className="mb-6 flex justify-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/castlane-wordmark.svg" alt="Castlane" width={120} height={24} />
      </div>
      <main className="rounded-[16px] border border-line bg-surface p-6 md:p-8">
        <h1 className="text-[22px] font-[650] leading-8 text-fg">{title}</h1>
        {description ? <div className="mt-1 text-[14px] leading-[22px] text-fg-2">{description}</div> : null}
        <div className="mt-6">{children}</div>
      </main>
      {footer ? <div className="mt-4 text-center text-[13px] text-fg-2">{footer}</div> : null}
    </div>
  </div>
);

export const FormError = ({ message }: { message: string | null }) =>
  message ? (
    <p role="alert" className="rounded-[8px] bg-danger-soft px-3 py-2 text-[13px] leading-5 text-danger">
      {message}
    </p>
  ) : null;
