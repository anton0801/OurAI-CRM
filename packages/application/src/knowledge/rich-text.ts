import type { RichBlock, RichInline, RichTextDocument } from '@castlane/api-contracts';
import { isSafeUrl, LIMITS } from '@castlane/domain';

/**
 * Structured rich text (§14): headings 1–3, paragraphs, bullet/ordered lists, checklists, tables,
 * quotes, safe links, images and attached files. There is no HTML anywhere: the contract strips
 * unknown keys, and this module normalises and validates what is left. Pure functions only.
 */

export interface RichTextIssue {
  field: string;
  code: string;
  message: string;
}

const MARK_ORDER = ['bold', 'italic', 'code'] as const;

const sameStyle = (a: RichInline, b: RichInline) => (a.href ?? '') === (b.href ?? '') && (a.marks ?? []).join() === (b.marks ?? []).join();

/** Drop empty runs, order/dedupe marks, validate links, merge adjacent runs with the same style. */
export const normalizeInlines = (runs: readonly RichInline[], path: string, issues: RichTextIssue[]): RichInline[] => {
  const out: RichInline[] = [];
  for (const r of runs) {
    if (!r.text) continue;
    const marks = MARK_ORDER.filter((m) => r.marks?.includes(m));
    const href = r.href?.trim() || undefined;
    if (href && !isSafeUrl(href)) {
      issues.push({ field: path, code: 'UNSAFE_LINK', message: 'Links must be complete http:// or https:// addresses.' });
      continue;
    }
    const next: RichInline = { type: 'text', text: r.text.replace(/\r\n?/g, '\n'), ...(marks.length ? { marks: [...marks] } : {}), ...(href ? { href } : {}) };
    const prev = out[out.length - 1];
    if (prev && sameStyle(prev, next)) prev.text += next.text;
    else out.push(next);
  }
  return out;
};

export const inlineText = (runs: readonly RichInline[]): string => runs.map((r) => r.text).join('');

const hasText = (runs: readonly RichInline[]) => inlineText(runs).trim().length > 0;

/**
 * Normalise a document. Empty paragraphs at the end, empty list items and empty lists are
 * removed; table rows are padded to the widest row (never cut). Returns issues instead of
 * silently dropping unsafe content.
 */
export const normalizeDoc = (doc: RichTextDocument): { doc: RichTextDocument; text: string; issues: RichTextIssue[] } => {
  const issues: RichTextIssue[] = [];
  const content: RichBlock[] = [];
  doc.content.forEach((b, i) => {
    const path = `body.content.${i}`;
    switch (b.type) {
      case 'heading':
      case 'paragraph':
      case 'quote': {
        const c = normalizeInlines(b.content, path, issues);
        if (b.type !== 'paragraph' && !hasText(c)) return;
        content.push({ ...b, content: c });
        return;
      }
      case 'bullet_list':
      case 'ordered_list': {
        const items = b.items.map((it, j) => normalizeInlines(it, `${path}.items.${j}`, issues)).filter(hasText);
        if (items.length) content.push({ type: b.type, items });
        return;
      }
      case 'checklist': {
        const seen = new Set<string>();
        const items = b.items
          .map((it, j) => {
            let id = it.id.trim() || `item-${j + 1}`;
            while (seen.has(id)) id = `${id}-${j + 1}`;
            seen.add(id);
            return { id, content: normalizeInlines(it.content, `${path}.items.${j}`, issues) };
          })
          .filter((it) => hasText(it.content));
        if (items.length) content.push({ type: 'checklist', items });
        return;
      }
      case 'table': {
        const rows = b.rows.map((r, j) => r.map((cell, k) => normalizeInlines(cell, `${path}.rows.${j}.${k}`, issues)));
        const width = Math.max(...rows.map((r) => r.length));
        const padded = rows.map((r) => (r.length < width ? [...r, ...Array.from({ length: width - r.length }, () => [] as RichInline[])] : r));
        if (padded.some((r) => r.some(hasText))) content.push({ type: 'table', header: b.header, rows: padded });
        return;
      }
      case 'image':
        content.push({ type: 'image', assetId: b.assetId, ...(b.versionId ? { versionId: b.versionId } : {}), alt: b.alt.trim(), ...(b.caption?.trim() ? { caption: b.caption.trim() } : {}) });
        return;
      case 'file':
        content.push({ type: 'file', assetId: b.assetId, ...(b.versionId ? { versionId: b.versionId } : {}), ...(b.label?.trim() ? { label: b.label.trim() } : {}) });
        return;
    }
  });
  while (content.length) {
    const last = content[content.length - 1]!;
    if (last.type === 'paragraph' && !hasText(last.content)) content.pop();
    else break;
  }
  const out: RichTextDocument = { type: 'doc', content };
  const text = docToText(out);
  if (text.length > LIMITS.richTextMax)
    issues.push({ field: 'body', code: 'TOO_LONG', message: `The article is longer than ${LIMITS.richTextMax.toLocaleString('en-US')} characters. Split it into several articles.` });
  return { doc: out, text, issues };
};

