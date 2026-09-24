'use client';
import type { ReportConfig, ReportResult } from '@castlane/api-contracts';
import { BarChart, LineChart, Panel, formatDateTime } from '@castlane/ui';
import { useWorkspace } from '@/lib/workspace-context';
import { chartFormatter, bucketLabel } from '../analytics/views';
import { chartNumber, MetricValueText, NO_DATA } from '../metrics/common';

const MAX_SERIES = 5;

type Row = ReportResult['rows'][number];

/**
 * Chart of a report result (dataviz rules): lines only over the Period dimension; bars per category;
 * at most five series — further values are combined into "Other" only when the metric adds up.
 */
const ResultChart = ({ result, config }: { result: ReportResult; config: ReportConfig }) => {
  const dims = result.columns.filter((c) => c.kind === 'dimension');
  const metrics = result.columns.filter((c) => c.kind === 'metric');
  if (config.chart === 'table' || !metrics.length || !result.rows.length) return null;
  const first = metrics[0]!;
  const fmt = chartFormatter(first.unit ?? 'count');
  const unit = first.unit === 'percent' ? '%' : first.unit === 'hours' ? 'h' : undefined;
  const xDim = config.chart === 'line' ? 'period' : (dims.find((d) => d.key !== 'period')?.key ?? dims[0]?.key);
  if (!xDim) return null;
  const splitDim = dims.find((d) => d.key !== xDim)?.key;
  const xs = [...new Set(result.rows.map((r) => r.dims[xDim]?.id ?? r.dims[xDim]?.label ?? ''))];
  const xLabel = (x: string) => {
    const r = result.rows.find((row) => (row.dims[xDim]?.id ?? row.dims[xDim]?.label) === x);
    return xDim === 'period' ? bucketLabel(x) : (r?.dims[xDim]?.label ?? x);
  };
  // Series: one per metric; with a split dimension and one metric, one per split value (top 5 + Other when additive).
  type S = { key: string; label: string; value: (x: string) => number | null };
  let series: S[];
  if (splitDim && metrics.length === 1) {
    const totals = new Map<string, { label: string; sum: number }>();
    for (const r of result.rows) {
      const k = r.dims[splitDim]?.id ?? r.dims[splitDim]?.label ?? '';
      const v = chartNumber(r.values[first.key]) ?? 0;
      totals.set(k, { label: r.dims[splitDim]?.label ?? k, sum: (totals.get(k)?.sum ?? 0) + v });
    }
    const ranked = [...totals.entries()].sort((a, b) => b[1].sum - a[1].sum);
    const additive = first.additive !== false;
    const top = ranked.slice(0, additive && ranked.length > MAX_SERIES ? MAX_SERIES - 1 : MAX_SERIES);
    const rest = additive ? ranked.slice(top.length) : [];
    const cell = (x: string, k: string) => result.rows.find((r) => (r.dims[xDim]?.id ?? r.dims[xDim]?.label) === x && (r.dims[splitDim]?.id ?? r.dims[splitDim]?.label ?? '') === k);
    series = top.map(([k, t]) => ({ key: k || 'none', label: t.label, value: (x: string) => chartNumber(cell(x, k)?.values[first.key]) }));
    if (rest.length)
      series.push({
        key: '__other',
        label: 'Other',
        value: (x: string) => {
          const vals = rest.map(([k]) => chartNumber(cell(x, k)?.values[first.key])).filter((v): v is number => v !== null);
          return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
        },
      });
  } else {
    const byX = (x: string) => result.rows.find((r) => (r.dims[xDim]?.id ?? r.dims[xDim]?.label) === x);
    series = metrics.slice(0, MAX_SERIES).map((m) => ({ key: m.key, label: m.label, value: (x: string) => chartNumber(byX(x)?.values[m.key]) }));
  }
  const title = `${first.label} by ${dims.find((d) => d.key === xDim)?.label ?? xDim}`;
  if (config.chart === 'line')
    return (
      <LineChart
        title={title}
        unit={unit}
        gridlines="solid"
        formatValue={fmt}
        formatX={bucketLabel}
        series={series.map((s) => ({ key: s.key, label: s.label, points: [...xs].sort().map((x) => ({ x, y: s.value(x) })) }))}
      />
    );
  return (
    <BarChart
      title={title}
      unit={unit}
      gridlines="solid"
      maxBarWidth={24}
      stacked={config.chart === 'stacked_bar'}
      formatValue={fmt}
      series={series.map((s) => ({ key: s.key, label: s.label }))}
      data={xs.map((x) => ({ key: x, label: xLabel(x), values: Object.fromEntries(series.map((s) => [s.key, s.value(x)])) }))}
    />
  );
};

