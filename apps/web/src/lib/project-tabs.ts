import type { ComponentType } from 'react';
import type { ProjectDetail } from '@castlane/api-contracts';

/**
 * Project workspace tabs (S15). Each module registers its tab component; tabs render the same
 * records as the module pages, filtered by project — never copies.
 */
export interface ProjectTab {
  key: string;
  label: string;
  order: number;
  /** Return false to hide (e.g. Series only for series projects, Operations only when OFM is enabled). */
  visible?: (p: ProjectDetail, can: (perm: string | string[]) => boolean) => boolean;
  component: ComponentType<{ project: ProjectDetail }>;
}

export const PROJECT_TABS: ProjectTab[] = [];

export const registerProjectTab = (t: ProjectTab) => {
  const i = PROJECT_TABS.findIndex((x) => x.key === t.key);
  if (i >= 0) PROJECT_TABS[i] = t;
  else PROJECT_TABS.push(t);
  PROJECT_TABS.sort((a, b) => a.order - b.order);
};
