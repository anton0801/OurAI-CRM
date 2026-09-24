'use client';
import { Checkbox as C, RadioGroup as R, Switch as S } from 'radix-ui';
import { Check, Minus } from '@phosphor-icons/react';
import { useId, type ReactNode } from 'react';
import { cn } from './cn';

export const Checkbox = ({
  checked,
  onCheckedChange,
  label,
  disabled,
  id,
  'aria-label': ariaLabel,
  description,
}: {
  checked: boolean | 'indeterminate';
  onCheckedChange: (v: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  description?: ReactNode;
}) => {
  const auto = useId();
  const cid = id ?? auto;
  return (
    <div className="flex items-start gap-2">
      <C.Root
        id={cid}
        checked={checked}
        disabled={disabled}
        aria-label={label ? undefined : ariaLabel}
        onCheckedChange={(v) => onCheckedChange(v === true)}
        className={cn(
          'mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border border-line bg-surface',
          'data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary',
          'text-on-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-focus)] disabled:opacity-50',
          'relative before:absolute before:-inset-3 before:content-[""] md:before:-inset-1',
        )}
      >
        <C.Indicator>{checked === 'indeterminate' ? <Minus size={12} weight="bold" /> : <Check size={12} weight="bold" />}</C.Indicator>
      </C.Root>
      {label ? (
        <label htmlFor={cid} className="flex flex-col text-[14px] leading-[22px] text-fg">
          {label}
          {description ? <span className="text-[12px] leading-[18px] text-fg-2">{description}</span> : null}
        </label>
      ) : null}
    </div>
  );
};

export const Switch = ({
  checked,
  onCheckedChange,
  label,
  disabled,
  description,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
  description?: ReactNode;
}) => {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <label htmlFor={id} className="flex flex-col text-[14px] leading-[22px] text-fg">
        {label}
        {description ? <span className="text-[12px] leading-[18px] text-fg-2">{description}</span> : null}
      </label>
      <S.Root
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        className="relative h-6 w-10 shrink-0 rounded-full border border-line bg-surface-2 transition-colors data-[state=checked]:border-primary data-[state=checked]:bg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-focus)] disabled:opacity-50"
      >
        <S.Thumb className="block h-5 w-5 translate-x-[1px] rounded-full bg-surface shadow transition-transform duration-[120ms] data-[state=checked]:translate-x-[17px] motion-reduce:transition-none" />
      </S.Root>
    </div>
  );
};

export const RadioGroup = <V extends string>({
  value,
  onValueChange,
  options,
  label,
  orientation = 'vertical',
}: {
  value: V;
  onValueChange: (v: V) => void;
  options: { value: V; label: ReactNode; description?: ReactNode; disabled?: boolean }[];
  label: string;
  orientation?: 'vertical' | 'horizontal';
}) => (
  <R.Root
    value={value}
    onValueChange={(v) => onValueChange(v as V)}
    aria-label={label}
    orientation={orientation}
    className={cn('flex gap-3', orientation === 'vertical' ? 'flex-col' : 'flex-row flex-wrap')}
  >
    {options.map((o) => {
      const id = `${label}-${o.value}`.replace(/\s+/g, '-');
      return (
        <div key={o.value} className="flex items-start gap-2">
          <R.Item
            id={id}
            value={o.value}
            disabled={o.disabled}
            className="mt-[3px] flex h-4 w-4 items-center justify-center rounded-full border border-line bg-surface data-[state=checked]:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-focus)] disabled:opacity-50"
          >
            <R.Indicator className="h-2 w-2 rounded-full bg-primary" />
          </R.Item>
          <label htmlFor={id} className="flex flex-col text-[14px] leading-[22px] text-fg">
            {o.label}
            {o.description ? <span className="text-[12px] leading-[18px] text-fg-2">{o.description}</span> : null}
          </label>
        </div>
      );
    })}
  </R.Root>
);
