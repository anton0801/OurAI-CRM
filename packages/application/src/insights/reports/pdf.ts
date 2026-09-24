import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import PDFDocument from 'pdfkit';
import { STATUS_LABELS, type MetricValue } from '@castlane/analytics';
import type { ReportSnapshotDetail } from '@castlane/api-contracts';
import { eq } from 'drizzle-orm';
import { workspaces } from '@castlane/database';
import { requirePermission } from '../../core/access';
import { audit } from '../../core/audit';
import { executeSystemCommand } from '../../core/command';
import { dbOf, type QueryContext } from '../../core/context';
import type { Ctx } from '../common';
import { getReportSnapshot } from './reports';

/**
 * PDF export of a report snapshot (§22.2): title, period, scope, as-of, formulas summary, source
 * coverage and page numbers. Charts are not rasterised; the table carries every value, and
 * unknown values stay distinct from zero.
 */

interface Fonts {
  regular: string | null;
  bold: string | null;
}

let cachedFonts: Fonts | null = null;

/** Unicode fonts (Latin + Cyrillic): Geist from the web app, else DejaVu, else the built-in Helvetica. */
const resolveFonts = (): Fonts => {
  if (cachedFonts) return cachedFonts;
  const candidates: [string, string][] = [];
  if (process.env.PDF_FONT_REGULAR && process.env.PDF_FONT_BOLD) candidates.push([process.env.PDF_FONT_REGULAR, process.env.PDF_FONT_BOLD]);
  const cwd = process.cwd();
  for (const base of [cwd, join(cwd, 'apps/web'), join(cwd, '../web'), join(cwd, '../../apps/web')]) {
    try {
      const pkg = createRequire(join(base, 'noop.js')).resolve('geist/package.json');
      const dir = join(dirname(pkg), 'dist/fonts/geist-sans');
      candidates.push([join(dir, 'Geist-Regular.ttf'), join(dir, 'Geist-SemiBold.ttf')]);
    } catch {
      /* not installed here */
    }
  }
  candidates.push(['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf']);
  const found = candidates.find(([r, b]) => existsSync(r) && existsSync(b));
  cachedFonts = found ? { regular: found[0], bold: found[1] } : { regular: null, bold: null };
  return cachedFonts;
};

const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

export const formatMetricForPdf = (v: MetricValue | undefined): string => {
  if (!v) return 'No data';
  if (v.value === null) return v.status === 'no_data' ? 'No data' : STATUS_LABELS[v.status] || 'No data';
  const n = Number(v.value);
  const num = Number.isFinite(n) ? nf.format(n) : v.value;
  const unit = v.unit === 'percent' ? ' %' : v.unit === 'hours' ? ' h' : v.unit === 'seconds' ? ' s' : v.unit === 'money' ? ` ${v.currency ?? ''}` : '';
  return `${num}${unit}${v.status === 'partial' ? ' (partial)' : ''}`.trim();
};

const coverageText = (v: MetricValue) =>
  [
    v.sampleSize !== undefined ? `sample ${v.sampleSize}` : null,
    v.coverage ? `coverage ${v.coverage.usable} of ${v.coverage.expected}` : null,
    ...(v.excluded ?? []).map((e) => `excluded ${e.count}: ${e.reason}`),
    v.missing?.length ? `missing: ${v.missing.join(', ')}` : null,
    v.note ?? null,
  ]
    .filter(Boolean)
    .join(' · ');

