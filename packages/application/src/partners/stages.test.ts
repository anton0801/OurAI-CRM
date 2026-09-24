import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { DEAL_STAGES, canTransition } from '@castlane/domain';
import { DEAL_TRANSITIONS } from './deals';
import { DELIVERABLE_TRANSITIONS } from './deliverables';

const OPEN = ['lead', 'discussing', 'proposal', 'negotiation'] as const;

describe('deal stages (section 9)', () => {
  it('only reach Fulfilled through Won → Delivering', () => {
    // Any walk through the table that ends in Fulfilled passed Won and Delivering (in that order).
    fc.assert(
      fc.property(fc.array(fc.nat(), { minLength: 1, maxLength: 20 }), (choices) => {
        let s: (typeof DEAL_STAGES)[number] = 'lead';
        const path: string[] = [s];
        for (const c of choices) {
          const next: readonly (typeof DEAL_STAGES)[number][] = DEAL_TRANSITIONS[s];
          if (!next.length) break;
          s = next[c % next.length]!;
          path.push(s);
        }
        if (s === 'fulfilled') {
          const won = path.lastIndexOf('won');
          const delivering = path.lastIndexOf('delivering');
          expect(won).toBeGreaterThanOrEqual(0);
          expect(delivering).toBeGreaterThan(won);
        }
      }),
    );
  });

  it('open stages can be won, lost or cancelled; closed stages are final except reopening a lost deal', () => {
    for (const s of OPEN) {
      expect(canTransition(DEAL_TRANSITIONS, s, 'won')).toBe(true);
      expect(canTransition(DEAL_TRANSITIONS, s, 'lost')).toBe(true);
      expect(canTransition(DEAL_TRANSITIONS, s, 'cancelled')).toBe(true);
    }
    expect(DEAL_TRANSITIONS.fulfilled).toEqual([]);
    expect(DEAL_TRANSITIONS.cancelled).toEqual([]);
    expect(DEAL_TRANSITIONS.lost).toEqual(['discussing']);
    expect(canTransition(DEAL_TRANSITIONS, 'won', 'lost')).toBe(false);
    for (const s of DEAL_STAGES) for (const t of DEAL_TRANSITIONS[s]) expect(DEAL_STAGES).toContain(t);
  });

  it('deliverables are accepted only after delivery', () => {
    expect(canTransition(DELIVERABLE_TRANSITIONS, 'open', 'accepted')).toBe(false);
    expect(canTransition(DELIVERABLE_TRANSITIONS, 'delivered', 'accepted')).toBe(true);
    expect(DELIVERABLE_TRANSITIONS.accepted).toEqual([]);
  });
});
