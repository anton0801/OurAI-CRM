import { ROLE_PRESETS } from '@castlane/authorization';
import {
  checkpointPolicies,
  financeCategories,
  memberships,
  roleAssignments,
  roles,
  rubricVersions,
  templates,
  templateVersions,
  userPreferences,
  workspaces,
  type TemplateConfig,
  type DbOrTx,
  type WorkspaceSettings,
} from '@castlane/database';
import { newId } from '@castlane/domain';

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  workingDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  metricCadences: { accountDefault: 'weekly', followerSnapshotDaily: false },
  fileQuotaBytes: String(500 * 1024 ** 3),
  retention: { trashDays: 30, auditMonths: 24, financialYears: 7, ofmArchivedNotesDays: 180, exportDays: 7 },
  mfaPolicy: { requiredForAll: false },
  moduleVisibility: {},
  sessionIdleHours: 12,
  sessionAbsoluteDays: 7,
  publicationGraceMinutes: 15,
  maxShiftAccounts: 10,
  reviewPolicy: { releaseApproval: true, contentQuality: false, selfReviewAllowed: false },
  smtp: { configured: false },
};

type Cat = { key: string; name: string; cls: 'revenue' | 'contra_revenue' | 'fee' | 'operating_expense' | 'compensation_expense' | 'fx_difference' };
export const DEFAULT_FINANCE_CATEGORIES: Cat[] = [
  { key: 'subscriptions', name: 'Subscriptions', cls: 'revenue' },
  { key: 'renewals', name: 'Renewals', cls: 'revenue' },
  { key: 'content_sales', name: 'Content Sales', cls: 'revenue' },
  { key: 'tips', name: 'Tips', cls: 'revenue' },
  { key: 'sponsorship', name: 'Sponsorship', cls: 'revenue' },
  { key: 'licensing', name: 'Licensing', cls: 'revenue' },
  { key: 'other_revenue', name: 'Other Revenue', cls: 'revenue' },
  { key: 'refund', name: 'Refund', cls: 'contra_revenue' },
  { key: 'chargeback', name: 'Chargeback', cls: 'contra_revenue' },
  { key: 'platform_fee', name: 'Platform Fee', cls: 'fee' },
  { key: 'payment_processing_fee', name: 'Payment Processing Fee', cls: 'fee' },
  { key: 'production_services', name: 'Production Services', cls: 'operating_expense' },
  { key: 'ai_tools', name: 'AI Tools', cls: 'operating_expense' },
  { key: 'editing', name: 'Editing', cls: 'operating_expense' },
  { key: 'voice', name: 'Voice', cls: 'operating_expense' },
  { key: 'advertising', name: 'Advertising', cls: 'operating_expense' },
  { key: 'contractors', name: 'Contractors', cls: 'operating_expense' },
  { key: 'compensation', name: 'Compensation', cls: 'compensation_expense' },
  { key: 'software', name: 'Software', cls: 'operating_expense' },
  { key: 'storage', name: 'Storage', cls: 'operating_expense' },
  { key: 'other_expense', name: 'Other Expense', cls: 'operating_expense' },
  { key: 'fx_difference', name: 'Realized FX Difference', cls: 'fx_difference' },
];

const t = (key: string, title: string, extra: Partial<NonNullable<TemplateConfig['tasks']>[number]> = {}) => ({ key, title, ...extra });

