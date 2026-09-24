'use client';
import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from './cn';

/**
 * Programmatic SVG charts. Rules (sections 3, 17): at most five series in fixed colour order,
 * missing values are gaps (never zero), a single point shows "No trend yet", tooltips work with
 * mouse and keyboard, a data table is always available, no dual axes.
 */
export interface ChartPoint {
  x: string;
  /** null = unknown / not measured (drawn as a gap). */
  y: number | null;
}
export interface ChartSeries {
  key: string;
  label: string;
  points: ChartPoint[];
}

const COLORS = ['var(--c-chart-1)', 'var(--c-chart-2)', 'var(--c-chart-3)', 'var(--c-chart-4)', 'var(--c-chart-5)'];
export const seriesColor = (i: number) => COLORS[i % COLORS.length]!;

const niceMax = (v: number) => {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = 10 ** exp;
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * base) return m * base;
  return 10 * base;
};

const defaultFormat = (v: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(v);

interface CommonProps {
  title: string;
  unit?: string;
  formatValue?: (v: number) => string;
  formatX?: (x: string) => string;
  height?: number;
  emptyText?: string;
  footer?: ReactNode;
  /** Gridline style (default dashed); analytics dashboards use solid hairlines. */
  gridlines?: 'dashed' | 'solid';
}

const ChartFrame = ({
  title,
  children,
  table,
  legend,
}: {
  title: string;
  children: ReactNode;
  table: ReactNode;
  legend?: ReactNode;
}) => {
  const [showTable, setShowTable] = useState(false);
  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <figcaption className="flex flex-wrap items-center justify-between gap-2">
        <span className="sr-only">{title}</span>
        {legend ?? <span />}
        <button type="button" className="text-[12px] font-medium text-fg-2 underline-offset-2 hover:text-fg hover:underline" onClick={() => setShowTable((s) => !s)} aria-expanded={showTable}>
          {showTable ? 'Show chart' : 'Show table'}
        </button>
      </figcaption>
      {showTable ? table : children}
    </figure>
  );
};

const Legend = ({ series }: { series: { label: string }[] }) =>
  series.length < 2 ? null : (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1" aria-label="Legend">
      {series.map((s, i) => (
        <li key={s.label} className="flex items-center gap-1.5 text-[12px] leading-[18px] text-fg-2">
          <span aria-hidden className="inline-block h-2 w-3 rounded-full" style={{ background: seriesColor(i) }} />
          {s.label}
        </li>
      ))}
    </ul>
  );