export const renderSnapshotPdf = (s: ReportSnapshotDetail, workspaceName: string): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const fonts = resolveFonts();
    const doc = new PDFDocument({ size: 'A4', margins: { top: 48, bottom: 56, left: 44, right: 44 }, bufferPages: true, info: { Title: s.reportName, Author: 'Castlane CRM', Subject: 'Report snapshot' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const regular = () => doc.font(fonts.regular ?? 'Helvetica');
    const bold = () => doc.font(fonts.bold ?? 'Helvetica-Bold');
    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    const ensure = (h: number) => {
      if (doc.y + h > bottom()) doc.addPage();
    };
    const muted = '#526458';
    const ink = '#17251d';

    bold().fontSize(18).fillColor(ink).text(s.reportName, left, doc.y, { width });
    regular().fontSize(10).fillColor(muted).text(`${workspaceName} · Report snapshot (configuration v${s.configVersion})`, { width });
    doc.moveDown(0.8);
    const meta: [string, string][] = [
      ['Period', `${s.result.period.fromDate} – ${s.result.period.toDate} (${s.result.period.zone})${s.result.period.elapsedOnly ? ', unfinished period: elapsed part only' : ''}`],
      ['As of', `${s.asOf.replace('T', ' ').slice(0, 16)} UTC`],
      ['Generated for', s.generatedFor.displayName],
      ['Scope', s.result.scopeSummary],
    ];
    for (const [k, v] of meta) {
      ensure(28);
      bold().fontSize(9).fillColor(muted).text(k.toUpperCase(), left, doc.y, { width });
      regular().fontSize(10).fillColor(ink).text(v, { width });
      doc.moveDown(0.4);
    }
    if (s.stale) {
      ensure(20);
      bold().fontSize(10).fillColor('#875312').text('Updated source data is available. Refresh this report.', { width });
      doc.moveDown(0.4);
    }

    // Formulas and coverage.
    doc.moveDown(0.4);
    bold().fontSize(12).fillColor(ink).text('Metrics, formulas and coverage', left, doc.y, { width });
    doc.moveDown(0.3);
    for (const f of s.result.formulas) {
      const total = s.result.totals[f.key];
      const line = `${f.label}: ${formatMetricForPdf(total)}`;
      const cov = total ? coverageText(total) : '';
      ensure(doc.heightOfString(f.description, { width }) + 34);
      bold().fontSize(10).fillColor(ink).text(line, left, doc.y, { width });
      regular().fontSize(9).fillColor(muted).text(f.description, { width });
      if (cov) regular().fontSize(9).fillColor(muted).text(`Coverage: ${cov}`, { width });
      doc.moveDown(0.4);
    }

    // Result table.
    const cols = s.result.columns;
    const dimCols = cols.filter((c) => c.kind === 'dimension');
    const metricCols = cols.filter((c) => c.kind === 'metric');
    const dimW = dimCols.length ? Math.min(160, (width * 0.45) / dimCols.length) : 0;
    const metW = metricCols.length ? (width - dimW * dimCols.length) / metricCols.length : 0;
    const widths = cols.map((c) => (c.kind === 'dimension' ? dimW : metW));
    const header = () => {
      ensure(30);
      let x = left;
      const y = doc.y;
      bold().fontSize(8).fillColor(muted);
      cols.forEach((c, i) => {
        doc.text(c.label, x + 2, y, { width: widths[i]! - 4, align: c.kind === 'metric' ? 'right' : 'left', height: 22, ellipsis: true });
        x += widths[i]!;
      });
      doc.y = y + 24;
      doc.strokeColor('#d9e2dc').lineWidth(0.5).moveTo(left, doc.y - 2).lineTo(left + width, doc.y - 2).stroke();
    };
    doc.moveDown(0.6);
    bold().fontSize(12).fillColor(ink).text(`Result (${s.result.rowCount} row${s.result.rowCount === 1 ? '' : 's'}${s.result.truncated ? `, first ${s.result.rows.length} shown` : ''})`, left, doc.y, { width });
    doc.moveDown(0.3);
    if (!s.result.rows.length) {
      regular().fontSize(10).fillColor(muted).text('No data recorded for this period.', { width });
    } else {
      header();
      for (const r of s.result.rows) {
        const texts = cols.map((c) => (c.kind === 'dimension' ? (r.dims[c.key]?.label ?? '') : formatMetricForPdf(r.values[c.key])));
        regular().fontSize(8.5);
        const h = Math.max(14, ...texts.map((t, i) => doc.heightOfString(t, { width: widths[i]! - 4 }))) + 4;
        if (doc.y + h > bottom()) {
          doc.addPage();
          header();
        }
        const y = doc.y;
        let x = left;
        texts.forEach((t, i) => {
          doc.fillColor(ink).text(t, x + 2, y, { width: widths[i]! - 4, align: cols[i]!.kind === 'metric' ? 'right' : 'left' });
          x += widths[i]!;
        });
        doc.y = y + h;
        doc.strokeColor('#eef2ef').lineWidth(0.5).moveTo(left, doc.y - 2).lineTo(left + width, doc.y - 2).stroke();
      }
    }
    if (s.result.notes.length) {
      doc.moveDown(0.6);
      for (const n of s.result.notes) {
        ensure(24);
        regular().fontSize(9).fillColor(muted).text(n, left, doc.y, { width });
      }
    }
    ensure(24);
    doc.moveDown(0.6);
    regular().fontSize(8).fillColor(muted).text('Unknown values are shown as "No data" (never as 0). Rates are weighted ratios, not averages of percentages.', left, doc.y, { width });

    // Page numbers.
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      // Writing into the bottom margin must not start a new page.
      const margin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      regular()
        .fontSize(8)
        .fillColor(muted)
        .text(`Page ${i - range.start + 1} of ${range.count}`, left, doc.page.height - margin + 20, { width, align: 'right', lineBreak: false });
      doc.page.margins.bottom = margin;
    }
    doc.end();
  });

/** PDF download of the member's own snapshot (exports.download is required: a file cannot be revoked). */
export const reportSnapshotPdf = async (ctx: Ctx, id: string) => {
  requirePermission(ctx, 'exports.download');
  const snapshot = await getReportSnapshot(ctx, id);
  const [w] = await dbOf(ctx).select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, ctx.actor.workspaceId));
  const body = await renderSnapshotPdf(snapshot, w?.name ?? 'Workspace');
  await executeSystemCommand(ctx as QueryContext, (c) =>
    audit(c, { action: 'report_snapshot.pdf_downloaded', entityType: 'report_snapshot', entityId: id, sensitivity: 'normal' }),
  );
  const safeName = snapshot.reportName.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'report';
  return { body, fileName: `${safeName}-${snapshot.asOf.slice(0, 10)}.pdf` };
};
