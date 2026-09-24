/**
 * Canonical domain vocabularies. The database (check constraints), API contracts (zod enums)
 * and UI labels are all derived from these arrays — never copy them by hand.
 */
export const defineEnum = <const T extends readonly string[]>(values: T) => values;
export type EnumValue<T extends readonly string[]> = T[number];

// Identity & organisation
export const USER_STATUSES = defineEnum(['active', 'disabled'] as const);
export const MEMBERSHIP_STATUSES = defineEnum(['active', 'suspended', 'deactivated'] as const);
export const INVITATION_STATUSES = defineEnum(['pending', 'accepted', 'revoked', 'expired'] as const);
export const DELIVERY_STATUSES = defineEnum(['queued', 'sent', 'failed', 'suppressed'] as const);
export const SCOPE_TYPES = defineEnum([
  'workspace',
  'direction',
  'project',
  'account',
  'assigned_projects',
  'assigned_accounts',
  'assigned_object',
  'own_records',
] as const);
export type ScopeType = EnumValue<typeof SCOPE_TYPES>;
export const RESPONSIBILITIES = defineEnum([
  'direction_management',
  'producing',
  'writing',
  'image_generation',
  'video_generation',
  'voice',
  'editing',
  'quality_review',
  'publishing',
  'analytics',
  'ofm_operations',
  'finance',
] as const);
export const DIRECTION_STATUSES = defineEnum(['active', 'archived'] as const);
export const THEMES = defineEnum(['system', 'light', 'dark'] as const);
export const DENSITIES = defineEnum(['comfortable', 'compact'] as const);
export const WEEKDAYS = defineEnum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const);
export const SETUP_STEPS = defineEnum(['workspace', 'directions', 'team', 'completed'] as const);

// Projects, characters, series, accounts
export const PROJECT_TYPES = defineEnum(['series', 'model', 'influencer'] as const);
export const PROJECT_STATUSES = defineEnum(['draft', 'active', 'paused', 'completed', 'archived'] as const);
export const CHARACTER_VERSION_STATES = defineEnum(['draft', 'submitted', 'approved', 'superseded'] as const);
export const PLATFORMS = defineEnum(['instagram', 'tiktok', 'youtube', 'x', 'onlyfans', 'fansly', 'other'] as const);
export const ACCOUNT_STATUSES = defineEnum(['preparing', 'active', 'paused', 'restricted', 'archived'] as const);
export const REFERENCE_TAGS = defineEnum(['hook', 'lighting', 'story', 'edit', 'character', 'other'] as const);

// Production
export const CONTENT_FORMATS = defineEnum([
  'short_video',
  'episode',
  'trailer',
  'image',
  'carousel',
  'photo_set',
  'story',
  'audio',
  'text_post',
  'other',
] as const);
export const CONTENT_STAGES = defineEnum([
  'idea',
  'brief',
  'ready',
  'production',
  'review',
  'changes_requested',
  'approved',
  'archived',
] as const);
export const CONTENT_SLOTS = defineEnum([
  'main_video',
  'main_image',
  'image_set',
  'cover',
  'subtitles',
  'caption',
  'audio',
  'document',
  'source_archive',
  'other',
] as const);
export const REVIEW_STEP_KINDS = defineEnum(['content_quality', 'release_approval'] as const);
export const REVIEW_STATUSES = defineEnum(['pending', 'approved', 'changes_requested', 'cancelled', 'superseded'] as const);
export const REVIEW_TARGET_TYPES = defineEnum(['content_version', 'character_version'] as const);
/** Note (information), Issue (a concrete change to make), Blocking (prevents approval until resolved). */
export const COMMENT_SEVERITIES = defineEnum(['note', 'issue', 'blocking'] as const);
export const COMMENT_STATES = defineEnum(['open', 'resolved', 'reopened'] as const);

// Tasks & time
export const TASK_STATUSES = defineEnum(['draft', 'backlog', 'ready', 'in_progress', 'in_review', 'done', 'cancelled'] as const);
export const TASK_PRIORITIES = defineEnum(['low', 'normal', 'high', 'urgent'] as const);
export const RECURRENCE_CADENCES = defineEnum(['daily', 'weekly', 'monthly'] as const);
export const RECURRENCE_MODES = defineEnum(['fixed_schedule', 'after_completion'] as const);
export const MONTH_DAY_POLICIES = defineEnum(['last_day_of_month', 'skip_month'] as const);
export const TIME_ENTRY_SOURCES = defineEnum(['timer', 'manual'] as const);
export const TIME_ENTRY_STATES = defineEnum(['running', 'draft', 'needs_review', 'submitted', 'approved', 'returned'] as const);
export const ABSENCE_CATEGORIES = defineEnum(['vacation', 'sick', 'personal', 'public_holiday', 'other'] as const);
export const ABSENCE_STATES = defineEnum(['requested', 'approved', 'rejected', 'cancelled'] as const);