const DataTableView = ({ series, xs, fmt, fx, unit }: { series: ChartSeries[]; xs: string[]; fmt: (v: number) => string; fx: (x: string) => string; unit?: string }) => (
  <div className="max-h-[320px] overflow-auto rounded-[8px] border border-line">
    <table className="w-full text-left text-[13px]">
      <thead className="sticky top-0 bg-surface">
        <tr className="border-b border-line">
          <th scope="col" className="px-3 py-2 text-[12px] font-[550] text-fg-2">
            Period
          </th>
          {series.map((s) => (
            <th key={s.key} scope="col" className="px-3 py-2 text-right text-[12px] font-[550] text-fg-2">
              {s.label}
              {unit ? ` (${unit})` : ''}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {xs.map((x) => (
          <tr key={x} className="border-b border-line last:border-b-0">
            <th scope="row" className="px-3 py-1.5 font-normal text-fg">
              {fx(x)}
            </th>
            {series.map((s) => {
              const v = s.points.find((p) => p.x === x)?.y;
              return (
                <td key={s.key} className="px-3 py-1.5 text-right font-mono tabular-nums text-fg">
                  {v === null || v === undefined ? <span className="text-fg-muted">No data</span> : fmt(v)}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export const LineChart = ({ series: rawSeries, title, unit, formatValue, formatX, height = 260, emptyText = 'No data recorded for this period.', gridlines = 'dashed' }: CommonProps & { series: ChartSeries[] }) => {
  const series = rawSeries.slice(0, 5);
  const fmt = formatValue ?? defaultFormat;
  const fx = formatX ?? ((x: string) => x);
  const xs = useMemo(() => [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort(), [series]);
  const known = series.flatMap((s) => s.points.map((p) => p.y).filter((v): v is number => v !== null));
  const [active, setActive] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const clipId = useId();

  if (known.length === 0) return <p className="flex h-[120px] items-center justify-center text-[13px] text-fg-2">{emptyText}</p>;
  if (xs.length === 1) {
    return (
      <div className="flex h-[120px] flex-col items-center justify-center gap-1">
        {series.map((s) => (
          <p key={s.key} className="font-mono text-[22px] font-semibold tabular-nums text-fg">
            {s.points[0]?.y === null || s.points[0]?.y === undefined ? '—' : fmt(s.points[0].y)}
            {unit ? <span className="ml-1 text-[12px] text-fg-2">{unit}</span> : null}
          </p>
        ))}
        <p className="text-[12px] text-fg-2">No trend yet — only one data point in this period.</p>
      </div>
    );
  }

  const W = 640;
  const H = height;
  const pad = { l: 48, r: series.length <= 4 && series.length > 1 ? 92 : 16, t: 12, b: 28 };
  const minV = Math.min(0, ...known);
  const maxV = niceMax(Math.max(...known));
  const x = (i: number) => pad.l + (i * (W - pad.l - pad.r)) / Math.max(1, xs.length - 1);
  const y = (v: number) => pad.t + (1 - (v - minV) / (maxV - minV || 1)) * (H - pad.t - pad.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => minV + t * (maxV - minV));

  const segments = (s: ChartSeries) => {
    const out: string[] = [];
    let cur: string[] = [];
    xs.forEach((xv, i) => {
      const p = s.points.find((pp) => pp.x === xv);
      if (!p || p.y === null) {
        if (cur.length) out.push(cur.join(' '));
        cur = [];
      } else cur.push(`${cur.length ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`);
    });
    if (cur.length) out.push(cur.join(' '));
    return out;
  };

  const pickIndex = (clientX: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const rel = ((clientX - rect.left) / rect.width) * W;
    const i = Math.round(((rel - pad.l) / (W - pad.l - pad.r)) * (xs.length - 1));
    setActive(Math.max(0, Math.min(xs.length - 1, i)));
  };

  const tip =
    active !== null ? (
      <div
        className="pointer-events-none absolute top-2 z-10 min-w-[160px] rounded-[8px] border border-line bg-surface px-3 py-2 text-[12px] shadow-[var(--shadow-overlay)]"
        style={{ left: `min(max(0px, calc(${(x(active) / W) * 100}% - 80px)), calc(100% - 180px))` }}
      >
        <p className="mb-1 font-semibold text-fg">{fx(xs[active]!)}</p>
        {series.map((s, i) => {
          const v = s.points.find((p) => p.x === xs[active!])?.y;
          return (
            <p key={s.key} className="flex items-center justify-between gap-3 text-fg-2">
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: seriesColor(i) }} />
                {s.label}
              </span>
              <span className="font-mono tabular-nums text-fg">{v === null || v === undefined ? 'No data' : `${fmt(v)}${unit ? ` ${unit}` : ''}`}</span>
            </p>
          );
        })}
      </div>
    ) : null;

  return (
    <ChartFrame title={title} legend={<Legend series={series} />} table={<DataTableView series={series} xs={xs} fmt={fmt} fx={fx} unit={unit} />}>
      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full touch-none select-none focus-visible:outline-2 focus-visible:outline-[var(--c-focus)]"
          role="img"
          aria-label={`${title}. Use the left and right arrow keys to read values.`}
          tabIndex={0}
          onPointerMove={(e) => pickIndex(e.clientX)}
          onPointerLeave={() => setActive(null)}
          onFocus={() => setActive((a) => a ?? xs.length - 1)}
          onBlur={() => setActive(null)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') setActive((a) => Math.max(0, (a ?? 0) - 1));
            if (e.key === 'ArrowRight') setActive((a) => Math.min(xs.length - 1, (a ?? -1) + 1));
          }}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={pad.l} y={0} width={W - pad.l - pad.r + 4} height={H} />
            </clipPath>
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--c-line)" strokeWidth={1} strokeDasharray={t === minV || gridlines === 'solid' ? undefined : '2 4'} />
              <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--c-fg-2)">
                {fmt(t)}
              </text>
            </g>
          ))}
          {[0, Math.floor((xs.length - 1) / 2), xs.length - 1].filter((v, i, a) => a.indexOf(v) === i).map((i) => (
            <text key={i} x={x(i)} y={H - 8} textAnchor={i === 0 ? 'start' : i === xs.length - 1 ? 'end' : 'middle'} fontSize={11} fill="var(--c-fg-2)">
              {fx(xs[i]!)}
            </text>
          ))}
          {unit ? (
            <text x={4} y={10} fontSize={10} fill="var(--c-fg-2)">
              {unit}
            </text>
          ) : null}
          <g clipPath={`url(#${clipId})`}>
            {series.map((s, si) =>
              segments(s).map((d, k) => (
                <path key={`${s.key}-${k}`} d={d} fill="none" stroke={seriesColor(si)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              )),
            )}
            {series.map((s, si) =>
              s.points.map((p) => {
                const i = xs.indexOf(p.x);
                if (p.y === null) return null;
                const prev = s.points.find((q) => q.x === xs[i - 1]);
                const next = s.points.find((q) => q.x === xs[i + 1]);
                const isolated = (!prev || prev.y === null) && (!next || next.y === null);
                return isolated || active === i ? (
                  <circle key={`${s.key}-${p.x}`} cx={x(i)} cy={y(p.y)} r={4} fill={seriesColor(si)} stroke="var(--c-surface)" strokeWidth={2} />
                ) : null;
              }),
            )}
          </g>
          {active !== null ? <line x1={x(active)} x2={x(active)} y1={pad.t} y2={H - pad.b} stroke="var(--c-fg-muted)" strokeWidth={1} /> : null}
          {series.length > 1 && series.length <= 4
            ? series.map((s, si) => {
                const last = [...s.points].reverse().find((p) => p.y !== null);
                if (!last || last.y === null) return null;
                return (
                  <text key={s.key} x={x(xs.indexOf(last.x)) + 6} y={y(last.y) + 4} fontSize={11} fill="var(--c-fg-2)">
                    {s.label.length > 12 ? `${s.label.slice(0, 11)}…` : s.label}
                  </text>
                );
              })
            : null}
        </svg>
        {tip}
      </div>
    </ChartFrame>
  );
};

export interface BarDatum {
  key: string;
  label: string;
  /** One value per series key; null = unknown. */
  values: Record<string, number | null>;
  href?: string;
}

export const BarChart = ({
  data,
  series,
  title,
  unit,
  formatValue,
  height = 260,
  stacked = false,
  emptyText = 'No data recorded for this period.',
  onSelect,
  gridlines = 'dashed',
  maxBarWidth = 48,
}: CommonProps & { data: BarDatum[]; series: { key: string; label: string }[]; stacked?: boolean; onSelect?: (d: BarDatum) => void; maxBarWidth?: number }) => {
  const fmt = formatValue ?? defaultFormat;
  const ser = series.slice(0, 5);
  const [active, setActive] = useState<number | null>(null);
  const known = data.flatMap((d) => ser.map((s) => d.values[s.key]).filter((v): v is number => v !== null && v !== undefined));
  if (known.length === 0) return <p className="flex h-[120px] items-center justify-center text-[13px] text-fg-2">{emptyText}</p>;
  const W = 640;
  const H = height;
  const pad = { l: 48, r: 12, t: 12, b: 36 };
  const totals = data.map((d) => ser.reduce((a, s) => a + Math.max(0, d.values[s.key] ?? 0), 0));
  const maxV = niceMax(stacked ? Math.max(...totals) : Math.max(...known));
  const band = (W - pad.l - pad.r) / data.length;
  const barW = Math.max(4, Math.min(maxBarWidth, (band - 8) / (stacked ? 1 : ser.length)));
  const y = (v: number) => pad.t + (1 - v / maxV) * (H - pad.t - pad.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * maxV);

  const table = (
    <DataTableView
      series={ser.map((s) => ({ key: s.key, label: s.label, points: data.map((d) => ({ x: d.label, y: d.values[s.key] ?? null })) }))}
      xs={data.map((d) => d.label)}
      fmt={fmt}
      fx={(x) => x}
      unit={unit}
    />
  );
  return (
    <ChartFrame title={title} legend={<Legend series={ser} />} table={table}>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={title}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--c-line)" strokeWidth={1} strokeDasharray={t === 0 || gridlines === 'solid' ? undefined : '2 4'} />
              <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--c-fg-2)">
                {fmt(t)}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const cx = pad.l + band * i + band / 2;
            let acc = 0;
            return (
              <g
                key={d.key}
                tabIndex={0}
                role="button"
                aria-label={`${d.label}: ${ser.map((s) => `${s.label} ${d.values[s.key] === null || d.values[s.key] === undefined ? 'no data' : fmt(d.values[s.key]!)}`).join(', ')}`}
                onPointerEnter={() => setActive(i)}
                onPointerLeave={() => setActive(null)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                onClick={() => onSelect?.(d)}
                onKeyDown={(e) => e.key === 'Enter' && onSelect?.(d)}
                className={cn(onSelect && 'cursor-pointer', 'focus-visible:outline-none')}
              >
                <rect x={pad.l + band * i} y={pad.t} width={band} height={H - pad.t - pad.b} fill={active === i ? 'var(--c-surface-2)' : 'transparent'} />
                {ser.map((s, si) => {
                  const v = d.values[s.key];
                  if (v === null || v === undefined || v <= 0) return null;
                  const x0 = stacked ? cx - barW / 2 : cx - (barW * ser.length) / 2 + si * barW;
                  const top = stacked ? y(acc + v) : y(v);
                  const bottom = stacked ? y(acc) : y(0);
                  acc += stacked ? v : 0;
                  return (
                    <rect
                      key={s.key}
                      x={x0 + 1}
                      y={top}
                      width={Math.max(2, barW - 2)}
                      height={Math.max(1, bottom - top - (stacked ? 2 : 0))}
                      rx={Math.min(4, barW / 3)}
                      fill={seriesColor(si)}
                    />
                  );
                })}
                <text x={cx} y={H - 16} textAnchor="middle" fontSize={11} fill="var(--c-fg-2)">
                  {d.label.length > 14 ? `${d.label.slice(0, 13)}…` : d.label}
                </text>
              </g>
            );
          })}
        </svg>
        {active !== null && data[active] ? (
          <div className="pointer-events-none absolute right-2 top-2 z-10 min-w-[160px] rounded-[8px] border border-line bg-surface px-3 py-2 text-[12px] shadow-[var(--shadow-overlay)]">
            <p className="mb-1 font-semibold text-fg">{data[active].label}</p>
            {ser.map((s, i) => {
              const v = data[active!]!.values[s.key];
              return (
                <p key={s.key} className="flex items-center justify-between gap-3 text-fg-2">
                  <span className="flex items-center gap-1.5">
                    <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: seriesColor(i) }} />
                    {s.label}
                  </span>
                  <span className="font-mono tabular-nums text-fg">{v === null || v === undefined ? 'No data' : `${fmt(v)}${unit ? ` ${unit}` : ''}`}</span>
                </p>
              );
            })}
          </div>
        ) : null}
      </div>
    </ChartFrame>
  );
};
