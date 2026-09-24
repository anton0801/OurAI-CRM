'use client';
import { CheckCircle, Info, Warning, X } from '@phosphor-icons/react';
import { useSyncExternalStore, type ReactNode } from 'react';
import { cn } from './cn';

export interface ToastItem {
  id: number;
  kind: 'success' | 'error' | 'info';
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  /** Errors with an action never auto-dismiss. */
  persistent?: boolean;
}

let items: ToastItem[] = [];
let seq = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

const dismiss = (id: number) => {
  items = items.filter((t) => t.id !== id);
  emit();
};

/** Show a toast only after the server confirmed the result (never optimistically for critical actions). */
export const toast = (t: Omit<ToastItem, 'id'>): number => {
  const id = seq++;
  const persistent = t.persistent ?? (t.kind === 'error' && !!t.action);
  items = [...items, { ...t, id, persistent }].slice(-3);
  emit();
  if (!persistent) setTimeout(() => dismiss(id), t.kind === 'error' ? 8000 : 5000);
  return id;
};
toast.success = (title: string, description?: string) => toast({ kind: 'success', title, description });
toast.error = (title: string, description?: string, action?: ToastItem['action']) => toast({ kind: 'error', title, description, action });
toast.info = (title: string, description?: string) => toast({ kind: 'info', title, description });
toast.dismiss = dismiss;

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

const icons: Record<ToastItem['kind'], ReactNode> = {
  success: <CheckCircle size={18} weight="fill" className="text-primary" aria-hidden />,
  error: <Warning size={18} weight="fill" className="text-danger" aria-hidden />,
  info: <Info size={18} weight="fill" className="text-info" aria-hidden />,
};

export const Toaster = () => {
  const list = useSyncExternalStore(subscribe, () => items, () => items);
  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[90] flex w-[calc(100vw-32px)] max-w-[360px] flex-col gap-2"
      aria-live="polite"
      aria-relevant="additions"
    >
      {list.map((t) => (
        <div
          key={t.id}
          role={t.kind === 'error' ? 'alert' : 'status'}
          className={cn(
            'pointer-events-auto flex items-start gap-3 rounded-[12px] border border-line bg-surface p-3 shadow-[var(--shadow-overlay)]',
            'animate-[toastIn_160ms_ease-out] motion-reduce:animate-none',
          )}
        >
          <span className="mt-0.5">{icons[t.kind]}</span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold leading-5 text-fg">{t.title}</p>
            {t.description ? <p className="mt-0.5 text-[12px] leading-[18px] text-fg-2">{t.description}</p> : null}
            {t.action ? (
              <button
                type="button"
                className="mt-2 text-[12px] font-semibold text-primary underline-offset-2 hover:underline"
                onClick={() => {
                  t.action?.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            ) : null}
          </div>
          <button type="button" aria-label="Dismiss notification" className="rounded p-1 text-fg-2 hover:text-fg" onClick={() => dismiss(t.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
};
