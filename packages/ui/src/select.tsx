'use client';
import { Popover } from 'radix-ui';
import { CaretDown, Check, MagnifyingGlass, X } from '@phosphor-icons/react';
import { forwardRef, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from './cn';
import { controlBase, useFieldControl } from './field';

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  description?: string;
  disabled?: boolean;
  icon?: ReactNode;
}

interface BaseProps<V extends string> {
  options: SelectOption<V>[];
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  'aria-label'?: string;
  /** Show the search box regardless of option count (default: when more than 8 options). */
  searchable?: boolean;
  emptyText?: string;
  clearable?: boolean;
}

export interface SelectProps<V extends string> extends BaseProps<V> {
  value: V | null | undefined;
  onChange: (v: V | null) => void;
}

export interface MultiSelectProps<V extends string> extends BaseProps<V> {
  value: V[];
  onChange: (v: V[]) => void;
  max?: number;
}

const useListNavigation = <V extends string>(options: SelectOption<V>[], query: string) => {
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q) || o.description?.toLowerCase().includes(q)) : options;
  }, [options, query]);
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [query]);
  return { filtered, active, setActive };
};

const OptionList = <V extends string>({
  listId,
  filtered,
  active,
  setActive,
  isSelected,
  onPick,
  emptyText,
}: {
  listId: string;
  filtered: SelectOption<V>[];
  active: number;
  setActive: (n: number) => void;
  isSelected: (v: V) => boolean;
  onPick: (o: SelectOption<V>) => void;
  emptyText: string;
}) => {
  const ref = useRef<HTMLUListElement>(null);
  useEffect(() => {
    ref.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  return (
    <ul ref={ref} id={listId} role="listbox" className="max-h-[272px] overflow-y-auto py-1" aria-multiselectable={undefined}>
      {filtered.length === 0 && <li className="px-3 py-2 text-[13px] text-fg-2">{emptyText}</li>}
      {filtered.map((o, i) => (
        <li
          key={o.value}
          id={`${listId}-${i}`}
          data-index={i}
          role="option"
          aria-selected={isSelected(o.value)}
          aria-disabled={o.disabled || undefined}
          onMouseEnter={() => setActive(i)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => !o.disabled && onPick(o)}
          className={cn(
            'mx-1 flex cursor-pointer items-start gap-2 rounded-[6px] px-2 py-1.5 text-[13px] leading-5 text-fg',
            i === active && 'bg-surface-2',
            o.disabled && 'cursor-not-allowed opacity-50',
          )}
        >
          <span className="mt-0.5 w-4 shrink-0 text-primary">{isSelected(o.value) ? <Check size={14} weight="bold" /> : null}</span>
          {o.icon}
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{o.label}</span>
            {o.description ? <span className="truncate text-[12px] leading-[18px] text-fg-2">{o.description}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
};

function useSelectCore<V extends string>(options: SelectOption<V>[], searchable?: boolean) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const nav = useListNavigation(options, query);
  const listId = useId();
  const showSearch = searchable ?? options.length > 8;
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);
  return { open, setOpen, query, setQuery, listId, showSearch, ...nav };
}

type TriggerProps = { children: ReactNode; open: boolean; listId: string; className?: string } & Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'className'
>;

const Trigger = forwardRef<HTMLButtonElement, TriggerProps>(
  function Trigger({ children, open, listId, className, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-haspopup="listbox"
        className={cn(controlBase, 'flex h-10 items-center justify-between gap-2 text-left', className)}
        {...rest}
      >
        {children}
        <CaretDown size={14} className="shrink-0 text-fg-2" aria-hidden />
      </button>
    );
  },
);

export function Select<V extends string>(rawProps: SelectProps<V>) {
  const props = useFieldControl(rawProps);
  const { options, value, onChange, placeholder = 'Select…', disabled, className, emptyText = 'No matches', clearable } = props;
  const s = useSelectCore(options, props.searchable);
  const selected = options.find((o) => o.value === value);
  const pick = (o: SelectOption<V>) => {
    onChange(o.value);
    s.setOpen(false);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!s.open) s.setOpen(true);
      else s.setActive(Math.min(s.filtered.length - 1, s.active + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      s.setActive(Math.max(0, s.active - 1));
    } else if (e.key === 'Enter' && s.open) {
      e.preventDefault();
      const o = s.filtered[s.active];
      if (o && !o.disabled) pick(o);
    }
  };
  return (
    <Popover.Root open={s.open} onOpenChange={s.setOpen}>
      <Popover.Anchor asChild>
        <div className="relative w-full">
          <Popover.Trigger asChild disabled={disabled}>
            <Trigger
              open={s.open}
              listId={s.listId}
              id={props.id}
              className={className}
              aria-describedby={props['aria-describedby']}
              aria-invalid={props['aria-invalid']}
              aria-label={props['aria-label']}
              onKeyDown={onKeyDown}
              aria-activedescendant={s.open ? `${s.listId}-${s.active}` : undefined}
            >
              <span className={cn('flex min-w-0 items-center gap-2 truncate', !selected && 'text-fg-muted')}>
                {selected?.icon}
                {selected?.label ?? placeholder}
              </span>
            </Trigger>
          </Popover.Trigger>
          {clearable && selected && !disabled ? (
            <button
              type="button"
              aria-label="Clear selection"
              className="absolute right-8 top-1/2 -translate-y-1/2 rounded p-1 text-fg-2 hover:text-fg"
              onClick={() => onChange(null)}
            >
              <X size={12} />
            </button>
          ) : null}
        </div>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          collisionPadding={8}
          onOpenAutoFocus={(e) => {
            if (!s.showSearch) e.preventDefault();
          }}
          className="z-[60] w-[var(--radix-popover-trigger-width)] min-w-[220px] max-w-[min(420px,calc(100vw-16px))] overflow-hidden rounded-[8px] border border-line bg-surface shadow-[var(--shadow-overlay)]"
          onKeyDown={onKeyDown}
        >
          {s.showSearch && (
            <div className="flex items-center gap-2 border-b border-line px-3">
              <MagnifyingGlass size={14} className="text-fg-2" aria-hidden />
              <input
                autoFocus
                value={s.query}
                onChange={(e) => s.setQuery(e.target.value)}
                placeholder="Search"
                aria-label="Search options"
                aria-controls={s.listId}
                className="h-9 w-full bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-muted"
              />
            </div>
          )}
          <OptionList
            listId={s.listId}
            filtered={s.filtered}
            active={s.active}
            setActive={s.setActive}
            isSelected={(v) => v === value}
            onPick={pick}
            emptyText={emptyText}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function MultiSelect<V extends string>(rawProps: MultiSelectProps<V>) {
  const props = useFieldControl(rawProps);
  const { options, value, onChange, placeholder = 'Select…', disabled, className, emptyText = 'No matches', max } = props;
  const s = useSelectCore(options, props.searchable);
  const toggle = (o: SelectOption<V>) => {
    if (value.includes(o.value)) onChange(value.filter((v) => v !== o.value));
    else if (!max || value.length < max) onChange([...value, o.value]);
  };
  const labels = options.filter((o) => value.includes(o.value)).map((o) => o.label);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!s.open) s.setOpen(true);
      else s.setActive(Math.min(s.filtered.length - 1, s.active + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      s.setActive(Math.max(0, s.active - 1));
    } else if (e.key === 'Enter' && s.open) {
      e.preventDefault();
      const o = s.filtered[s.active];
      if (o && !o.disabled) toggle(o);
    }
  };
  return (
    <Popover.Root open={s.open} onOpenChange={s.setOpen}>
      <Popover.Trigger asChild disabled={disabled}>
        <Trigger
          open={s.open}
          listId={s.listId}
          id={props.id}
          className={className}
          aria-describedby={props['aria-describedby']}
          aria-invalid={props['aria-invalid']}
          aria-label={props['aria-label']}
          onKeyDown={onKeyDown}
        >
          <span className={cn('min-w-0 truncate', labels.length === 0 && 'text-fg-muted')}>
            {labels.length === 0 ? placeholder : labels.length <= 2 ? labels.join(', ') : `${labels.length} selected`}
          </span>
        </Trigger>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          collisionPadding={8}
          onKeyDown={onKeyDown}
          className="z-[60] w-[var(--radix-popover-trigger-width)] min-w-[220px] max-w-[min(420px,calc(100vw-16px))] overflow-hidden rounded-[8px] border border-line bg-surface shadow-[var(--shadow-overlay)]"
        >
          {s.showSearch && (
            <div className="flex items-center gap-2 border-b border-line px-3">
              <MagnifyingGlass size={14} className="text-fg-2" aria-hidden />
              <input
                autoFocus
                value={s.query}
                onChange={(e) => s.setQuery(e.target.value)}
                placeholder="Search"
                aria-label="Search options"
                className="h-9 w-full bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-muted"
              />
            </div>
          )}
          <OptionList
            listId={s.listId}
            filtered={s.filtered}
            active={s.active}
            setActive={s.setActive}
            isSelected={(v) => value.includes(v)}
            onPick={toggle}
            emptyText={emptyText}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
