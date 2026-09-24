import type { ComponentType } from 'react';

/**
 * Extension points where one module's screen shows another module's records (tabs, sections).
 * The screen owner renders `SLOT.items`; other modules register from their
 * `features/<module>/register-slots.ts`, imported once in `features/slots.ts`.
 * Registered components render the other module's own endpoints — never copies of its data.
 */
export interface SlotItem<P> {
  key: string;
  label: string;
  order: number;
  /** Return false to hide (permissions, project type…). */
  visible?: (props: P, can: (perm: string | string[]) => boolean) => boolean;
  component: ComponentType<P>;
}

export const createSlot = <P>() => {
  const items: SlotItem<P>[] = [];
  return {
    items,
    register(t: SlotItem<P>) {
      const i = items.findIndex((x) => x.key === t.key);
      if (i >= 0) items[i] = t;
      else items.push(t);
      items.sort((a, b) => a.order - b.order);
    },
  };
};

/** Account Detail tabs (S20): Publications, Metrics, OFM, Tasks… Owned by the accounts module. */
export const ACCOUNT_TABS = createSlot<{ accountId: string; projectId: string }>();
/** My Work sections (S09): Tasks, Reviews, Publications due, Metric checkpoints, Shifts, Reading. Owned by the tasks module. */
export const MY_WORK_SECTIONS = createSlot<Record<string, never>>();
/** Member Workspace tabs (S62): Assignments, Workload, Time, Shifts, Compensation. Owned by the team module. */
export const MEMBER_TABS = createSlot<{ membershipId: string }>();
/** Character Profile side panels (S16): content, references using this character. Owned by the accounts/characters module. */
export const CHARACTER_PANELS = createSlot<{ characterId: string; projectId: string }>();
/** Episode panels in Series Structure (S17): content items, publications of the episode. */
export const EPISODE_PANELS = createSlot<{ episodeId: string; projectId: string }>();
/** Campaign workspace tabs (S34) contributed by other modules (finance budget, metrics). */
export const CAMPAIGN_TABS = createSlot<{ campaignId: string }>();
/** Deal workspace panels (S74): deliverables' publications, finance entries. */
export const DEAL_PANELS = createSlot<{ dealId: string }>();
