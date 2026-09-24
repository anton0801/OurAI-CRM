import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { richTextDoc, type RichBlock, type RichTextDocument } from '@castlane/api-contracts';
import { checklistsOf, diffDocs, docToText, normalizeDoc, pinAssetVersions, referencedAssets, wordCount } from './rich-text';

const p = (text: string): RichBlock => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = (...content: RichBlock[]): RichTextDocument => ({ type: 'doc', content });
const A = '11111111-1111-4111-8111-111111111111';
const V = '22222222-2222-4222-8222-222222222222';

describe('rich text normalisation (§14 structured rich text, no HTML)', () => {
  it('strips unknown keys such as raw HTML or scripts at the contract boundary', () => {
    const parsed = richTextDoc.parse({
      type: 'doc',
      content: [{ type: 'paragraph', html: '<script>alert(1)</script>', content: [{ type: 'text', text: 'Hi', onclick: 'x()' }] }],
    });
    expect(JSON.stringify(parsed)).not.toContain('script');
    expect(JSON.stringify(parsed)).not.toContain('onclick');
    expect(() => richTextDoc.parse({ type: 'doc', content: [{ type: 'iframe', src: 'https://evil.test' }] })).toThrow();
  });

  it('rejects unsafe links instead of keeping them', () => {
    const r = normalizeDoc(doc({ type: 'paragraph', content: [{ type: 'text', text: 'click', href: 'javascript:alert(1)' }] }));
    expect(r.issues[0]?.code).toBe('UNSAFE_LINK');
    expect(JSON.stringify(r.doc)).not.toContain('javascript');
    const ok = normalizeDoc(doc({ type: 'paragraph', content: [{ type: 'text', text: 'docs', href: 'https://example.com/a' }] }));
    expect(ok.issues).toHaveLength(0);
  });

  it('merges adjacent runs with the same style, orders marks and drops empty runs', () => {
    const r = normalizeDoc(
      doc({
        type: 'paragraph',
        content: [
          { type: 'text', text: 'a', marks: ['italic', 'bold'] },
          { type: 'text', text: '' },
          { type: 'text', text: 'b', marks: ['bold', 'italic', 'bold'] },
        ],
      }),
    );
    expect(r.doc.content[0]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'ab', marks: ['bold', 'italic'] }] });
  });

  it('removes empty list items, empty lists and trailing empty paragraphs; pads table rows without cutting', () => {
    const r = normalizeDoc(
      doc(
        { type: 'bullet_list', items: [[{ type: 'text', text: ' ' }], [{ type: 'text', text: 'one' }]] },
        { type: 'ordered_list', items: [[]] },
        { type: 'table', header: true, rows: [[[{ type: 'text', text: 'h1' }], [{ type: 'text', text: 'h2' }]], [[{ type: 'text', text: 'c1' }]]] },
        p(''),
        p(''),
      ),
    );
    expect(r.doc.content.map((b) => b.type)).toEqual(['bullet_list', 'table']);
    const t = r.doc.content[1] as Extract<RichBlock, { type: 'table' }>;
    expect(t.rows[1]).toHaveLength(2);
  });

  it('refuses documents over the 200,000 character limit instead of truncating', () => {
    const big = Array.from({ length: 11 }, () => p('x'.repeat(19_000)));
    const r = normalizeDoc(doc(...big));
    expect(r.issues.some((i) => i.code === 'TOO_LONG')).toBe(true);
    expect(r.text.length).toBeGreaterThan(200_000);
  });

  it('extracts text, words, referenced files and checklists', () => {
    const d = doc(
      { type: 'heading', level: 1, content: [{ type: 'text', text: 'Posting rules' }] },
      { type: 'checklist', items: [{ id: 'a', content: [{ type: 'text', text: 'Check caption' }] }, { id: 'b', content: [{ type: 'text', text: 'Check tags' }] }] },
      { type: 'image', assetId: A, alt: 'Example' },
      { type: 'file', assetId: A, label: 'Duplicate reference' },
    );
    expect(docToText(d)).toContain('[ ] Check caption');
    expect(wordCount('Check the caption — twice, please')).toBe(5);
    expect(referencedAssets(d)).toEqual([{ assetId: A, versionId: null, kind: 'image' }]);
    expect(checklistsOf(d)).toEqual([{ blockIndex: 1, items: ['Check caption', 'Check tags'] }]);
    const pinned = pinAssetVersions(d, new Map([[A, V]]));
    expect(referencedAssets(pinned)[0]?.versionId).toBe(V);
  });
});

const blockArb: fc.Arbitrary<RichBlock> = fc.oneof(
  fc.constantFrom('alpha', 'beta', 'gamma', 'delta', 'omega').map((t) => p(t)),
  fc.constantFrom('Intro', 'Rules').map((t): RichBlock => ({ type: 'heading', level: 2, content: [{ type: 'text', text: t }] })),
  fc.constantFrom('one', 'two').map((t): RichBlock => ({ type: 'bullet_list', items: [[{ type: 'text', text: t }]] })),
);
const docArb = fc.array(blockArb, { maxLength: 30 }).map((c) => doc(...c));

describe('version diff summary (Compare)', () => {
  it('reports no changes between identical versions', () => {
    fc.assert(
      fc.property(docArb, (d) => {
        const r = diffDocs(d, d);
        expect(r.added + r.removed + r.changed).toBe(0);
        expect(r.unchanged).toBe(d.content.length);
      }),
    );
  });

  it('accounts for every block on both sides', () => {
    fc.assert(
      fc.property(docArb, docArb, (a, b) => {
        const r = diffDocs(a, b, 10_000);
        expect(r.unchanged + r.removed + r.changed).toBe(a.content.length);
        expect(r.unchanged + r.added + r.changed).toBe(b.content.length);
        expect(r.changes).toHaveLength(r.added + r.removed + r.changed);
      }),
    );
  });

  it('pairs an edited block as changed and keeps the surrounding text unchanged', () => {
    const r = diffDocs(doc(p('alpha'), p('beta'), p('gamma')), doc(p('alpha'), p('beta — revised'), p('gamma'), p('delta')));
    expect(r).toMatchObject({ unchanged: 2, changed: 1, added: 1, removed: 0 });
    expect(r.changes[0]).toEqual({ kind: 'changed', blockType: 'paragraph', before: 'beta', after: 'beta — revised' });
  });
});
