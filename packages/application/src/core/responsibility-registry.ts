import type { CommandContext, QueryContext } from './context';

/** One open responsibility a member holds (shown in the Deactivate Member impact preview, F12/T019). */
export interface ResponsibilityItem {
  /** Provider key, e.g. 'tasks.assignee'. */
  kind: string;
  entityType: string;
  entityId: string;
  title: string;
  projectId: string | null;
  /** e.g. due date, shift start — ISO string or null. */
  dueAt: string | null;
  /** When true the item cannot be left unassigned (e.g. a scheduled shift, a pending review). */
  requiresSuccessor: boolean;
}

export interface ResponsibilityResolution {
  entityId: string;
  /** Successor membership, or null → leave in the lead's "Unassigned" queue / cancel (provider decides, documented in `label`). */
  successorMembershipId: string | null;
}

/**
 * Modules that assign work to people register a provider so deactivating a member lists and
 * transfers everything open (tasks, reviews, shifts, OFM assignments, account ownership, …).
 * `transfer` runs inside the deactivation transaction and must audit + notify like a normal
 * reassignment. History (authorship, past assignments) is never rewritten.
 */
export interface ResponsibilityProvider {
  kind: string;
  label: string;
  /** What happens to items without a successor, e.g. "Moved to the project lead's Unassigned queue". */
  unassignedBehaviour: string;
  /**
   * Provider kinds whose items must be transferred before this provider's (e.g. OFM assignments
   * can only end once the member's scheduled shifts on the account were moved or cancelled as the
   * preview showed). Providers are otherwise transferred in the order the preview lists them.
   */
  transferAfter?: string[];
  list(ctx: QueryContext | CommandContext, membershipId: string): Promise<ResponsibilityItem[]>;
  transfer(ctx: CommandContext, fromMembershipId: string, resolutions: ResponsibilityResolution[]): Promise<void>;
}

export const RESPONSIBILITY_PROVIDERS = new Map<string, ResponsibilityProvider>();

export const defineResponsibilityProvider = (p: ResponsibilityProvider) => {
  RESPONSIBILITY_PROVIDERS.set(p.kind, p);
};

/** Order groups for transfer: preview order, except that a provider runs after the kinds it names in `transferAfter`. */
export const inTransferOrder = <G extends { kind: string }>(groups: G[]): G[] => {
  const out: G[] = [];
  const pending = [...groups];
  while (pending.length) {
    const ready = pending.findIndex((g) => !(RESPONSIBILITY_PROVIDERS.get(g.kind)?.transferAfter ?? []).some((k) => pending.some((o) => o !== g && o.kind === k)));
    out.push(...pending.splice(ready === -1 ? 0 : ready, 1));
  }
  return out;
};
