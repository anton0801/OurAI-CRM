'use client';
import Link from 'next/link';
import type { AnalyticsChart, AnalyticsTable, MetricValueDto } from '@castlane/api-contracts';
import { Badge, BarChart, LineChart, Panel, formatDate, formatNumber } from '@castlane/ui';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { chartNumber, MetricValueText, NO_DATA } from '../metrics/common';

const UNIT_LABEL: Record<string, string | undefined> = { percent: '%', hours: 'h', seconds: 's', money: undefined, count: undefined, ratio: undefined, score: undefined, number: undefined };

/** Bucket key (ISO date) → short label in the member's zone. */
export const bucketLabel = (x: string) => (/^\d{4}-\d{2}-\d{2}$/.test(x) ? formatDate(x) : x);

export const chartFormatter = (unit: string) => (v: number) =>
  unit === 'percent' ? `${formatNumber(v, { maximumFractionDigits: 1 })}%` : unit === 'money' ? formatNumber(v, { maximumFractionDigits: 0 }) : formatNumber(v, { maximumFractionDigits: unit === 'hours' ? 1 : 2 });

/**
 * One analytics chart (dataviz rules): time series as lines with gaps for unknown buckets, categories
 * as bars; at most five series in the fixed palette order, legend for two or more, table view.
 */
export const AnalyticsChartView = ({ chart }: { chart: AnalyticsChart }) => {
  const series = chart.series.slice(0, 5);
  const allUnknown = chart.points.every((p) => series.every((s) => chartNumber(p.values[s.key]) === null));
  return (
    <Panel title={chart.title} description={chart.description}>
      {allUnknown ? (
        <p className="flex h-[120px] items-center justify-center text-[13px] text-fg-2">{NO_DATA}</p>
      ) : chart.kind === 'line' ? (
        <LineChart
          title={chart.title}
          unit={UNIT_LABEL[chart.unit]}
          gridlines="solid"
          formatValue={chartFormatter(chart.unit)}
          formatX={bucketLabel}
          series={series.map((s) => ({ key: s.key, label: s.label, points: chart.points.map((p) => ({ x: p.x, y: chartNumber(p.values[s.key]) })) }))}
        />
      ) : (
        <BarChart
          title={chart.title}
          unit={UNIT_LABEL[chart.unit]}
          gridlines="solid"
          maxBarWidth={24}
          stacked={chart.kind === 'stacked_bar'}
          formatValue={chartFormatter(chart.unit)}
          series={series.map((s) => ({ key: s.key, label: s.label }))}
          data={chart.points.map((p) => ({ key: p.x, label: chart.xKind === 'time' ? bucketLabel(p.label) : p.label, values: Object.fromEntries(series.map((s) => [s.key, chartNumber(p.values[s.key])])) }))}
        />
      )}
      {chart.note ? <p className="mt-2 text-[12px] text-fg-2">{chart.note}</p> : null}
    </Panel>
  );
};

const TONE: Record<string, 'neutral' | 'warning' | 'danger' | 'success' | 'info'> = { neutral: 'neutral', warning: 'warning', danger: 'danger', success: 'success', info: 'info' };

/** A dashboard table: rows link to their source records; unknown values stay labelled. */
export const AnalyticsTableView = ({ table }: { table: AnalyticsTable }) => {
  const { user } = useWorkspace();
  const wsPath = useWsPath();
  return (
    <Panel title={table.title} description={table.description ?? undefined}>
      {table.rows.length === 0 ? (
        <p className="py-4 text-center text-[13px] text-fg-2">{NO_DATA}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-left text-[13px]">
            <caption className="sr-only">{table.title}</caption>
            <thead>
              <tr className="border-b border-line">
                {table.columns.map((c) => (
                  <th key={c.key} scope="col" className={`py-2 pr-3 font-[550] text-fg-2 ${c.kind === 'metric' ? 'text-right' : ''}`}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r) => (
                <tr key={r.key} className="border-b border-line last:border-b-0">
                  {table.columns.map((c, i) => {
                    const cell = r.cells[c.key];
                    const content =
                      c.kind === 'metric' ? (
                        <MetricValueText value={cell?.value as MetricValueDto | undefined} />
                      ) : c.kind === 'date' ? (
                        cell?.at ? formatDate(cell.at, user.timezone) : <span className="text-fg-muted">—</span>
                      ) : c.kind === 'status' ? (
                        cell?.text ? <Badge tone={TONE[cell.tone ?? 'neutral']}>{cell.text}</Badge> : null
                      ) : (
                        (cell?.text ?? '—')
                      );
                    const href = cell?.href ?? (i === 0 ? r.href : null);
                    return (
                      <td key={c.key} className={`py-2 pr-3 ${c.kind === 'metric' ? 'text-right' : ''}`}>
                        {href ? (
                          <Link href={wsPath(href)} className="text-fg hover:underline">
                            {content}
                          </Link>
                        ) : (
                          content
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {table.note ? <p className="mt-2 text-[12px] text-fg-2">{table.note}</p> : null}
    </Panel>
  );
};
