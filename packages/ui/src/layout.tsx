import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from './cn';

export interface Crumb {
  label: string;
  href?: string;
}

/**
 * Page header: breadcrumb 12/18, 8 px gap, title 28/36 weight 650, description 14/22 (max 760 px);
 * at most two primary actions plus a More menu on the right.
 */
export const PageHeader = ({
  title,
  description,
  crumbs,
  actions,
  meta,
}: {
  title: ReactNode;
  description?: ReactNode;
  crumbs?: Crumb[];
  actions?: ReactNode;
  meta?: ReactNode;
}) => (
  <header className="flex flex-col gap-2">
    {crumbs && crumbs.length > 0 ? (
      <nav aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-1 text-[12px] leading-[18px] text-fg-2">
          {crumbs.map((c, i) => (
            <li key={`${c.label}-${i}`} className="flex items-center gap-1">
              {c.href ? (
                <Link href={c.href} className="hover:text-fg hover:underline">
                  {c.label}
                </Link>
              ) : (
                <span aria-current={i === crumbs.length - 1 ? 'page' : undefined}>{c.label}</span>
              )}
              {i < crumbs.length - 1 ? <span aria-hidden>/</span> : null}
            </li>
          ))}
        </ol>
      </nav>
    ) : null}
    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
      <div className="min-w-0">
        <h1 className="break-words text-[24px] font-[650] leading-8 text-fg md:text-[28px] md:leading-9">{title}</h1>
        {meta ? <div className="mt-1 flex flex-wrap items-center gap-2">{meta}</div> : null}
        {description ? <p className="mt-1 max-w-[760px] text-[14px] leading-[22px] text-fg-2">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  </header>
);

export const Panel = ({
  title,
  actions,
  children,
  className,
  bodyClassName,
  description,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  description?: ReactNode;
}) => (
  <section className={cn('min-w-0 rounded-[12px] border border-line bg-surface', className)}>
    {title || actions ? (
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          {title ? <h2 className="text-[16px] font-semibold leading-6 text-fg md:text-[18px] md:leading-[26px]">{title}</h2> : null}
          {description ? <p className="text-[12px] leading-[18px] text-fg-2">{description}</p> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
    ) : null}
    <div className={cn('p-4', bodyClassName)}>{children}</div>
  </section>
);

export const Toolbar = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cn('flex min-h-10 flex-wrap items-center gap-2', className)}>{children}</div>
);

export const DescriptionList = ({ items, columns = 2 }: { items: { label: string; value: ReactNode; hidden?: boolean }[]; columns?: 1 | 2 | 3 }) => (
  <dl className={cn('grid gap-x-6 gap-y-3', columns === 1 && 'grid-cols-1', columns === 2 && 'grid-cols-1 sm:grid-cols-2', columns === 3 && 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3')}>
    {items
      .filter((i) => !i.hidden)
      .map((i) => (
        <div key={i.label} className="min-w-0">
          <dt className="text-[12px] font-[550] leading-[18px] text-fg-2">{i.label}</dt>
          <dd className="mt-0.5 break-words text-[14px] leading-[22px] text-fg">{i.value ?? <span className="text-fg-muted">—</span>}</dd>
        </div>
      ))}
  </dl>
);

export interface Kpi {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  href?: string;
  delta?: { text: string; tone: 'up' | 'down' | 'flat' | 'none' };
}

/** Borderless KPI cells; each links to the exact source records. Values are never decorative. */
export const KpiStrip = ({ items }: { items: Kpi[] }) => (
  <div className="grid grid-cols-2 overflow-hidden rounded-[12px] border border-line bg-surface lg:grid-cols-4">
    {items.map((k, i) => {
      const inner = (
        <>
          <span className="text-[12px] font-[550] leading-[18px] text-fg-2">{k.label}</span>
          {typeof k.value === 'string' && !/\d/.test(k.value) ? (
            // Availability states ("Not applicable", "No data recorded", "—") are words, not numbers.
            <span className="mt-1 text-[16px] font-[550] leading-8 text-fg-2 md:leading-9">{k.value}</span>
          ) : (
            <span className="mt-1 font-mono text-[24px] font-semibold leading-8 tabular-nums text-fg md:text-[28px] md:leading-9">{k.value}</span>
          )}
          {k.delta && k.delta.tone !== 'none' ? (
            <span className={cn('text-[12px] leading-[18px]', k.delta.tone === 'up' ? 'text-primary' : k.delta.tone === 'down' ? 'text-danger' : 'text-fg-2')}>
              {k.delta.text}
            </span>
          ) : null}
          {k.hint ? <span className="text-[12px] leading-[18px] text-fg-2">{k.hint}</span> : null}
        </>
      );
      const cls = cn(
        'flex min-w-0 flex-col px-4 py-3',
        i % 2 === 1 && 'border-l border-line',
        i >= 2 && 'border-t border-line lg:border-t-0',
        i > 0 && 'lg:border-l',
      );
      return k.href ? (
        <Link key={k.label} href={k.href} className={cn(cls, 'hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--c-focus)]')}>
          {inner}
        </Link>
      ) : (
        <div key={k.label} className={cls}>
          {inner}
        </div>
      );
    })}
  </div>
);
