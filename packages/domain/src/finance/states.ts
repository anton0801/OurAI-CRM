import type { TransitionTable } from '../state-machine';

/**
 * Finance lifecycles (spec §18). Status strings are never edited directly; commands assert these
 * transitions. "Reversed" for entries is a flag (reversed_by_entry_id), the posted row itself
 * stays Posted and immutable.
 */
export type EntryState = 'draft' | 'submitted' | 'posted' | 'rejected';
export const ENTRY_TRANSITIONS: TransitionTable<EntryState> = {
  draft: ['submitted'],
  submitted: ['posted', 'rejected', 'draft'],
  rejected: ['draft'],
  posted: [],
};

export type SettlementState = 'draft' | 'confirmed' | 'reversed';
export const SETTLEMENT_TRANSITIONS: TransitionTable<SettlementState> = {
  draft: ['confirmed'],
  confirmed: ['reversed'],
  reversed: [],
};

export type BudgetVersionState = 'draft' | 'submitted' | 'approved' | 'superseded';
export const BUDGET_VERSION_TRANSITIONS: TransitionTable<BudgetVersionState> = {
  draft: ['submitted', 'approved'],
  submitted: ['approved', 'draft'],
  approved: ['superseded'],
  superseded: [],
};

export type RuleVersionState = 'draft' | 'approved' | 'ended';
export const RULE_VERSION_TRANSITIONS: TransitionTable<RuleVersionState> = {
  draft: ['approved'],
  approved: ['ended'],
  ended: [],
};

export type RunState = 'draft' | 'calculated' | 'submitted' | 'approved' | 'partially_paid' | 'paid' | 'cancelled';
export const RUN_TRANSITIONS: TransitionTable<RunState> = {
  draft: ['calculated', 'cancelled'],
  calculated: ['calculated', 'submitted', 'draft', 'cancelled'],
  submitted: ['approved', 'draft', 'cancelled'],
  approved: ['partially_paid', 'paid'],
  partially_paid: ['partially_paid', 'paid', 'approved'],
  paid: ['partially_paid', 'approved'],
  cancelled: [],
};

export type CommitmentState = 'open' | 'partially_consumed' | 'consumed' | 'cancelled';
export const COMMITMENT_TRANSITIONS: TransitionTable<CommitmentState> = {
  open: ['partially_consumed', 'consumed', 'cancelled'],
  partially_consumed: ['open', 'consumed', 'cancelled'],
  consumed: ['partially_consumed', 'open'],
  cancelled: [],
};
