import type { RichInline } from '@castlane/api-contracts';

/**
 * Lightweight inline markup used by the article editor: **bold**, *italic* (or _italic_), `code` and
 * [link text](https://…). It is converted to structured runs before saving — no HTML is ever
 * produced or accepted. A backslash escapes a markup character.
 */
type Mark = NonNullable<RichInline['marks']>[number];

const ESCAPABLE = /[\\*_`[\]()]/g;
const escapeText = (t: string) => t.replace(ESCAPABLE, (m) => `\\${m}`);

const sameStyle = (a: RichInline, b: RichInline) => (a.href ?? '') === (b.href ?? '') && (a.marks ?? []).join() === (b.marks ?? []).join();

export const serializeInlines = (runs: readonly RichInline[]): string =>
  runs
    .reduce<RichInline[]>((acc, r) => {
      const prev = acc[acc.length - 1];
      if (prev && sameStyle(prev, r)) prev.text += r.text;
      else acc.push({ ...r });
      return acc;
    }, [])
    .map((r) => {
      const marks = r.marks ?? [];
      let s = marks.includes('code') ? `\`${r.text.replace(/`/g, "'")}\`` : escapeText(r.text);
      // Bold + italic nests as **_text_** so the markers never run together (***text*** is ambiguous).
      if (marks.includes('italic')) s = marks.includes('bold') ? `_${s}_` : `*${s}*`;
      if (marks.includes('bold')) s = `**${s}**`;
      if (r.href) s = `[${s}](${r.href})`;
      return s;
    })
    .join('');

interface Token {
  kind: 'link' | 'code' | 'bold' | 'italic';
  index: number;
  length: number;
  inner: string;
  href?: string;
}

const PATTERNS: { kind: Token['kind']; re: RegExp }[] = [
  { kind: 'link', re: /\[((?:\\.|[^\]\\])+)\]\((https?:\/\/[^\s)]+)\)/ },
  { kind: 'code', re: /`([^`]+)`/ },
  { kind: 'bold', re: /\*\*((?:\\.|[^*\\])+?)\*\*/ },
  { kind: 'italic', re: /(?<!\*)\*(?!\*)((?:\\.|[^*\\])+?)\*(?!\*)/ },
  // Underscores inside words (snake_case) stay literal.
  { kind: 'italic', re: /(?<![\p{L}\p{N}])_((?:\\.|[^_\\])+?)_(?![\p{L}\p{N}])/u },
];

/** Replace escaped characters by private-use placeholders so patterns ignore them. */
const PLACEHOLDER_BASE = 0xe000;
const protect = (s: string) => s.replace(/\\([\\*_`[\]()])/g, (_m, c: string) => String.fromCharCode(PLACEHOLDER_BASE + c.charCodeAt(0)));
const unprotect = (s: string) => s.replace(/[-]/g, (c) => String.fromCharCode(c.charCodeAt(0) - PLACEHOLDER_BASE));

const nextToken = (s: string): Token | null => {
  let best: Token | null = null;
  for (const p of PATTERNS) {
    const m = p.re.exec(s);
    if (!m) continue;
    if (!best || m.index < best.index || (m.index === best.index && m[0].length > best.length))
      best = { kind: p.kind, index: m.index, length: m[0].length, inner: m[1]!, href: p.kind === 'link' ? m[2] : undefined };
  }
  return best;
};

const parse = (s: string, marks: Mark[], href: string | undefined, out: RichInline[]) => {
  let rest = s;
  while (rest.length) {
    const t = nextToken(rest);
    if (!t) {
      out.push(run(rest, marks, href));
      return;
    }
    if (t.index > 0) out.push(run(rest.slice(0, t.index), marks, href));
    if (t.kind === 'code') out.push(run(t.inner, [...marks, 'code'], href));
    else if (t.kind === 'link') parse(t.inner, marks, t.href, out);
    else parse(t.inner, [...marks, t.kind], href, out);
    rest = rest.slice(t.index + t.length);
  }
};

const ORDER: Mark[] = ['bold', 'italic', 'code'];
const run = (text: string, marks: Mark[], href: string | undefined): RichInline => {
  const ms = ORDER.filter((m) => marks.includes(m));
  return { type: 'text', text: unprotect(text), ...(ms.length ? { marks: ms } : {}), ...(href ? { href } : {}) };
};

/** Parse markup into merged runs (adjacent runs with the same style are joined). */
export const parseInlines = (markup: string): RichInline[] => {
  const out: RichInline[] = [];
  parse(protect(markup), [], undefined, out);
  const merged: RichInline[] = [];
  for (const r of out) {
    if (!r.text) continue;
    const prev = merged[merged.length - 1];
    if (prev && (prev.href ?? '') === (r.href ?? '') && (prev.marks ?? []).join() === (r.marks ?? []).join()) prev.text += r.text;
    else merged.push({ ...r });
  }
  return merged;
};
