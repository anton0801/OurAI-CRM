'use client';
import type { ProjectDetail } from '@castlane/api-contracts';
import { registerProjectTab } from '@/lib/project-tabs';
import { GoalsScreen } from './goals-screen';

/** Project workspace "Goals" tab (S15/S53): the same goals, filtered by the project. */
const ProjectGoalsTab = ({ project }: { project: ProjectDetail }) => <GoalsScreen projectId={project.id} embedded />;

registerProjectTab({ key: 'goals', label: 'Goals', order: 80, visible: (_p, can) => can('goals.read'), component: ProjectGoalsTab });