/** Result table + chart + formulas and coverage of a report run or snapshot. */
export const ResultView = ({ result, config }: { result: ReportResult; config: ReportConfig }) => {
  const { user } = useWorkspace();
  const dims = result.columns.filter((c) => c.kind === 'dimension');
  const metrics = result.columns.filter((c) => c.kind === 'metric');
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[12px] text-fg-2">
        {result.period.fromDate} – {result.period.toDate} ({result.period.zone}){result.period.elapsedOnly ? ' · unfinished period: elapsed part only' : ''} · as of{' '}
        {formatDateTime(result.asOf, user.timezone)} · {result.scopeSummary}
      </p>
      {config.chart !== 'table' && result.rows.length ? (
        <Panel title="Chart">
          <ResultChart result={result} config={config} />
        </Panel>
      ) : null}
      <Panel title={`Result · ${result.rowCount} row${result.rowCount === 1 ? '' : 's'}${result.truncated ? ` (first ${result.rows.length} shown)` : ''}`}>
        {result.rows.length === 0 ? (
          <p className="py-6 text-center text-[13px] text-fg-2">{NO_DATA}</p>
        ) : (
          <div className="max-h-[560px] overflow-auto">
            <table className="w-full min-w-[480px] text-left text-[13px]">
              <caption className="sr-only">Report result</caption>
              <thead className="sticky top-0 bg-surface">
                <tr className="border-b border-line">
                  {result.columns.map((c) => (
                    <th key={c.key} scope="col" className={`py-2 pr-3 font-[550] text-fg-2 ${c.kind === 'metric' ? 'text-right' : ''}`}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r: Row) => (
                  <tr key={r.key} className="border-b border-line last:border-b-0">
                    {dims.map((d) => (
                      <td key={d.key} className="py-2 pr-3 text-fg">
                        {d.key === 'period' && r.dims[d.key]?.id ? bucketLabel(r.dims[d.key]!.id!) : (r.dims[d.key]?.label ?? '—')}
                      </td>
                    ))}
                    {metrics.map((m) => (
                      <td key={m.key} className="py-2 pr-3 text-right">
                        <MetricValueText value={r.values[m.key]} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-line">
                  <th scope="row" colSpan={Math.max(1, dims.length)} className="py-2 pr-3 font-[550] text-fg">
                    Total
                  </th>
                  {metrics.map((m) => (
                    <td key={m.key} className="py-2 pr-3 text-right font-semibold">
                      <MetricValueText value={result.totals[m.key]} />
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Panel>
      <Panel title="Formulas and coverage">
        <dl className="flex flex-col gap-3 text-[13px]">
          {result.formulas.map((f) => (
            <div key={f.key}>
              <dt className="font-medium text-fg">
                {f.label} ({f.key})
              </dt>
              <dd className="text-fg-2">{f.description}</dd>
            </div>
          ))}
        </dl>
        {result.notes.length ? (
          <ul className="mt-3 flex flex-col gap-1 text-[12px] text-fg-2">
            {result.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : null}
      </Panel>
    </div>
  );
};