/** Plain text of one block (search, diff, word counts). */
export const blockText = (b: RichBlock): string => {
  switch (b.type) {
    case 'heading':
    case 'paragraph':
    case 'quote':
      return inlineText(b.content);
    case 'bullet_list':
      return b.items.map((it) => `• ${inlineText(it)}`).join('\n');
    case 'ordered_list':
      return b.items.map((it, i) => `${i + 1}. ${inlineText(it)}`).join('\n');
    case 'checklist':
      return b.items.map((it) => `[ ] ${inlineText(it.content)}`).join('\n');
    case 'table':
      return b.rows.map((r) => r.map(inlineText).join(' | ')).join('\n');
    case 'image':
      return [b.alt, b.caption].filter(Boolean).join(' — ');
    case 'file':
      return b.label ?? '';
  }
};

export const docToText = (doc: RichTextDocument): string =>
  doc.content
    .map(blockText)
    .filter((t) => t.length > 0)
    .join('\n');

export const wordCount = (text: string): number => (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;

/** Files referenced by the body (images and file blocks), in order, without duplicates. */
export const referencedAssets = (doc: RichTextDocument): { assetId: string; versionId: string | null; kind: 'image' | 'file' }[] => {
  const seen = new Set<string>();
  const out: { assetId: string; versionId: string | null; kind: 'image' | 'file' }[] = [];
  for (const b of doc.content)
    if ((b.type === 'image' || b.type === 'file') && !seen.has(b.assetId)) {
      seen.add(b.assetId);
      out.push({ assetId: b.assetId, versionId: b.versionId ?? null, kind: b.type });
    }
  return out;
};

/** Checklist blocks with their position (for Create Task from Checklist). */
export const checklistsOf = (doc: RichTextDocument): { blockIndex: number; items: string[] }[] =>
  doc.content.flatMap((b, i) => (b.type === 'checklist' ? [{ blockIndex: i, items: b.items.map((it) => inlineText(it.content).trim()).filter(Boolean) }] : []));

/** Pin image/file blocks to a stored version when a version is published. */
export const pinAssetVersions = (doc: RichTextDocument, current: Map<string, string>): RichTextDocument => ({
  type: 'doc',
  content: doc.content.map((b) => ((b.type === 'image' || b.type === 'file') && !b.versionId && current.has(b.assetId) ? { ...b, versionId: current.get(b.assetId)! } : b)),
});

// ——— Diff summary (Compare) ———

export interface DiffChange {
  kind: 'added' | 'removed' | 'changed';
  blockType: string;
  before: string | null;
  after: string | null;
}

export interface DiffResult {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  changes: DiffChange[];
}

const signature = (b: RichBlock) => `${b.type}${b.type === 'heading' ? b.level : ''}\u0000${blockText(b)}\u0000${b.type === 'image' || b.type === 'file' ? b.assetId : ''}`;

type Op = { op: 'eq' | 'del' | 'ins'; a?: RichBlock; b?: RichBlock };

/** Longest-common-subsequence edit script; the middle section is bounded to keep memory small. */
const editScript = (a: RichBlock[], b: RichBlock[]): Op[] => {
  const sa = a.map(signature);
  const sb = b.map(signature);
  let start = 0;
  while (start < a.length && start < b.length && sa[start] === sb[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && sa[endA - 1] === sb[endB - 1]) {
    endA--;
    endB--;
  }
  const ops: Op[] = [];
  for (let i = 0; i < start; i++) ops.push({ op: 'eq', a: a[i], b: b[i] });
  const n = endA - start;
  const m = endB - start;
  if (n * m <= 4_000_000) {
    // dp[i][j] = LCS length of a[start+i..endA) and b[start+j..endB)
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) dp[i]![j] = sa[start + i] === sb[start + j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (sa[start + i] === sb[start + j]) {
        ops.push({ op: 'eq', a: a[start + i], b: b[start + j] });
        i++;
        j++;
      } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) ops.push({ op: 'del', a: a[start + i++] });
      else ops.push({ op: 'ins', b: b[start + j++] });
    }
    while (i < n) ops.push({ op: 'del', a: a[start + i++] });
    while (j < m) ops.push({ op: 'ins', b: b[start + j++] });
  } else {
    for (let i = start; i < endA; i++) ops.push({ op: 'del', a: a[i] });
    for (let j = start; j < endB; j++) ops.push({ op: 'ins', b: b[j] });
  }
  for (let i = endA, j = endB; i < a.length; i++, j++) ops.push({ op: 'eq', a: a[i], b: b[j] });
  return ops;
};