// Publishing & growth
export const PUBLICATION_STATUSES = defineEnum(['draft', 'scheduled', 'published', 'failed', 'cancelled'] as const);
export const PUBLICATION_AVAILABILITY = defineEnum(['available', 'removed', 'unavailable'] as const);
export const CAMPAIGN_STATUSES = defineEnum(['planned', 'active', 'closed', 'archived'] as const);
export const ATTRIBUTION_TYPES = defineEnum(['source_reported', 'manual_assignment', 'unattributed'] as const);
export const EXPERIMENT_STATUSES = defineEnum(['draft', 'running', 'concluded', 'archived'] as const);
export const PARTNER_KINDS = defineEnum(['organization', 'person'] as const);
export const DEAL_STAGES = defineEnum([
  'lead',
  'discussing',
  'proposal',
  'negotiation',
  'won',
  'delivering',
  'fulfilled',
  'lost',
  'cancelled',
] as const);

// Media & knowledge
export const ASSET_KINDS = defineEnum(['image', 'video', 'audio', 'document', 'archive', 'other', 'external_link'] as const);
export const ASSET_VERSION_STATUSES = defineEnum([
  'uploading',
  'uploaded',
  'checking',
  'processing',
  'available',
  'rejected',
  'failed',
] as const);
export const SENSITIVITIES = defineEnum(['normal', 'restricted'] as const);
export const UPLOAD_SESSION_STATES = defineEnum(['open', 'completing', 'completed', 'aborted', 'expired'] as const);
export const ARTICLE_STATUSES = defineEnum(['draft', 'published', 'archived'] as const);
export const REVISION_KINDS = defineEnum(['major', 'minor'] as const);

// OFM
export const COVERAGE_LANES = defineEnum(['primary', 'support', 'custom'] as const);
export const SHIFT_STATES = defineEnum(['scheduled', 'active', 'paused', 'ended', 'cancelled', 'missed'] as const);
export const SHIFT_REPORT_STATES = defineEnum(['not_started', 'draft', 'submitted', 'changes_requested', 'approved'] as const);
export const HANDOVER_STATES = defineEnum(['draft', 'submitted', 'acknowledged'] as const);
export const HANDOVER_ITEM_STATES = defineEnum(['open', 'accepted', 'resolved'] as const);
export const CONTACT_STAGES = defineEnum(['new', 'active', 'follow_up', 'inactive', 'archived'] as const);
export const INTERACTION_TYPES = defineEnum(['message_summary', 'request', 'issue', 'other'] as const);
export const OPERATION_TYPES = defineEnum([
  'follow_up',
  'content_request',
  'payment_check',
  'account_check',
  'issue_resolution',
  'other',
] as const);
export const OPERATION_STATUSES = defineEnum(['open', 'in_progress', 'waiting', 'completed', 'cancelled'] as const);
export const SALE_CANDIDATE_STATES = defineEnum(['pending', 'verified', 'rejected'] as const);
export const QUALITY_REVIEW_STATES = defineEnum(['draft', 'published', 'disputed', 'resolved'] as const);
export const SWAP_REQUEST_STATES = defineEnum(['pending_acceptance', 'pending_approval', 'approved', 'declined', 'cancelled'] as const);

// Metrics & insights
export const OBSERVATION_KINDS = defineEnum(['snapshot', 'period', 'cumulative'] as const);
export const METRIC_SOURCE_TYPES = defineEnum(['manual', 'csv', 'external_report'] as const);
export const METRIC_QUALITY_STATES = defineEnum(['unverified', 'reviewed', 'superseded', 'pending_correction', 'rejected'] as const);
export const VALUE_AVAILABILITY = defineEnum(['known', 'unknown', 'not_provided', 'not_applicable'] as const);
export const METRIC_SEGMENTS = defineEnum(['unknown', 'organic', 'paid', 'combined'] as const);
export const METRIC_ENTITY_TYPES = defineEnum(['account', 'publication', 'ofm_account'] as const);
export const CHECKPOINT_STATES = defineEnum(['pending', 'completed', 'missing', 'cancelled'] as const);
export const CHECKPOINT_TIMING = defineEnum(['on_time', 'early', 'late'] as const);
export const GOAL_TARGET_TYPES = defineEnum(['absolute', 'increase_by', 'decrease_to'] as const);
export const GOAL_STATUSES = defineEnum(['active', 'closed', 'archived'] as const);
export const REPORT_CADENCES = defineEnum(['daily', 'weekly', 'monthly'] as const);

