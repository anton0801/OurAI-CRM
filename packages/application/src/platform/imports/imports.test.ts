import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import ExcelJS from 'exceljs';
import type { ImportColumn } from '../../core/import-registry';
import { coerceValue, parseDate, parseDecimal, suggestMapping } from './coerce';
import { FORMULA_KEY, NO_CACHE_KEY, detectDelimiter, formulaHeaders, normalizeHeaders, parseCsv, parseXlsx, toStagedRaw, xlsxCell } from './parse';

const opts = { timezone: 'Europe/Berlin', dateFormat: 'iso' as const, decimalSeparator: '.' as const };

describe('CSV parsing', () => {
  it('strips the UTF-8 BOM and detects comma vs semicolon', () => {
    const csv = Buffer.from('﻿Name;Type;Notes\n"A; B";series;"line1\nline2"\n', 'utf8');
    const r = parseCsv(csv);
    expect(r.delimiter).toBe(';');
    expect(r.headers).toEqual(['Name', 'Type', 'Notes']);
    expect(r.rows[0]!.map((c) => c.value)).toEqual(['A; B', 'series', 'line1\nline2']);
  });

  it('honours an explicit delimiter and ignores delimiters inside quotes', () => {
    expect(detectDelimiter('"a;b;c",x,y\n1,2,3')).toBe(',');
    const r = parseCsv(Buffer.from('a;b\n1;2\n'), ',');
    expect(r.headers).toEqual(['a;b']);
  });

  it('rejects non-UTF-8 input instead of guessing the encoding', () => {
    const latin1 = Buffer.from([0x4e, 0x61, 0x6d, 0x65, 0x0a, 0xe9, 0x74, 0xe9, 0x0a]);
    expect(() => parseCsv(latin1)).toThrow(/UTF-8/);
  });

  it('skips blank lines, requires data rows and enforces the row limit', () => {
    expect(() => parseCsv(Buffer.from('a,b\n\n'))).toThrow(/no data rows/);
    const big = `a\n${Array.from({ length: 20_001 }, (_, i) => String(i)).join('\n')}\n`;
    expect(() => parseCsv(Buffer.from(big))).toThrow(/20,000/);
    expect(parseCsv(Buffer.from('a\n1\n\n2\n')).rows).toHaveLength(2);
  });

  it('names duplicate and blank headers deterministically', () => {
    expect(normalizeHeaders(['Name', 'name', '', 'Name'])).toEqual(['Name', 'name (2)', 'Column 3', 'Name (3)']);
  });
});

describe('XLSX parsing (T152)', () => {
  it('reads cached formula results only and flags formulas without a stored value', async () => {
    expect(xlsxCell({ formula: 'A1*2', result: 42 } as never)).toEqual({ value: '42', formula: true });
    expect(xlsxCell({ formula: 'NOW()' } as never)).toEqual({ value: '', formula: true, noCachedValue: true });
    expect(xlsxCell({ richText: [{ text: 'Hi ' }, { text: 'there' }] } as never)).toEqual({ value: 'Hi there' });
    expect(xlsxCell(new Date(Date.UTC(2026, 9, 1)) as never)).toEqual({ value: '2026-10-01' });
  });

  it('parses a workbook without evaluating anything', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Data');
    ws.addRow(['Name', 'Amount']);
    ws.addRow(['A', { formula: 'SUM(1,2)', result: 3 }]);
    ws.addRow(['B', { formula: 'SUM(4,5)' }]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const r = await parseXlsx(buf);
    expect(r.headers).toEqual(['Name', 'Amount']);
    const staged = r.rows.map((cells) => toStagedRaw(r.headers, cells));
    expect(staged[0]!.Amount).toBe('3');
    expect(formulaHeaders(staged[0]!).formulas.has('Amount')).toBe(true);
    expect(staged[1]![NO_CACHE_KEY]).toBeDefined();
    expect(staged[0]![FORMULA_KEY]).toBeDefined();
  });

  it('rejects macro-enabled content', async () => {
    const fake = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('xl/vbaProject.bin')]);
    await expect(parseXlsx(fake)).rejects.toThrow(/Macro/);
  });
});

