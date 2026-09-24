import { describe, expect, it } from 'vitest';
import { changedFields, pickChanged } from './edit-base';

describe('edit base: only the fields changed since the edit started', () => {
  const start = { name: 'Harbor', notes: null as string | null, tags: ['night', 'sea'], amount: { amount: '10.00', currency: 'EUR' }, active: true };

  it('reports no change for an untouched form, including equal arrays and objects', () => {
    expect(changedFields(start, { ...start, tags: ['night', 'sea'], amount: { amount: '10.00', currency: 'EUR' } })).toEqual([]);
  });

  it('reports scalar, nullable, array and object changes', () => {
    const now = { ...start, notes: 'Pier at dawn', tags: ['night'], amount: { amount: '12.00', currency: 'EUR' }, active: false };
    expect(changedFields(start, now).sort()).toEqual(['active', 'amount', 'notes', 'tags']);
  });

  it('treats a cleared value as a change and null/undefined objects alike', () => {
    expect(changedFields({ a: 'x', b: null as object | null }, { a: '', b: undefined as unknown as object | null })).toEqual(['a']);
  });

  it('keeps only the changed keys of the payload, with the payload values', () => {
    const body = { name: 'Harbor Lights', notes: null, tags: ['night', 'sea'] };
    expect(pickChanged(body, ['name'])).toEqual({ name: 'Harbor Lights' });
    expect(pickChanged(body, [])).toEqual({});
    expect(pickChanged(body, ['notes', 'missing'])).toEqual({ notes: null });
  });
});
