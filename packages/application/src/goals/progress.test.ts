import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { known, unavailable } from '@castlane/analytics';
import { goalCompleteness, goalCurrentValue, goalProgressOf } from './progress';

describe('goal current value and progress', () => {
  it('prefers the canonical metric, then a manual check-in labelled Manual, else Not Measured', () => {
    expect(goalCurrentValue(known('40', 'count'), { value: '55', source: 'Platform screenshot' }, 'count')).toMatchObject({ source: 'metric', value: { value: '40' } });
    expect(goalCurrentValue(unavailable('no_data', 'count'), { value: '55', source: 'Platform screenshot' }, 'count')).toMatchObject({ source: 'manual', manualSource: 'Platform screenshot', value: { value: '55', note: 'Manual' } });
    expect(goalCurrentValue(unavailable('no_data', 'count'), null, 'count')).toMatchObject({ source: 'none', value: { status: 'not_measured', value: null } });
    expect(goalCurrentValue(null, null, 'count').value.status).toBe('not_measured');
  });

  it('computes progress per target type without clamping and labels Over Target', () => {
    const cur = (v: string) => goalCurrentValue(known(v, 'count'), null, 'count');
    expect(goalProgressOf('absolute', cur('50'), '200', null)).toMatchObject({ progress: { value: '25.00' }, overTarget: false });
    expect(goalProgressOf('absolute', cur('300'), '200', null)).toMatchObject({ progress: { value: '150.00', note: 'Over Target' }, overTarget: true });
    expect(goalProgressOf('increase_by', cur('150'), '100', '100').progress.value).toBe('50.00');
    expect(goalProgressOf('decrease_to', cur('80'), '60', '100').progress.value).toBe('50.00');
    // Denominator 0 → Not Defined; missing baseline for relative types → Not Defined.
    expect(goalProgressOf('decrease_to', cur('80'), '100', '100').progress.status).toBe('not_defined');
    expect(goalProgressOf('increase_by', cur('80'), '10', null).progress.status).toBe('not_defined');
    // No source → Not Measured (never 0 %).
    expect(goalProgressOf('absolute', goalCurrentValue(null, null, 'count'), '10', null).progress.status).toBe('not_measured');
  });

  it('completeness comes from metric coverage only', () => {
    expect(goalCompleteness(known('1', 'count', { coverage: { usable: 3, expected: 4 } }), 'metric')).toBe('75.0000');
    expect(goalCompleteness(known('1', 'count'), 'metric')).toBeNull();
    expect(goalCompleteness(known('1', 'count', { coverage: { usable: 3, expected: 4 } }), 'manual')).toBeNull();
  });

  it('absolute progress is monotonic in the current value (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 1, max: 100_000 }), (a, b, target) => {
        const pa = Number(goalProgressOf('absolute', goalCurrentValue(known(String(a), 'count'), null, 'count'), String(target), null).progress.value);
        const pb = Number(goalProgressOf('absolute', goalCurrentValue(known(String(b), 'count'), null, 'count'), String(target), null).progress.value);
        return a <= b ? pa <= pb : pa >= pb;
      }),
    );
  });
});
