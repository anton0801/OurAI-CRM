'use client';
import { Dialog as D } from 'radix-ui';
import { X } from '@phosphor-icons/react';
import { useState, type ReactNode } from 'react';
import { Button } from './button';
import { cn } from './cn';

const overlayCls =
  'fixed inset-0 z-50 bg-black/35 data-[state=open]:animate-[fadeIn_160ms_ease-out] motion-reduce:animate-none';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  size?: 'small' | 'regular' | 'wide';
  children?: ReactNode;
  footer?: ReactNode;
  /** When true, closing asks to discard changes first. */
  dirty?: boolean;
}

const widths = { small: 'max-w-[440px]', regular: 'max-w-[640px]', wide: 'max-w-[960px]' };

const DiscardGuard = ({ open, onKeep, onDiscard }: { open: boolean; onKeep: () => void; onDiscard: () => void }) => (
  <D.Root open={open} onOpenChange={(o) => !o && onKeep()}>
    <D.Portal>
      <D.Overlay className={cn(overlayCls, 'z-[80]')} />
      <D.Content className="fixed left-1/2 top-1/2 z-[81] w-[calc(100vw-32px)] max-w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-[16px] border border-line bg-surface p-6 shadow-[var(--shadow-overlay)]">
        <D.Title className="text-[18px] font-[650] leading-[26px] text-fg">You have unsaved changes.</D.Title>
        <D.Description className="mt-2 text-[14px] leading-[22px] text-fg-2">Discard them, or keep editing?</D.Description>
        <div className="mt-6 flex justify-end gap-2">
          <Button onClick={onKeep}>Keep Editing</Button>
          <Button variant="danger" onClick={onDiscard}>
            Discard Changes
          </Button>
        </div>
      </D.Content>
    </D.Portal>
  </D.Root>
);

/** Modal dialog (440 / 640 / 960 px), focus-trapped; focus returns to the trigger on close. */
export const Dialog = ({ open, onOpenChange, title, description, size = 'regular', children, footer, dirty }: DialogProps) => {
  const [confirm, setConfirm] = useState(false);
  const request = (o: boolean) => {
    if (!o && dirty) setConfirm(true);
    else onOpenChange(o);
  };
  return (
    <D.Root open={open} onOpenChange={request}>
      <D.Portal>
        <D.Overlay className={overlayCls} />
        <D.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-48px)] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[16px] border border-line bg-surface shadow-[var(--shadow-overlay)]',
            'data-[state=open]:animate-[dialogIn_160ms_ease-out] motion-reduce:animate-none',
            widths[size],
          )}
          aria-describedby={description ? undefined : undefined}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
            <div className="min-w-0">
              <D.Title className="text-[18px] font-[650] leading-[26px] text-fg">{title}</D.Title>
              {description ? <D.Description className="mt-1 text-[14px] leading-[22px] text-fg-2">{description}</D.Description> : <D.Description className="sr-only">{typeof title === 'string' ? title : 'Dialog'}</D.Description>}
            </div>
            <D.Close asChild>
              <button type="button" aria-label="Close" className="rounded-[8px] p-2 text-fg-2 hover:bg-surface-2 hover:text-fg">
                <X size={18} />
              </button>
            </D.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
          {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-line px-6 py-4">{footer}</div> : null}
        </D.Content>
      </D.Portal>
      <DiscardGuard
        open={confirm}
        onKeep={() => setConfirm(false)}
        onDiscard={() => {
          setConfirm(false);
          onOpenChange(false);
        }}
      />
    </D.Root>
  );
};

export interface DrawerProps extends Omit<DialogProps, 'size'> {
  width?: 560 | 760;
  headerActions?: ReactNode;
}

/**
 * Side drawer: 560 or 760 px, full height with sticky header (64) / footer (72) and inner
 * scroll; full-screen on phones. Only closes after a confirmed save (the caller controls open).
 */
export const Drawer = ({ open, onOpenChange, title, description, width = 560, children, footer, dirty, headerActions }: DrawerProps) => {
  const [confirm, setConfirm] = useState(false);
  const request = (o: boolean) => {
    if (!o && dirty) setConfirm(true);
    else onOpenChange(o);
  };
  return (
    <D.Root open={open} onOpenChange={request}>
      <D.Portal>
        <D.Overlay className={overlayCls} />
        <D.Content
          className={cn(
            'fixed inset-y-0 right-0 z-50 flex h-[100dvh] w-full flex-col border-l border-line bg-surface shadow-[var(--shadow-overlay)]',
            'data-[state=open]:animate-[drawerIn_180ms_ease-out] motion-reduce:animate-none',
            width === 560 ? 'md:max-w-[560px]' : 'md:max-w-[760px]',
          )}
        >
          <div className="sticky top-0 flex min-h-16 items-center justify-between gap-3 border-b border-line bg-surface px-6">
            <div className="min-w-0 py-3">
              <D.Title className="truncate text-[18px] font-[650] leading-[26px] text-fg">{title}</D.Title>
              {description ? (
                <D.Description className="truncate text-[12px] leading-[18px] text-fg-2">{description}</D.Description>
              ) : (
                <D.Description className="sr-only">{typeof title === 'string' ? title : 'Panel'}</D.Description>
              )}
            </div>
            <div className="flex items-center gap-1">
              {headerActions}
              <D.Close asChild>
                <button type="button" aria-label="Close" className="rounded-[8px] p-2 text-fg-2 hover:bg-surface-2 hover:text-fg">
                  <X size={18} />
                </button>
              </D.Close>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
          {footer ? (
            <div className="sticky bottom-0 flex min-h-[72px] flex-wrap items-center justify-end gap-2 border-t border-line bg-surface px-6 pb-[max(env(safe-area-inset-bottom),12px)] pt-3">
              {footer}
            </div>
          ) : null}
        </D.Content>
      </D.Portal>
      <DiscardGuard
        open={confirm}
        onKeep={() => setConfirm(false)}
        onDiscard={() => {
          setConfirm(false);
          onOpenChange(false);
        }}
      />
    </D.Root>
  );
};

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Concrete consequences (counts, affected records). */
  body: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  /** Typed confirmation for irreversible bulk actions (e.g. purge). */
  typedConfirmation?: string;
  children?: ReactNode;
  confirmDisabled?: boolean;
}

export const ConfirmDialog = ({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  destructive,
  loading,
  onConfirm,
  typedConfirmation,
  children,
  confirmDisabled,
}: ConfirmDialogProps) => {
  const [typed, setTyped] = useState('');
  const typedOk = !typedConfirmation || typed.trim() === typedConfirmation;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setTyped('');
        onOpenChange(o);
      }}
      title={title}
      size="small"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button variant={destructive ? 'danger' : 'primary'} loading={loading} disabled={!typedOk || confirmDisabled} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-[14px] leading-[22px] text-fg">
        <div>{body}</div>
        {children}
        {typedConfirmation ? (
          <label className="flex flex-col gap-1.5 text-[12px] font-[550] text-fg">
            Type <span className="font-mono">{typedConfirmation}</span> to confirm
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="h-10 rounded-[8px] border border-line bg-surface px-3 font-mono text-[14px] text-fg"
              autoComplete="off"
            />
          </label>
        ) : null}
      </div>
    </Dialog>
  );
};
