'use client';
import { cloneElement, createContext, isValidElement, useContext, useId, type ReactElement, type ReactNode } from 'react';

/** Wiring from a Field to the control rendered anywhere inside it (also through Controller wrappers). */
export interface FieldControlProps {
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false' | 'grammar' | 'spelling';
  'aria-required'?: boolean | 'true' | 'false';
}
const FieldContext = createContext<FieldControlProps | null>(null);

/** Merge the surrounding Field's id/aria props into a control; explicit props win. */
export const useFieldControl = <P extends object>(props: P): P => {
  const p = props as P & FieldControlProps;
  const ctx = useContext(FieldContext);
  if (!ctx) return props;
  return {
    ...props,
    id: p.id ?? ctx.id,
    'aria-describedby': p['aria-describedby'] ?? ctx['aria-describedby'],
    'aria-invalid': p['aria-invalid'] ?? ctx['aria-invalid'],
    'aria-required': p['aria-required'] ?? ctx['aria-required'],
  } as P;
};
import { cn } from './cn';

export interface FieldProps {
  label: ReactNode;
  required?: boolean;
  helper?: ReactNode;
  error?: string | null;
  children: ReactElement<Record<string, unknown>>;
  className?: string;
  /** Visually hide the label (it stays available to assistive technology). */
  hideLabel?: boolean;
  id?: string;
}

/**
 * Label above, helper/error below with 6 px gaps. Wires id, aria-describedby and aria-invalid
 * into the control so screen readers announce the error with the field.
 */
export const Field = ({ label, required, helper, error, children, className, hideLabel, id }: FieldProps) => {
  const auto = useId();
  const controlId = id ?? (children.props.id as string | undefined) ?? auto;
  const helperId = `${controlId}-help`;
  const errorId = `${controlId}-error`;
  const describedBy = [error ? errorId : null, helper ? helperId : null].filter(Boolean).join(' ') || undefined;
  const wiring: FieldControlProps = {
    id: controlId,
    'aria-describedby': describedBy,
    'aria-invalid': error ? true : undefined,
    'aria-required': required || undefined,
  };
  // Native elements receive the props directly; custom controls read them from context.
  const control = isValidElement(children) && typeof children.type === 'string' ? cloneElement(children, wiring as Record<string, unknown>) : children;
  return (
    <div className={cn('flex min-w-0 flex-col gap-[6px]', className)}>
      <label htmlFor={controlId} className={cn('text-[12px] font-[550] leading-[18px] text-fg', hideLabel && 'sr-only')}>
        {label}
        {required && (
          <span className="ml-0.5 text-danger" aria-hidden>
            *
          </span>
        )}
      </label>
      <FieldContext.Provider value={wiring}>{control}</FieldContext.Provider>
      {error ? (
        <p id={errorId} className="text-[12px] leading-[18px] text-danger">
          {error}
        </p>
      ) : helper ? (
        <p id={helperId} className="text-[12px] leading-[18px] text-fg-2">
          {helper}
        </p>
      ) : null}
    </div>
  );
};

export const controlBase =
  'w-full min-w-0 rounded-[8px] border border-line bg-surface px-3 text-[14px] leading-[22px] text-fg placeholder:text-fg-muted ' +
  'transition-colors duration-[120ms] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-focus)] ' +
  'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-fg-2 aria-[invalid=true]:border-danger';
