import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { RichInline } from '@castlane/api-contracts';
import { parseInlines, serializeInlines } from './inline-markup';

describe('editor inline markup', () => {
  it('parses bold, italic, code and links into structured runs', () => {
    expect(parseInlines('Use **bold** and _italic_, `code` and [the guide](https://example.com/g).')).toEqual([
      { type: 'text', text: 'Use ' },
      { type: 'text', text: 'bold', marks: ['bold'] },
      { type: 'text', text: ' and ' },
      { type: 'text', text: 'italic', marks: ['italic'] },
      { type: 'text', text: ', ' },
      { type: 'text', text: 'code', marks: ['code'] },
      { type: 'text', text: ' and ' },
      { type: 'text', text: 'the guide', href: 'https://example.com/g' },
      { type: 'text', text: '.' },
    ]);
  });

  it('never turns unsafe schemes into links and keeps escaped characters literal', () => {
    expect(parseInlines('[x](javascript:alert(1))')).toEqual([{ type: 'text', text: '[x](javascript:alert(1))' }]);
    expect(parseInlines('2 \\* 3 = 6')).toEqual([{ type: 'text', text: '2 * 3 = 6' }]);
    expect(parseInlines('use snake_case_names')).toEqual([{ type: 'text', text: 'use snake_case_names' }]);
  });

  it('round-trips structured runs (separated by plain text, as the editor produces them) through the markup', () => {
    const runArb = fc.record({
      text: fc.stringMatching(/^[a-zA-Z0-9 ,.*_`[\]()\\-]{1,12}$/),
      marks: fc.subarray(['bold', 'italic'] as const),
      link: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(runArb, { maxLength: 6 }), (rs) => {
        const runs: RichInline[] = rs.flatMap((r): RichInline[] => [
          { type: 'text', text: ' ' },
          { type: 'text', text: r.text, ...(r.marks.length ? { marks: [...r.marks] } : {}), ...(r.link ? { href: 'https://example.com/a' } : {}) },
        ]);
        const text = (xs: RichInline[]) => xs.map((x) => x.text).join('');
        expect(text(parseInlines(serializeInlines(runs)))).toBe(text(runs));
      }),
    );
  });
});
