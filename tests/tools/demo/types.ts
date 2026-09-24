import type { TestClient } from '../../support/client';

export interface DemoMember {
  userId: string;
  membershipId: string;
}

export interface DemoTeam {
  producer: DemoMember;
  modelLead: DemoMember;
  creator: DemoMember;
  publisher: DemoMember;
  ofmManager: DemoMember;
  finance: DemoMember;
}

export interface DemoCtx {
  client: TestClient;
  workspaceId: string;
  ownerMembershipId: string;
  team: DemoTeam;
  tz: string;
}

/** ISO date `days` from today (UTC). */
export const day = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
/** ISO datetime `hours` from now. */
export const at = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