export const DEFAULT_CONTENT_TEMPLATES: { name: string; config: TemplateConfig }[] = [
  {
    name: 'Short Video',
    config: {
      format: 'short_video',
      deliverableSlots: [
        { slot: 'main_video', required: true },
        { slot: 'cover', required: false },
        { slot: 'caption', required: false },
      ],
      checklist: [
        { label: 'Hook in the first seconds matches the brief', mandatory: true },
        { label: 'Caption and CTA drafted', mandatory: true },
      ],
      tasks: [
        t('brief', 'Brief', { offsetDaysFromStart: 0, durationDays: 1, responsibility: 'producing' }),
        t('script', 'Script', { offsetDaysFromStart: 1, durationDays: 1, responsibility: 'writing', dependsOn: ['brief'] }),
        t('generate', 'Generation / Source', { offsetDaysFromStart: 2, durationDays: 2, responsibility: 'video_generation', dependsOn: ['script'] }),
        t('edit', 'Edit', { offsetDaysFromStart: 4, durationDays: 1, responsibility: 'editing', dependsOn: ['generate'] }),
        t('caption', 'Caption / Cover', { offsetDaysFromStart: 5, durationDays: 1, responsibility: 'writing', dependsOn: ['edit'] }),
        t('review', 'Review', { offsetDaysFromStart: 6, durationDays: 1, responsibility: 'quality_review', dependsOn: ['caption'], requiresReview: true }),
      ],
    },
  },
  {
    name: 'Episode',
    config: {
      format: 'episode',
      deliverableSlots: [
        { slot: 'main_video', required: true },
        { slot: 'subtitles', required: true },
        { slot: 'cover', required: false },
      ],
      checklist: [{ label: 'Subtitles synced to final cut', mandatory: true }],
      tasks: [
        t('script', 'Script', { offsetDaysFromStart: 0, durationDays: 2, responsibility: 'writing' }),
        t('breakdown', 'Scene Breakdown', { offsetDaysFromStart: 2, durationDays: 1, responsibility: 'producing', dependsOn: ['script'] }),
        t('assets', 'Assets', { offsetDaysFromStart: 3, durationDays: 3, responsibility: 'image_generation', dependsOn: ['breakdown'] }),
        t('voice', 'Voice', { offsetDaysFromStart: 3, durationDays: 2, responsibility: 'voice', dependsOn: ['breakdown'] }),
        t('edit', 'Edit', { offsetDaysFromStart: 6, durationDays: 2, responsibility: 'editing', dependsOn: ['assets', 'voice'] }),
        t('subtitles', 'Subtitles', { offsetDaysFromStart: 8, durationDays: 1, responsibility: 'editing', dependsOn: ['edit'] }),
        t('qc', 'QC', { offsetDaysFromStart: 9, durationDays: 1, responsibility: 'quality_review', dependsOn: ['subtitles'] }),
        t('review', 'Review', { offsetDaysFromStart: 10, durationDays: 1, responsibility: 'quality_review', dependsOn: ['qc'], requiresReview: true }),
      ],
    },
  },
  {
    name: 'Photo Set',
    config: {
      format: 'photo_set',
      deliverableSlots: [{ slot: 'image_set', required: true }],
      checklist: [{ label: 'Character consistency checked against the approved profile', mandatory: true }],
      tasks: [
        t('concept', 'Concept', { offsetDaysFromStart: 0, durationDays: 1, responsibility: 'producing' }),
        t('references', 'References', { offsetDaysFromStart: 1, durationDays: 1, responsibility: 'producing', dependsOn: ['concept'] }),
        t('generate', 'Generate / Source', { offsetDaysFromStart: 2, durationDays: 2, responsibility: 'image_generation', dependsOn: ['references'] }),
        t('select', 'Select', { offsetDaysFromStart: 4, durationDays: 1, responsibility: 'producing', dependsOn: ['generate'] }),
        t('retouch', 'Retouch', { offsetDaysFromStart: 5, durationDays: 1, responsibility: 'editing', dependsOn: ['select'] }),
        t('qc', 'QC', { offsetDaysFromStart: 6, durationDays: 1, responsibility: 'quality_review', dependsOn: ['retouch'] }),
        t('review', 'Review', { offsetDaysFromStart: 7, durationDays: 1, responsibility: 'quality_review', dependsOn: ['qc'], requiresReview: true }),
      ],
    },
  },
  {
    name: 'Text Post',
    config: {
      format: 'text_post',
      deliverableSlots: [{ slot: 'caption', required: true }],
      checklist: [],
      tasks: [
        t('outline', 'Outline', { offsetDaysFromStart: 0, durationDays: 1, responsibility: 'writing' }),
        t('draft', 'Draft', { offsetDaysFromStart: 1, durationDays: 1, responsibility: 'writing', dependsOn: ['outline'] }),
        t('edit', 'Edit', { offsetDaysFromStart: 2, durationDays: 1, responsibility: 'editing', dependsOn: ['draft'] }),
        t('review', 'Review', { offsetDaysFromStart: 3, durationDays: 1, responsibility: 'quality_review', dependsOn: ['edit'], requiresReview: true }),
      ],
    },
  },
];

