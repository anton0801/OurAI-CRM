'use client';
import { forwardRef, useState, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from './cn';
import { controlBase, useFieldControl } from './field';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(props, ref) {
  const { className, ...rest } = useFieldControl(props);
  return <input ref={ref} className={cn(controlBase, 'h-10', className)} {...rest} />;
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Shows a character counter only when the value approaches maxLength (≥ 80 %). */
  showCounterNearLimit?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(props, ref) {
  const { className, maxLength, showCounterNearLimit = true, onChange, value, defaultValue, ...rest } = useFieldControl(props);
  const [len, setLen] = useState(String(value ?? defaultValue ?? '').length);
  const current = value !== undefined ? String(value).length : len;
  const near = maxLength && showCounterNearLimit && current >= maxLength * 0.8;
  return (
    <div className="relative">
      <textarea
        ref={ref}
        maxLength={maxLength}
        value={value}
        defaultValue={defaultValue}
        onChange={(e) => {
          setLen(e.target.value.length);
          onChange?.(e);
        }}
        className={cn(controlBase, 'min-h-[104px] resize-y py-2', className)}
        {...rest}
      />
      {near ? (
        <span className="pointer-events-none absolute bottom-1.5 right-2 text-[12px] text-fg-2" aria-live="polite">
          {current}/{maxLength}
        </span>
      ) : null}
    </div>
  );
});

/**
 * Decimal amount input. Keeps the value as a string (never a float); the parent validates
 * precision against the currency's minor units.
 */
export const AmountInput = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { currency: string }
>(function AmountInput(props, ref) {
  const { currency, className, ...rest } = useFieldControl(props);
  return (
    <div className="relative flex items-center">
      <input
        ref={ref}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        className={cn(controlBase, 'h-10 pr-14 text-right font-mono tabular-nums', className)}
        {...rest}
      />
      <span className="pointer-events-none absolute right-3 font-mono text-[12px] text-fg-2">{currency}</span>
    </div>
  );
});

/** Native date / datetime input with a visible time zone label (date-only and datetime are distinct). */
export const DateInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>>(function DateInput(props, ref) {
  const { className, ...rest } = useFieldControl(props);
  return <input ref={ref} type="date" className={cn(controlBase, 'h-10', className)} {...rest} />;
});

export const DateTimeInput = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { timezone: string }
>(function DateTimeInput(props, ref) {
  const { className, timezone, ...rest } = useFieldControl(props);
  return (
    <div className="flex flex-col gap-1">
      <input ref={ref} type="datetime-local" className={cn(controlBase, 'h-10', className)} {...rest} />
      <span className="text-[12px] leading-[18px] text-fg-2">Time zone: {timezone}</span>
    </div>
  );
});