/**
 * Block-level diff between two versions: runs of removed blocks followed by added blocks are
 * paired into "changed" when the block types match.
 */
export const diffDocs = (before: RichTextDocument, after: RichTextDocument, limit = 200): DiffResult & { truncated: boolean } => {
  const ops = editScript(before.content, after.content);
  const changes: DiffChange[] = [];
  let added = 0;
  let removed = 0;
  let changed = 0;
  let unchanged = 0;
  let i = 0;
  while (i < ops.length) {
    const op = ops[i]!;
    if (op.op === 'eq') {
      unchanged++;
      i++;
      continue;
    }
    const dels: RichBlock[] = [];
    const ins: RichBlock[] = [];
    while (i < ops.length && ops[i]!.op !== 'eq') {
      const o = ops[i]!;
      if (o.op === 'del') dels.push(o.a!);
      else ins.push(o.b!);
      i++;
    }
    let k = 0;
    for (; k < Math.min(dels.length, ins.length); k++) {
      if (dels[k]!.type === ins[k]!.type) {
        changed++;
        changes.push({ kind: 'changed', blockType: ins[k]!.type, before: blockText(dels[k]!), after: blockText(ins[k]!) });
      } else {
        removed++;
        added++;
        changes.push({ kind: 'removed', blockType: dels[k]!.type, before: blockText(dels[k]!), after: null });
        changes.push({ kind: 'added', blockType: ins[k]!.type, before: null, after: blockText(ins[k]!) });
      }
    }
    for (let d = k; d < dels.length; d++) {
      removed++;
      changes.push({ kind: 'removed', blockType: dels[d]!.type, before: blockText(dels[d]!), after: null });
    }
    for (let d = k; d < ins.length; d++) {
      added++;
      changes.push({ kind: 'added', blockType: ins[d]!.type, before: null, after: blockText(ins[d]!) });
    }
  }
  return { added, removed, changed, unchanged, changes: changes.slice(0, limit), truncated: changes.length > limit };
};