export const DEFAULT_RUBRIC = [
  { key: 'handover_completeness', label: 'Handover Completeness', weight: '25' },
  { key: 'task_follow_through', label: 'Task Follow-through', weight: '25' },
  { key: 'data_accuracy', label: 'Data Accuracy', weight: '25' },
  { key: 'response_process_compliance', label: 'Response Process Compliance', weight: '25' },
];

export const DEFAULT_CHECKPOINT_POLICY = {
  publication: [
    { key: 'pub_24h', offsetHours: 24, toleranceHours: 2, requiredMetrics: ['publication.views', 'publication.likes', 'publication.comments', 'publication.shares', 'publication.saves'] },
    { key: 'pub_7d', offsetHours: 168, toleranceHours: 12, requiredMetrics: ['publication.views', 'publication.likes', 'publication.comments', 'publication.shares', 'publication.saves'] },
  ],
  account: { requiredMetrics: ['account.followers'], graceHours: 24 },
};

export interface CreateWorkspaceInput {
  name: string;
  timezone: string;
  baseCurrency: string;
  ownerUserId: string;
  ownerDisplayName: string;
  at: Date;
}

/**
 * Create a workspace with its reference data: editable copies of the role presets (Owner is
 * protected), the owner membership, finance categories, checkpoint policy, the starter quality
 * rubric and the starter content templates. No demo projects, accounts or metrics are created.
 */
export const createWorkspaceWithDefaults = async (
  db: DbOrTx,
  input: CreateWorkspaceInput,
): Promise<{ workspaceId: string; membershipId: string }> => {
  const workspaceId = newId();
  const at = input.at;
  const base = { workspaceId, createdAt: at, updatedAt: at, createdBy: input.ownerUserId, updatedBy: input.ownerUserId };
  await db.insert(workspaces).values({
    id: workspaceId,
    name: input.name,
    timezone: input.timezone,
    baseCurrency: input.baseCurrency,
    settings: DEFAULT_WORKSPACE_SETTINGS,
    setupStep: 'workspace',
    createdAt: at,
    updatedAt: at,
    createdBy: input.ownerUserId,
  });

  const roleIds = new Map<string, string>();
  for (const preset of ROLE_PRESETS) {
    const id = newId();
    roleIds.set(preset.key, id);
    await db.insert(roles).values({
      ...base,
      id,
      key: preset.key,
      name: preset.name,
      description: preset.description,
      permissions: [...preset.permissions],
      defaultScopeType: preset.defaultScopeType,
      isProtected: preset.isProtected ?? false,
      isPreset: true,
    });
  }

  const membershipId = newId();
  await db.insert(memberships).values({
    ...base,
    id: membershipId,
    userId: input.ownerUserId,
    displayNameSnapshot: input.ownerDisplayName,
    status: 'active',
    joinedAt: at,
  });
  await db.insert(roleAssignments).values({
    ...base,
    id: newId(),
    membershipId,
    roleId: roleIds.get('owner')!,
    scopeType: 'workspace',
    scopeId: null,
    validFrom: at,
    reason: 'Workspace owner',
  });
  await db.insert(userPreferences).values({ userId: input.ownerUserId, timezone: input.timezone }).onConflictDoNothing();

  let sort = 0;
  for (const c of DEFAULT_FINANCE_CATEGORIES) {
    await db.insert(financeCategories).values({ ...base, id: newId(), key: c.key, name: c.name, accountingClass: c.cls, isSystem: true, sortOrder: sort++ });
  }
  await db.insert(checkpointPolicies).values({ ...base, id: newId(), version: 1, config: DEFAULT_CHECKPOINT_POLICY, active: true });
  await db.insert(rubricVersions).values({
    ...base,
    id: newId(),
    name: 'OFM Quality Rubric',
    rubricKey: 'ofm_default',
    versionNo: 1,
    criteria: DEFAULT_RUBRIC,
    state: 'published',
    publishedAt: at,
  });
  for (const tpl of DEFAULT_CONTENT_TEMPLATES) {
    const templateId = newId();
    const versionId = newId();
    await db.insert(templates).values({ ...base, id: templateId, kind: 'content', name: tpl.name, publishedVersionId: versionId });
    await db.insert(templateVersions).values({ ...base, id: versionId, templateId, versionNo: 1, state: 'published', config: tpl.config, publishedAt: at });
  }
  return { workspaceId, membershipId };
};