describe('value coercion', () => {
  it('never guesses grouping separators: an ambiguous amount needs the separator mapping (T149)', () => {
    expect(parseDecimal('1,234', '.')).toMatchObject({ ok: false, code: 'AMBIGUOUS_NUMBER' });
    expect(parseDecimal('1.234', ',')).toMatchObject({ ok: false, code: 'AMBIGUOUS_NUMBER' });
    expect(parseDecimal('1 234', '.')).toMatchObject({ ok: false });
    expect(parseDecimal('1,5', ',')).toEqual({ ok: true, value: '1.5' });
    expect(parseDecimal('-0012.50', '.')).toEqual({ ok: true, value: '-12.50' });
  });

  it('with the chosen separator every amount is read exactly, never rescaled (T149)', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000, max: 1_000_000 }), fc.nat({ max: 9999 }), fc.constantFrom('.', ','), (i, f, sep) => {
        const text = `${i}${sep}${String(f).padStart(4, '0')}`;
        const r = parseDecimal(text, sep as '.' | ',');
        return r.ok && r.value === `${i}.${String(f).padStart(4, '0')}`;
      }),
    );
  });

  it('accepts ISO dates or the explicitly chosen format only; an ambiguous date is not guessed (T149)', () => {
    expect(parseDate('2026-10-01', 'iso')).toEqual({ ok: true, value: '2026-10-01' });
    expect(parseDate('01/10/2026', 'iso')).toMatchObject({ ok: false, code: 'DATE_FORMAT' });
    expect(parseDate('01/10/2026', 'dd/mm/yyyy')).toEqual({ ok: true, value: '2026-10-01' });
    expect(parseDate('01/10/2026', 'mm/dd/yyyy')).toEqual({ ok: true, value: '2026-01-10' });
    expect(parseDate('31.02.2026', 'dd.mm.yyyy')).toMatchObject({ ok: false, code: 'INVALID_DATE' });
  });

  it('interprets local date-times in the chosen timezone', () => {
    const col: ImportColumn = { key: 'at', label: 'At', type: 'datetime' };
    expect(coerceValue('2026-10-01 10:00', col, opts)).toEqual({ ok: true, value: '2026-10-01T08:00:00.000Z' });
    expect(coerceValue('2026-10-01T10:00:00Z', col, opts)).toEqual({ ok: true, value: '2026-10-01T10:00:00.000Z' });
  });

  it('validates enums, booleans, emails, urls and tags', () => {
    expect(coerceValue('Model', { key: 't', label: 'T', type: 'enum', enumValues: ['series', 'model'] }, opts)).toEqual({ ok: true, value: 'model' });
    expect(coerceValue('movie', { key: 't', label: 'T', type: 'enum', enumValues: ['series', 'model'] }, opts)).toMatchObject({ ok: false });
    expect(coerceValue('Yes', { key: 'b', label: 'B', type: 'boolean' }, opts)).toEqual({ ok: true, value: true });
    expect(coerceValue('javascript:alert(1)', { key: 'u', label: 'U', type: 'url' }, opts)).toMatchObject({ ok: false });
    expect(coerceValue('a, b | a', { key: 'g', label: 'G', type: 'tags' }, opts)).toEqual({ ok: true, value: ['a', 'b'] });
    expect(coerceValue('  ', { key: 'x', label: 'X', type: 'text' }, opts)).toEqual({ ok: true, value: null });
  });

  it('suggests a mapping from keys, labels and aliases without reusing a header', () => {
    const cols: ImportColumn[] = [
      { key: 'name', label: 'Name', type: 'text', aliases: ['project name'] },
      { key: 'briefSummary', label: 'Brief Summary', type: 'long_text' },
      { key: 'owner', label: 'Owner', type: 'reference', aliases: ['owner email'] },
    ];
    expect(suggestMapping(cols, ['Project Name', 'brief_summary', 'Owner E-mail', 'Extra'])).toEqual({ name: 'Project Name', briefSummary: 'brief_summary', owner: 'Owner E-mail' });
  });
});