// Finance
export const FINANCE_ENTRY_TYPES = defineEnum(['revenue', 'expense', 'adjustment', 'platform_statement'] as const);
export const FINANCE_ENTRY_STATES = defineEnum(['draft', 'submitted', 'posted', 'rejected'] as const);
export const ACCOUNTING_CLASSES = defineEnum([
  'revenue',
  'contra_revenue',
  'fee',
  'operating_expense',
  'compensation_expense',
  'fx_difference',
] as const);
export const SETTLEMENT_DIRECTIONS = defineEnum(['in', 'out'] as const);
export const SETTLEMENT_STATES = defineEnum(['draft', 'confirmed', 'reversed'] as const);
export const BUDGET_VERSION_STATES = defineEnum(['draft', 'submitted', 'approved', 'superseded'] as const);
export const COMMITMENT_STATES = defineEnum(['open', 'partially_consumed', 'consumed', 'cancelled'] as const);
export const COMPENSATION_RULE_TYPES = defineEnum(['fixed_period', 'hourly', 'per_approved_unit', 'revenue_share'] as const);
export const COMPENSATION_RULE_STATES = defineEnum(['draft', 'approved', 'ended'] as const);
export const PRORATION_POLICIES = defineEnum(['none', 'calendar_days'] as const);
export const HOURLY_SOURCES = defineEnum(['time_entries', 'shift_hours'] as const);
export const REVENUE_SHARE_BASES = defineEnum(['gross', 'net_after_refunds_and_fees'] as const);
export const COMPENSATION_RUN_STATES = defineEnum([
  'draft',
  'calculated',
  'submitted',
  'approved',
  'partially_paid',
  'paid',
  'cancelled',
] as const);
export const ADJUSTMENT_STATES = defineEnum(['draft', 'approved', 'reversed'] as const);

// Platform
export const NOTIFICATION_CHANNELS = defineEnum(['in_app', 'email'] as const);
export const AUTOMATION_STATES = defineEnum(['draft', 'enabled', 'disabled', 'paused_needs_owner', 'paused_requires_attention'] as const);
export const AUTOMATION_RUN_STATES = defineEnum(['pending', 'running', 'succeeded', 'failed', 'skipped', 'throttled', 'dead'] as const);
export const JOB_STATES = defineEnum(['queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled'] as const);
export const JOB_POOLS = defineEnum(['light', 'data', 'media'] as const);
export const IMPORT_STATES = defineEnum([
  'uploaded',
  'parsed',
  'validating',
  'validated',
  'needs_revalidation',
  'committing',
  'committed',
  'failed',
  'cancelled',
  'undone',
] as const);
export const IMPORT_DATASETS = defineEnum([
  'projects',
  'accounts',
  'tasks',
  'references',
  'metric_observations',
  'ofm_contacts',
  'sale_candidates',
  'financial_drafts',
  'fx_rates',
] as const);
export const DUPLICATE_POLICIES = defineEnum(['skip', 'revise_existing', 'error'] as const);
export const EXPORT_FORMATS = defineEnum(['csv', 'xlsx', 'pdf', 'zip'] as const);
export const EXPORT_STATES = defineEnum(['queued', 'running', 'completed', 'failed', 'cancelled', 'expired', 'deleted'] as const);
export const INCIDENT_KINDS = defineEnum(['operational', 'system'] as const);
export const INCIDENT_SEVERITIES = defineEnum(['low', 'medium', 'high', 'critical'] as const);
export const INCIDENT_STATES = defineEnum(['open', 'investigating', 'resolved'] as const);
export const CUSTOM_FIELD_TYPES = defineEnum([
  'short_text',
  'long_text',
  'number',
  'date',
  'datetime',
  'single_select',
  'multi_select',
  'checkbox',
  'url',
  'member_reference',
] as const);
export const TEMPLATE_KINDS = defineEnum(['task', 'content', 'checklist', 'quality_rubric'] as const);
export const TEMPLATE_VERSION_STATES = defineEnum(['draft', 'published', 'disabled'] as const);
export const CHANGE_SOURCES = defineEnum(['ui', 'api', 'import', 'automation', 'system'] as const);
export const ERASURE_STATES = defineEnum(['queued', 'running', 'completed', 'failed'] as const);
