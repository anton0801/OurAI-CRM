/**
 * Production module contributions to other modules' screens: Account Detail tab "Content",
 * Character Profile panel "Content using this character", the episode panel in Series Structure
 * and the My Work section "Reviewing". Imported once from features/slots.ts.
 */
import { ACCOUNT_TABS, CHARACTER_PANELS, EPISODE_PANELS, MY_WORK_SECTIONS } from '@/lib/slots';
import { MyReviewsSection } from '../reviews/review-queue';
import { AccountContentTab, CharacterContentPanel, EpisodeContentPanel } from './content-panels';

ACCOUNT_TABS.register({
  key: 'content',
  label: 'Content',
  order: 15,
  visible: (_p, can) => can('content.read'),
  component: AccountContentTab,
});
CHARACTER_PANELS.register({
  key: 'content',
  label: 'Content using this character',
  order: 10,
  visible: (_p, can) => can('content.read'),
  component: CharacterContentPanel,
});
EPISODE_PANELS.register({
  key: 'content',
  label: 'Content',
  order: 10,
  visible: (_p, can) => can('content.read'),
  component: EpisodeContentPanel,
});
MY_WORK_SECTIONS.register({
  key: 'reviewing',
  label: 'Reviewing',
  order: 20,
  visible: (_p, can) => can(['content.approve', 'characters.approve']),
  component: MyReviewsSection,
});
