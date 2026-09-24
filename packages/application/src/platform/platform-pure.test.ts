import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { convertCustomFieldValue, displayCustomFieldValue, validateCustomFieldValue, type FieldDef } from './custom-field-values';
import { digestDue } from './digest';
import { csvLine, safeCell } from './exports/writers';
import { validateFilterAst } from './filter-ast';
import { planTemplate, topologicalOrder, validateTemplateConfig } from './templates/plan';

describe('spreadsheet export safety (T151)', () => {
  it('neutralises formula-like text but keeps typed numbers numeric', () => {
    expect(safeCell('=HYPERLINK("http://x","y")', 'text')).toBe(`'=HYPERLINK("http://x","y")`);
    expect(safeCell('+1', 'text')).toBe(`'+1`);
    expect(safeCell('@SUM(A1)', 'text')).toBe(`'@SUM(A1)`);
    expect(safeCell('\tcmd', 'text')).toBe(`'\tcmd`);
    expect(safeCell('-12.50', 'amount')).toBe('-12.50');
    expect(safeCell('-2+3', 'amount')).toBe(`'-2+3`);
    expect(safeCell(-7, 'integer')).toBe(-7);
    expect(safeCell(null, 'text')).toBeNull();
  });

  it('no neutralised text cell ever starts with a formula trigger', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const v = safeCell(s, 'text') as string;
        return !/^[=+\-@\t\r]/.test(v);
      }),
    );
  });

  it('quotes CSV fields per RFC 4180', () => {
    expect(csvLine(['a', 'b,c', 'say "hi"', null, 3])).toBe('a,"b,c","say ""hi""",,3\r\n');
  });
});

describe('saved view filter AST', () => {
  const fields = { status: { kind: 'enum' as const, values: ['draft', 'active'] }, ownerMembershipId: { kind: 'id' as const } };
  it('accepts a valid tree', () => {
    expect(validateFilterAst({ op: 'and', clauses: [{ field: 'status', operator: 'in', value: ['draft'] }, { field: 'ownerMembershipId', operator: 'is_empty' }] }, fields)).toEqual([]);
  });
  it('limits clauses to 30 and depth to 3', () => {
    const many = { op: 'and', clauses: Array.from({ length: 31 }, () => ({ field: 'status', operator: 'equals', value: 'draft' })) };
    expect(validateFilterAst(many, fields).some((i) => /30/.test(i.message))).toBe(true);
    const deep = { op: 'and', clauses: [{ op: 'or', clauses: [{ op: 'and', clauses: [{ op: 'or', clauses: [] }] }] }] };
    expect(validateFilterAst(deep, fields).some((i) => /3 levels/.test(i.message))).toBe(true);
  });
  it('rejects unknown fields, operators and values', () => {
    expect(validateFilterAst({ op: 'and', clauses: [{ field: 'budget', operator: 'equals', value: 1 }] }, fields)[0]!.message).toMatch(/Unknown field/);
    expect(validateFilterAst({ op: 'and', clauses: [{ field: 'status', operator: 'contains', value: 'x' }] }, fields)[0]!.message).toMatch(/not available/);
    expect(validateFilterAst({ op: 'and', clauses: [{ field: 'status', operator: 'equals', value: 'deleted' }] }, fields)[0]!.message).toMatch(/not a valid/);
  });
});

