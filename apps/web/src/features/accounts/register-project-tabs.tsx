'use client';
import type { ProjectDetail } from '@castlane/api-contracts';
import { registerProjectTab } from '@/lib/project-tabs';
import { ProjectCharactersTab } from '@/features/characters/project-characters-tab';
import { ReferencesScreen } from '@/features/references/references-screen';
import { SeriesStructure } from '@/features/series/series-structure';
import { AccountsScreen } from './accounts-screen';

/**
 * Project workspace tabs (S15) contributed by the accounts / creative module. Each tab renders the
 * module's own screen filtered by the project — the same records as the module pages.
 */
const ProjectAccountsTab = ({ project }: { project: ProjectDetail }) => <AccountsScreen projectId={project.id} embedded />;
const ProjectSeriesTab = ({ project }: { project: ProjectDetail }) => <SeriesStructure projectId={project.id} embedded />;
const ProjectReferencesTab = ({ project }: { project: ProjectDetail }) => <ReferencesScreen projectId={project.id} embedded />;

registerProjectTab({ key: 'accounts', label: 'Accounts', order: 10, visible: (_p, can) => can('accounts.read'), component: ProjectAccountsTab });
registerProjectTab({ key: 'characters', label: 'Characters', order: 12, visible: (_p, can) => can('characters.read'), component: ProjectCharactersTab });
registerProjectTab({ key: 'series', label: 'Series', order: 14, visible: (p, can) => p.type === 'series' && can('series.read'), component: ProjectSeriesTab });
registerProjectTab({ key: 'references', label: 'References', order: 40, visible: (_p, can) => can('references.read'), component: ProjectReferencesTab });