describe('template graph', () => {
  const tasks = [
    { key: 'script', title: 'Write script', offsetDaysFromStart: 0, durationDays: 3 },
    { key: 'shoot', title: 'Generate footage', offsetDaysFromStart: 1, durationDays: 2, dependsOn: ['script'] },
    { key: 'edit', title: 'Edit', offsetDaysFromStart: 2, durationDays: 1, dependsOn: ['shoot'], estimateMinutes: 90 },
  ];
  it('orders topologically and detects cycles', () => {
    expect(topologicalOrder(tasks)!.map((t) => t.key)).toEqual(['script', 'shoot', 'edit']);
    expect(topologicalOrder([{ key: 'a', title: 'A', dependsOn: ['b'] }, { key: 'b', title: 'B', dependsOn: ['a'] }])).toBeNull();
    expect(validateTemplateConfig('task', { tasks: [{ key: 'a', title: 'A', dependsOn: ['b'] }, { key: 'b', title: 'B', dependsOn: ['a'] }] })[0]!.code).toBe('CYCLE');
    expect(validateTemplateConfig('task', { tasks: [{ key: 'a', title: 'A', dependsOn: ['zzz'] }] })[0]!.code).toBe('UNKNOWN');
  });
  it('plans dates finish-to-start from the start date', () => {
    const p = planTemplate({ tasks }, '2026-10-01');
    expect(p.tasks.map((t) => [t.key, t.startDate, t.dueDate])).toEqual([
      ['script', '2026-10-01', '2026-10-04'],
      ['shoot', '2026-10-04', '2026-10-06'],
      ['edit', '2026-10-06', '2026-10-07'],
    ]);
    expect(p.endDate).toBe('2026-10-07');
    expect(p.totalEstimateMinutes).toBe(90);
    expect(p.warnings).toHaveLength(2);
  });
  it('requires rubric weights to sum to exactly 100', () => {
    expect(validateTemplateConfig('quality_rubric', { rubric: [{ key: 'a', label: 'A', weight: '33.33' }, { key: 'b', label: 'B', weight: '66.67' }] })).toEqual([]);
    expect(validateTemplateConfig('quality_rubric', { rubric: [{ key: 'a', label: 'A', weight: '50' }] })[0]!.code).toBe('WEIGHTS');
  });
});

describe('custom field values', () => {
  const select: FieldDef = { type: 'single_select', options: [{ key: 'hot', label: 'Hot' }, { key: 'old', label: 'Old label', archivedAt: '2026-01-01T00:00:00Z' }], precision: null };
  it('accepts only active options and keeps historical labels for display', () => {
    expect(validateCustomFieldValue(select, 'hot')).toEqual({ ok: true, value: 'hot' });
    expect(validateCustomFieldValue(select, 'old').ok).toBe(false);
    expect(displayCustomFieldValue(select, 'old')).toBe('Old label');
  });
  it('limits number precision without floats', () => {
    const num: FieldDef = { type: 'number', options: [], precision: 2, unit: 'kg' };
    expect(validateCustomFieldValue(num, '12.34')).toEqual({ ok: true, value: '12.34' });
    expect(validateCustomFieldValue(num, '12.345').ok).toBe(false);
    expect(validateCustomFieldValue(num, '1,5').ok).toBe(false);
    expect(displayCustomFieldValue(num, '12.34')).toBe('12.34 kg');
  });
  it('distinguishes false from empty and converts only without guessing', () => {
    const cb: FieldDef = { type: 'checkbox', options: [], precision: null };
    expect(validateCustomFieldValue(cb, false)).toEqual({ ok: true, value: false });
    expect(validateCustomFieldValue(cb, '')).toEqual({ ok: true, value: null });
    const text: FieldDef = { type: 'short_text', options: [], precision: null };
    expect(convertCustomFieldValue(select, text, 'hot')).toBe('Hot');
    expect(convertCustomFieldValue(text, { type: 'number', options: [], precision: 0 }, 'twelve')).toBeUndefined();
    expect(convertCustomFieldValue(text, { type: 'number', options: [], precision: 0 }, '12')).toBe('12');
  });
});

describe('daily digest timing (T144)', () => {
  it('is never due inside quiet hours and is due once the quiet period ended', () => {
    expect(digestDue(new Date('2026-10-01T21:30:00Z'), 'Europe/Berlin', '22:00', '08:00')).toBeNull();
    expect(digestDue(new Date('2026-10-02T05:30:00Z'), 'Europe/Berlin', '22:00', '08:00')).toBeNull();
    expect(digestDue(new Date('2026-10-02T06:30:00Z'), 'Europe/Berlin', '22:00', '08:00')).toBe('2026-10-02');
  });
});
