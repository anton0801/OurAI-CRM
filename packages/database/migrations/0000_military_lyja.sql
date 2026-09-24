CREATE TABLE "access_denies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"membership_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"object_type" text,
	"object_id" uuid,
	"reason" text NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "access_denies_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "auth_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"purpose" text NOT NULL,
	"pending_secret_enc" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"return_to" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_change_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"new_email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_change_token_uq" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "invitation_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"invitation_id" uuid NOT NULL,
	"email_normalized" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "invitation_requests_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"email_normalized" text NOT NULL,
	"email_display" text NOT NULL,
	"proposed_grants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_membership_id" uuid,
	"revoked_at" timestamp with time zone,
	"invited_by_membership_id" uuid,
	"delivery_status" text DEFAULT 'queued' NOT NULL,
	"delivery_error" text,
	"last_sent_at" timestamp with time zone,
	"resend_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "invitations_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "invitations_status_ck" CHECK ("status" IN ('pending', 'accepted', 'revoked', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"display_name_snapshot" text NOT NULL,
	"title" text,
	"manager_membership_id" uuid,
	"skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"access_revision" integer DEFAULT 1 NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"suspended_at" timestamp with time zone,
	"deactivated_at" timestamp with time zone,
	"deactivated_by" uuid,
	"restored_at" timestamp with time zone,
	CONSTRAINT "memberships_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "memberships_status_ck" CHECK ("status" IN ('active', 'suspended', 'deactivated'))
);
--> statement-breakpoint
CREATE TABLE "ownership_transfers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"from_membership_id" uuid NOT NULL,
	"to_membership_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"previous_owner_role_key" text DEFAULT 'admin' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	CONSTRAINT "ownership_transfers_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"blocked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "recovery_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "responsibility_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"membership_id" uuid NOT NULL,
	"duty" text NOT NULL,
	"scope_type" text DEFAULT 'workspace' NOT NULL,
	"scope_id" uuid,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	CONSTRAINT "responsibility_assignments_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "responsibility_assignments_duty_ck" CHECK ("duty" IN ('direction_management', 'producing', 'writing', 'image_generation', 'video_generation', 'voice', 'editing', 'quality_review', 'publishing', 'analytics', 'ofm_operations', 'finance'))
);
--> statement-breakpoint
CREATE TABLE "role_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"membership_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"reason" text,
	CONSTRAINT "role_assignments_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "role_assignments_scope_ck" CHECK ("scope_type" IN ('workspace', 'direction', 'project', 'account', 'assigned_projects', 'assigned_accounts', 'assigned_object', 'own_records'))
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"default_scope_type" text DEFAULT 'workspace' NOT NULL,
	"is_protected" boolean DEFAULT false NOT NULL,
	"is_preset" boolean DEFAULT false NOT NULL,
	"based_on_key" text,
	"archived_at" timestamp with time zone,
	CONSTRAINT "roles_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"csrf_secret" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"mfa_verified_at" timestamp with time zone,
	"recent_auth_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"user_agent" text,
	"ip_hash" text,
	"current_workspace_id" uuid
);
--> statement-breakpoint
CREATE TABLE "system_state" (
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_state_pk" PRIMARY KEY("key")
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"timezone" text,
	"locale" text DEFAULT 'en-US' NOT NULL,
	"theme" text DEFAULT 'system' NOT NULL,
	"density" text DEFAULT 'comfortable' NOT NULL,
	"notifications" jsonb DEFAULT '{"mentions":true,"assignments":true,"reviewRequests":true,"dueReminders":true,"emailImmediate":false,"dailyDigest":false}'::jsonb NOT NULL,
	"quiet_hours_start" text DEFAULT '22:00' NOT NULL,
	"quiet_hours_end" text DEFAULT '08:00' NOT NULL,
	"ui" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" bigint DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"normalized_email" text NOT NULL,
	"display_email" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"mfa_secret_enc" text,
	"mfa_enabled_at" timestamp with time zone,
	"mfa_last_step" bigint,
	"password_changed_at" timestamp with time zone,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"avatar_asset_id" uuid,
	"anonymized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "users_status_ck" CHECK ("status" IN ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"timezone" text NOT NULL,
	"base_currency" char(3) NOT NULL,
	"base_currency_locked_at" timestamp with time zone,
	"week_starts_on" text DEFAULT 'monday' NOT NULL,
	"logo_asset_id" uuid,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"settings_version" integer DEFAULT 1 NOT NULL,
	"setup_step" text DEFAULT 'workspace' NOT NULL,
	"setup_completed_at" timestamp with time zone,
	"storage_used_bytes" bigint DEFAULT 0 NOT NULL,
	"storage_reserved_bytes" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "workspaces_setup_step_ck" CHECK ("setup_step" IN ('workspace', 'directions', 'team', 'completed'))
);
--> statement-breakpoint
CREATE TABLE "account_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"account_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"duty" text NOT NULL,
	"supervisor_membership_id" uuid,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"ended_reason" text,
	CONSTRAINT "account_assignments_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "account_identity_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"account_id" uuid NOT NULL,
	"old_handle" text,
	"new_handle" text,
	"old_url" text,
	"new_url" text,
	"effective_at" timestamp with time zone NOT NULL,
	"reason" text,
	CONSTRAINT "account_identity_history_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "account_status_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"account_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"reason" text,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "account_status_events_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "account_transfers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"account_id" uuid NOT NULL,
	"from_project_id" uuid NOT NULL,
	"to_project_id" uuid NOT NULL,
	"transferred_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "account_transfers_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "character_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"character_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prompts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reference_asset_version_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"change_note" text,
	"submitted_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"review_id" uuid,
	CONSTRAINT "character_versions_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "character_versions_state_ck" CHECK ("state" IN ('draft', 'submitted', 'approved', 'superseded'))
);
--> statement-breakpoint
CREATE TABLE "characters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"current_version_id" uuid,
	"approved_version_id" uuid,
	CONSTRAINT "characters_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "directions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"description" text,
	"lead_membership_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"preset_kind" text,
	CONSTRAINT "directions_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "directions_status_ck" CHECK ("status" IN ('active', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "episodes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"project_id" uuid NOT NULL,
	"season_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"synopsis" text,
	"target_duration_seconds" integer,
	"language" text DEFAULT 'en' NOT NULL,
	"content_item_id" uuid,
	"thumbnail_asset_id" uuid,
	CONSTRAINT "episodes_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "project_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"pinned_at" timestamp with time zone,
	"decided_at" timestamp with time zone NOT NULL,
	CONSTRAINT "project_decisions_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "project_direction_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"project_id" uuid NOT NULL,
	"from_direction_id" uuid,
	"to_direction_id" uuid NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"reason" text,
	CONSTRAINT "project_direction_history_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "project_memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"project_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"responsibility" text,
	"note" text,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"ended_reason" text,
	CONSTRAINT "project_memberships_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "project_milestones" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"due_date" date,
	"completed_at" timestamp with time zone,
	CONSTRAINT "project_milestones_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"purge_after" timestamp with time zone,
	"type" text NOT NULL,
	"direction_id" uuid NOT NULL,
	"name" text NOT NULL,
	"owner_membership_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"brief_summary" text,
	"description" text,
	"language" text,
	"target_markets" text[] DEFAULT '{}'::text[] NOT NULL,
	"audience" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"start_date" date,
	"cover_asset_id" uuid,
	"ofm_enabled" boolean DEFAULT false NOT NULL,
	"review_policy" jsonb DEFAULT '{"contentQualityStep":false,"releaseApprovalStep":true,"allowSelfReview":false}'::jsonb NOT NULL,
	"caption_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"completed_at" timestamp with time zone,
	"status_reason" text,
	CONSTRAINT "projects_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "projects_type_ck" CHECK ("type" IN ('series', 'model', 'influencer')),
	CONSTRAINT "projects_status_ck" CHECK ("status" IN ('draft', 'active', 'paused', 'completed', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "reference_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"reference_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	CONSTRAINT "reference_links_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "references" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"title" text NOT NULL,
	"source_url" text,
	"source_asset_id" uuid,
	"preview_asset_version_id" uuid,
	"what_to_reuse" text NOT NULL,
	"notes" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"owner_membership_id" uuid NOT NULL,
	"project_id" uuid,
	CONSTRAINT "references_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "scene_characters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"scene_id" uuid NOT NULL,
	"character_version_id" uuid NOT NULL,
	CONSTRAINT "scene_characters_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "scenes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"project_id" uuid NOT NULL,
	"episode_id" uuid NOT NULL,
	"order_no" integer NOT NULL,
	"title" text NOT NULL,
	"script" text,
	"deliverables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"thumbnail_asset_id" uuid,
	CONSTRAINT "scenes_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "seasons" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"order_no" integer NOT NULL,
	CONSTRAINT "seasons_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "social_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"purge_after" timestamp with time zone,
	"project_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"original_url" text NOT NULL,
	"canonical_url" text NOT NULL,
	"identity_key" text NOT NULL,
	"handle" text,
	"display_name" text,
	"owner_membership_id" uuid NOT NULL,
	"status" text DEFAULT 'preparing' NOT NULL,
	"status_reason" text,
	"language" text,
	"markets" text[] DEFAULT '{}'::text[] NOT NULL,
	"purpose" text,
	"notes" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"avatar_asset_id" uuid,
	"metrics_cadence" text DEFAULT 'weekly' NOT NULL,
	"metrics_day_of_week" integer DEFAULT 1 NOT NULL,
	"metrics_time" text DEFAULT '10:00' NOT NULL,
	"caption_max_length" integer,
	CONSTRAINT "social_accounts_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "social_accounts_platform_ck" CHECK ("platform" IN ('instagram', 'tiktok', 'youtube', 'x', 'onlyfans', 'fansly', 'other')),
	CONSTRAINT "social_accounts_status_ck" CHECK ("status" IN ('preparing', 'active', 'paused', 'restricted', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "article_acknowledgements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"article_id" uuid NOT NULL,
	"article_version_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"acknowledged_at" timestamp with time zone NOT NULL,
	CONSTRAINT "article_acknowledgements_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "article_categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "article_categories_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "article_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"article_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"title" text NOT NULL,
	"body" jsonb NOT NULL,
	"body_text" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"revision_kind" text,
	"change_note" text,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	CONSTRAINT "article_versions_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "articles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"category_id" uuid NOT NULL,
	"title" text NOT NULL,
	"scope_type" text DEFAULT 'workspace' NOT NULL,
	"scope_id" uuid,
	"owner_membership_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"draft_version_id" uuid,
	"published_version_id" uuid,
	"required_reading" boolean DEFAULT false NOT NULL,
	"last_reviewed_at" timestamp with time zone,
	"cover_asset_id" uuid,
	CONSTRAINT "articles_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "articles_status_ck" CHECK ("status" IN ('draft', 'published', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "asset_derivatives" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"asset_version_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime" text NOT NULL,
	"width" integer,
	"height" integer,
	"byte_size" bigint,
	CONSTRAINT "asset_derivatives_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "asset_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"asset_id" uuid NOT NULL,
	"asset_version_id" uuid,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"role" text DEFAULT 'attachment' NOT NULL,
	"project_id" uuid,
	"holding" boolean DEFAULT false NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" uuid,
	CONSTRAINT "asset_links_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "asset_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"asset_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"status" text DEFAULT 'uploading' NOT NULL,
	"storage_key" text,
	"quarantine_key" text,
	"storage_version_id" text,
	"original_filename" text NOT NULL,
	"declared_mime" text,
	"detected_mime" text,
	"byte_size" bigint,
	"checksum_sha256" text,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"page_count" integer,
	"scan_result" jsonb,
	"rejection_reason" text,
	"processed_at" timestamp with time zone,
	"note" text,
	"reused_from_version_id" uuid,
	CONSTRAINT "asset_versions_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "asset_versions_status_ck" CHECK ("status" IN ('uploading', 'uploaded', 'checking', 'processing', 'available', 'rejected', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"purge_after" timestamp with time zone,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"folder_id" uuid,
	"project_id" uuid,
	"sensitivity" text DEFAULT 'normal' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"current_version_id" uuid,
	"external_url" text,
	"owner_membership_id" uuid,
	"description" text,
	CONSTRAINT "assets_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "assets_kind_ck" CHECK ("kind" IN ('image', 'video', 'audio', 'document', 'archive', 'other', 'external_link')),
	CONSTRAINT "assets_sensitivity_ck" CHECK ("sensitivity" IN ('normal', 'restricted'))
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"parent_id" uuid,
	"name" text NOT NULL,
	"project_id" uuid,
	"depth" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "folders_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "folders_depth_ck" CHECK ("depth" BETWEEN 0 AND 5)
);
--> statement-breakpoint
CREATE TABLE "reading_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"article_id" uuid NOT NULL,
	"article_version_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"due_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"acknowledged_at" timestamp with time zone,
	CONSTRAINT "reading_assignments_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "upload_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"asset_id" uuid,
	"asset_version_id" uuid,
	"target_ref" jsonb,
	"folder_id" uuid,
	"project_id" uuid,
	"sensitivity" text DEFAULT 'normal' NOT NULL,
	"filename" text NOT NULL,
	"declared_mime" text NOT NULL,
	"declared_size" bigint NOT NULL,
	"expected_checksum" text,
	"quarantine_key" text NOT NULL,
	"multipart_upload_id" text,
	"part_size" integer NOT NULL,
	"parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"reserved_bytes" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"owner_membership_id" uuid NOT NULL,
	CONSTRAINT "upload_sessions_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "upload_sessions_state_ck" CHECK ("state" IN ('open', 'completing', 'completed', 'aborted', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "comment_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"comment_id" uuid NOT NULL,
	"previous_body" text NOT NULL,
	CONSTRAINT "comment_revisions_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"parent_type" text NOT NULL,
	"parent_id" uuid NOT NULL,
	"project_id" uuid,
	"thread_root_id" uuid,
	"reply_to_id" uuid,
	"depth" integer DEFAULT 0 NOT NULL,
	"author_membership_id" uuid NOT NULL,
	"body" text NOT NULL,
	"severity" text DEFAULT 'note' NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"target_version_id" uuid,
	"asset_version_id" uuid,
	"timecode_ms" integer,
	"point_x" numeric(6, 5),
	"point_y" numeric(6, 5),
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolution_note" text,
	"edited_at" timestamp with time zone,
	"mentions" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "comments_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "comments_depth_ck" CHECK ("depth" BETWEEN 0 AND 2),
	CONSTRAINT "comments_point_ck" CHECK (("point_x" IS NULL OR ("point_x" >= 0 AND "point_x" <= 1)) AND ("point_y" IS NULL OR ("point_y" >= 0 AND "point_y" <= 1))),
	CONSTRAINT "comments_severity_ck" CHECK ("severity" IN ('note', 'blocking'))
);
--> statement-breakpoint
CREATE TABLE "content_characters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"content_item_id" uuid NOT NULL,
	"character_version_id" uuid NOT NULL,
	CONSTRAINT "content_characters_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "content_flag_intervals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"content_item_id" uuid NOT NULL,
	"flag" text NOT NULL,
	"reason" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"resolution" text,
	CONSTRAINT "content_flag_intervals_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "content_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"purge_after" timestamp with time zone,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"format" text NOT NULL,
	"stage" text DEFAULT 'idea' NOT NULL,
	"owner_membership_id" uuid,
	"reviewer_membership_id" uuid,
	"brief" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"language" text,
	"due_at" timestamp with time zone,
	"no_deadline" boolean DEFAULT false NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"current_version_id" uuid,
	"approved_version_id" uuid,
	"first_approved_at" timestamp with time zone,
	"entered_ready_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"paused_reason" text,
	"blocked_at" timestamp with time zone,
	"blocked_reason" text,
	"needs_consistency_review" boolean DEFAULT false NOT NULL,
	"duplicated_from_id" uuid,
	"template_version_id" uuid,
	"episode_id" uuid,
	"campaign_id" uuid,
	CONSTRAINT "content_items_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "content_items_format_ck" CHECK ("format" IN ('short_video', 'episode', 'trailer', 'image', 'carousel', 'photo_set', 'story', 'audio', 'text_post', 'other')),
	CONSTRAINT "content_items_stage_ck" CHECK ("stage" IN ('idea', 'brief', 'ready', 'production', 'review', 'changes_requested', 'approved', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "content_stage_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"content_item_id" uuid NOT NULL,
	"from_stage" text,
	"to_stage" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"reason" text,
	"actor_membership_id" uuid,
	CONSTRAINT "content_stage_events_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "content_version_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"content_version_id" uuid NOT NULL,
	"slot" text NOT NULL,
	"asset_version_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "content_version_assets_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "cva_slot_ck" CHECK ("slot" IN ('main_video', 'main_image', 'image_set', 'cover', 'subtitles', 'caption', 'audio', 'document', 'source_archive', 'other'))
);
--> statement-breakpoint
CREATE TABLE "content_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"content_item_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"note" text,
	"brief_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"character_version_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_by" uuid,
	"approved_at" timestamp with time zone,
	"approval_revoked_at" timestamp with time zone,
	"approval_revoked_reason" text,
	"fixes_claimed" text,
	CONSTRAINT "content_versions_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "review_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"review_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"summary" text,
	"decided_by_membership_id" uuid NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"target_version_id" uuid NOT NULL,
	CONSTRAINT "review_decisions_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"round_no" integer NOT NULL,
	"step_kind" text DEFAULT 'release_approval' NOT NULL,
	"step_order" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewer_membership_id" uuid,
	"author_membership_id" uuid,
	"submitted_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"policy_snapshot" jsonb NOT NULL,
	"self_review_exception" boolean DEFAULT false NOT NULL,
	CONSTRAINT "reviews_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "reviews_status_ck" CHECK ("status" IN ('pending', 'approved', 'changes_requested', 'cancelled', 'superseded'))
);
--> statement-breakpoint
CREATE TABLE "absences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"membership_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"category" text NOT NULL,
	"private_reason" text,
	"state" text DEFAULT 'approved' NOT NULL,
	"decided_by" uuid,
	CONSTRAINT "absences_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "absences_dates_ck" CHECK ("end_date" >= "start_date")
);
--> statement-breakpoint
CREATE TABLE "capacities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"membership_id" uuid NOT NULL,
	"weekday_minutes" jsonb NOT NULL,
	"effective_from" date NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" uuid,
	CONSTRAINT "capacities_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "personal_reminders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"membership_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"remind_at" timestamp with time zone NOT NULL,
	"snoozed_until" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"note" text,
	CONSTRAINT "personal_reminders_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "recurrence_occurrences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"rule_id" uuid NOT NULL,
	"rule_version" integer NOT NULL,
	"occurrence_key" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"task_id" uuid,
	"state" text DEFAULT 'created' NOT NULL,
	"missed_dates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "recurrence_occurrences_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "recurrence_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"project_id" uuid NOT NULL,
	"owner_membership_id" uuid NOT NULL,
	"template" jsonb NOT NULL,
	"cadence" text NOT NULL,
	"interval_count" integer DEFAULT 1 NOT NULL,
	"weekdays" integer[] DEFAULT '{}'::int[] NOT NULL,
	"month_day" integer,
	"month_day_policy" text DEFAULT 'last_day_of_month' NOT NULL,
	"local_time" text DEFAULT '09:00' NOT NULL,
	"timezone" text NOT NULL,
	"mode" text DEFAULT 'fixed_schedule' NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"horizon_days" integer DEFAULT 30 NOT NULL,
	"backfill_limit" integer DEFAULT 0 NOT NULL,
	"rule_version" integer DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_generated_through" timestamp with time zone,
	CONSTRAINT "recurrence_rules_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "recurrence_rules_backfill_ck" CHECK ("backfill_limit" BETWEEN 0 AND 30)
);
--> statement-breakpoint
CREATE TABLE "task_block_intervals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"task_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"resolution" text,
	CONSTRAINT "task_block_intervals_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "task_checklist_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"task_id" uuid NOT NULL,
	"label" text NOT NULL,
	"mandatory" boolean DEFAULT false NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"done_at" timestamp with time zone,
	"done_by" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "task_checklist_items_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"predecessor_id" uuid NOT NULL,
	"successor_id" uuid NOT NULL,
	"kind" text DEFAULT 'finish_to_start' NOT NULL,
	"overridden_at" timestamp with time zone,
	"override_reason" text,
	"removed_at" timestamp with time zone,
	"removed_reason" text,
	CONSTRAINT "task_dependencies_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "task_dependencies_self_ck" CHECK ("predecessor_id" <> "successor_id")
);
--> statement-breakpoint
CREATE TABLE "task_due_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"task_id" uuid NOT NULL,
	"from_due_at" timestamp with time zone,
	"to_due_at" timestamp with time zone,
	"reason" text,
	"deadline_revision" integer NOT NULL,
	CONSTRAINT "task_due_revisions_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "task_status_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"task_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"effective_at" timestamp with time zone,
	"actor_membership_id" uuid,
	"reason" text,
	"cycle" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "task_status_events_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"purge_after" timestamp with time zone,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"assignee_membership_id" uuid,
	"reviewer_membership_id" uuid,
	"start_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"due_date" date,
	"due_timezone" text,
	"baseline_due_at" timestamp with time zone,
	"estimate_minutes" integer,
	"parent_task_id" uuid,
	"account_id" uuid,
	"content_item_id" uuid,
	"publication_id" uuid,
	"shift_id" uuid,
	"operation_id" uuid,
	"deal_id" uuid,
	"deliverable_id" uuid,
	"article_id" uuid,
	"blocked_at" timestamp with time zone,
	"blocked_reason" text,
	"next_check_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"completion_effective_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"cancellation_accepted" boolean DEFAULT false NOT NULL,
	"reopen_count" integer DEFAULT 0 NOT NULL,
	"assignee_at_completion" uuid,
	"source" text DEFAULT 'manual' NOT NULL,
	"template_application_id" uuid,
	"recurrence_occurrence_id" uuid,
	"required_for_parent" boolean DEFAULT true NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"follower_membership_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	CONSTRAINT "tasks_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "tasks_status_ck" CHECK ("status" IN ('draft', 'backlog', 'ready', 'in_progress', 'in_review', 'done', 'cancelled')),
	CONSTRAINT "tasks_priority_ck" CHECK ("priority" IN ('low', 'normal', 'high', 'urgent')),
	CONSTRAINT "tasks_dates_ck" CHECK ("start_at" IS NULL OR "due_at" IS NULL OR "start_at" <= "due_at"),
	CONSTRAINT "tasks_estimate_ck" CHECK ("estimate_minutes" IS NULL OR "estimate_minutes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "time_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"membership_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"source" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_seconds" integer,
	"work_date" date NOT NULL,
	"note" text,
	"billable" boolean DEFAULT false NOT NULL,
	"submission_id" uuid,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"returned_reason" text,
	"revision_of_id" uuid,
	"superseded_at" timestamp with time zone,
	"needs_review_reason" text,
	"closed_by_membership_id" uuid,
	"close_reason" text,
	CONSTRAINT "time_entries_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "time_entries_state_ck" CHECK ("state" IN ('running', 'draft', 'needs_review', 'submitted', 'approved', 'returned')),
	CONSTRAINT "time_entries_duration_ck" CHECK ("duration_seconds" IS NULL OR ("duration_seconds" > 0 AND "duration_seconds" <= 86400)),
	CONSTRAINT "time_entries_interval_ck" CHECK ("started_at" IS NULL OR "ended_at" IS NULL OR "ended_at" > "started_at")
);
--> statement-breakpoint
CREATE TABLE "time_sheet_submissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"membership_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"state" text DEFAULT 'submitted' NOT NULL,
	"entry_snapshot" jsonb NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"reason" text,
	CONSTRAINT "time_sheet_submissions_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "workload_allocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"task_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"work_date" date NOT NULL,
	"minutes" integer NOT NULL,
	CONSTRAINT "workload_allocations_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "campaign_projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"campaign_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	CONSTRAINT "campaign_projects_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "campaign_source_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"campaign_id" uuid NOT NULL,
	"source_name" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"clicks" integer,
	"conversions" integer,
	"attribution_label" text NOT NULL,
	"tracking_link_id" uuid,
	"evidence_asset_id" uuid,
	"note" text,
	CONSTRAINT "campaign_source_reports_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "csr_period_ck" CHECK ("period_end" > "period_start")
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"name" text NOT NULL,
	"objective" text NOT NULL,
	"owner_membership_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"goals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"partner_id" uuid,
	"cover_asset_id" uuid,
	"closing_summary" text,
	"closed_at" timestamp with time zone,
	"duplicated_from_id" uuid,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "campaigns_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "campaigns_dates_ck" CHECK ("end_date" >= "start_date"),
	CONSTRAINT "campaigns_status_ck" CHECK ("status" IN ('planned', 'active', 'closed', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "deal_projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"deal_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	CONSTRAINT "deal_projects_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "deal_stage_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"deal_id" uuid NOT NULL,
	"from_stage" text,
	"to_stage" text NOT NULL,
	"reason" text,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "deal_stage_events_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "deals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"title" text NOT NULL,
	"partner_id" uuid NOT NULL,
	"owner_membership_id" uuid NOT NULL,
	"stage" text DEFAULT 'lead' NOT NULL,
	"amount_minor" bigint,
	"currency" char(3),
	"campaign_id" uuid,
	"expected_close_date" date,
	"stage_reason" text,
	"outcome" text,
	"closed_at" timestamp with time zone,
	"payment_schedule" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "deals_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "deals_stage_ck" CHECK ("stage" IN ('lead', 'discussing', 'proposal', 'negotiation', 'won', 'delivering', 'fulfilled', 'lost', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "deliverables" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"deal_id" uuid NOT NULL,
	"title" text NOT NULL,
	"format" text,
	"project_id" uuid,
	"account_id" uuid,
	"due_at" timestamp with time zone,
	"acceptance_criteria" text,
	"content_item_id" uuid,
	"agreed_amount_minor" bigint,
	"currency" char(3),
	"status" text DEFAULT 'open' NOT NULL,
	CONSTRAINT "deliverables_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "experiment_publications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"experiment_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"publication_id" uuid NOT NULL,
	"segment" text DEFAULT 'organic' NOT NULL,
	CONSTRAINT "experiment_publications_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "experiment_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"experiment_id" uuid NOT NULL,
	"plan_version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"reason" text,
	CONSTRAINT "experiment_revisions_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "experiment_variants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"experiment_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"thumbnail_asset_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "experiment_variants_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "experiments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"project_id" uuid NOT NULL,
	"owner_membership_id" uuid NOT NULL,
	"hypothesis" text NOT NULL,
	"primary_metric_key" text NOT NULL,
	"observation_window_hours" integer NOT NULL,
	"minimum_sample" integer DEFAULT 1 NOT NULL,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"status" text DEFAULT 'draft' NOT NULL,
	"limitations" text,
	"result_note" text,
	"selected_variant_id" uuid,
	"plan_version" integer DEFAULT 1 NOT NULL,
	"plan_frozen_at" timestamp with time zone,
	"conclusion" jsonb,
	"duplicated_from_id" uuid,
	CONSTRAINT "experiments_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "experiments_status_ck" CHECK ("status" IN ('draft', 'running', 'concluded', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "partner_interactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"partner_id" uuid NOT NULL,
	"deal_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"membership_id" uuid NOT NULL,
	CONSTRAINT "partner_interactions_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "partners" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"contact_name" text,
	"business_email" text,
	"website" text,
	"owner_membership_id" uuid NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"logo_asset_id" uuid,
	"notes" text,
	"merged_into_id" uuid,
	CONSTRAINT "partners_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "plan_baseline_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"baseline_id" uuid NOT NULL,
	"publication_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"baseline_scheduled_at" timestamp with time zone,
	"added_after_baseline" boolean DEFAULT false NOT NULL,
	"removed_after_baseline_at" timestamp with time zone,
	"removal_reason" text,
	CONSTRAINT "plan_baseline_items_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "plan_baselines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"week_start" date NOT NULL,
	"frozen_at" timestamp with time zone NOT NULL,
	"timezone" text NOT NULL,
	CONSTRAINT "plan_baselines_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "publication_corrections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"publication_id" uuid NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "publication_corrections_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "publication_plan_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"publication_id" uuid NOT NULL,
	"from_scheduled_at" timestamp with time zone,
	"to_scheduled_at" timestamp with time zone,
	"reason" text,
	"changed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "publication_plan_revisions_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "publications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"purge_after" timestamp with time zone,
	"content_item_id" uuid NOT NULL,
	"content_version_id" uuid,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"owner_membership_id" uuid NOT NULL,
	"caption" text,
	"cta" text,
	"destination_url" text,
	"primary_campaign_id" uuid,
	"descriptive_tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"schedule_timezone" text,
	"original_scheduled_at" timestamp with time zone,
	"actual_published_at" timestamp with time zone,
	"external_post_url" text,
	"normalized_post_url" text,
	"no_url_reason" text,
	"historical_entry" boolean DEFAULT false NOT NULL,
	"source_note" text,
	"failure_reason" text,
	"cancel_reason" text,
	"override_reason" text,
	"availability" text DEFAULT 'available' NOT NULL,
	"availability_changed_at" timestamp with time zone,
	"availability_reason" text,
	"approval_revoked_after_publication" boolean DEFAULT false NOT NULL,
	"confirmed_by_membership_id" uuid,
	"format" text,
	CONSTRAINT "publications_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "publications_status_ck" CHECK ("status" IN ('draft', 'scheduled', 'published', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "tracking_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"campaign_id" uuid NOT NULL,
	"label" text NOT NULL,
	"destination_url" text NOT NULL,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_content" text,
	"utm_term" text,
	"built_url" text NOT NULL,
	"publication_id" uuid,
	CONSTRAINT "tracking_links_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "erasure_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"plan" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"completed_at" timestamp with time zone,
	CONSTRAINT "erasure_requests_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "handover_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"handover_id" uuid NOT NULL,
	"task_id" uuid,
	"operation_id" uuid,
	"title" text NOT NULL,
	"business_explanation" text,
	"priority" text DEFAULT 'normal' NOT NULL,
	"due_at" timestamp with time zone,
	"state" text DEFAULT 'open' NOT NULL,
	"accepted_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"carried_from_item_id" uuid,
	CONSTRAINT "handover_items_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "handovers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"from_shift_id" uuid NOT NULL,
	"to_shift_id" uuid,
	"recipient_membership_id" uuid,
	"account_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"no_open_items" boolean DEFAULT false NOT NULL,
	"submitted_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid,
	CONSTRAINT "handovers_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "handovers_state_ck" CHECK ("state" IN ('draft', 'submitted', 'acknowledged'))
);
--> statement-breakpoint
CREATE TABLE "interaction_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"contact_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"shift_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"type" text NOT NULL,
	"business_note" text NOT NULL,
	"erased_at" timestamp with time zone,
	CONSTRAINT "interaction_logs_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "ofm_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"project_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"responsibility" text NOT NULL,
	"coverage_lane" text DEFAULT 'primary' NOT NULL,
	"coverage_lane_label" text,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"supervisor_membership_id" uuid,
	"handover_required" boolean DEFAULT true NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_reason" text,
	"transferred_from_id" uuid,
	CONSTRAINT "ofm_assignments_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "ofm_assignments_interval_ck" CHECK ("valid_to" IS NULL OR "valid_to" > "valid_from")
);
--> statement-breakpoint
CREATE TABLE "ofm_contact_relations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"contact_a_id" uuid NOT NULL,
	"contact_b_id" uuid NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "ofm_contact_relations_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "ofm_contacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"external_identifier" text NOT NULL,
	"alias" text NOT NULL,
	"manager_membership_id" uuid,
	"stage" text DEFAULT 'new' NOT NULL,
	"last_activity_at" timestamp with time zone,
	"next_follow_up_at" timestamp with time zone,
	"business_notes" text,
	"restricted" boolean DEFAULT false NOT NULL,
	"merged_into_id" uuid,
	"erased_at" timestamp with time zone,
	CONSTRAINT "ofm_contacts_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "ofm_contacts_stage_ck" CHECK ("stage" IN ('new', 'active', 'follow_up', 'inactive', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "ofm_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"project_id" uuid NOT NULL,
	"supervisor_membership_id" uuid,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "ofm_profiles_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"contact_id" uuid,
	"owner_membership_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"details" text,
	"due_at" timestamp with time zone,
	"priority" text DEFAULT 'normal' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"waiting_for" text,
	"next_check_at" timestamp with time zone,
	"outcome" text,
	"cancel_reason" text,
	"shift_id" uuid,
	"task_id" uuid,
	"content_item_id" uuid,
	"promised_deliverable" text,
	"evidence_asset_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "operations_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "operations_type_ck" CHECK ("type" IN ('follow_up', 'content_request', 'payment_check', 'account_check', 'issue_resolution', 'other')),
	CONSTRAINT "operations_status_ck" CHECK ("status" IN ('open', 'in_progress', 'waiting', 'completed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "quality_disputes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"quality_review_id" uuid NOT NULL,
	"raised_by_membership_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"decision" text,
	"resolution" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"replacement_review_id" uuid,
	CONSTRAINT "quality_disputes_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "quality_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"subject_membership_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"reviewer_membership_id" uuid NOT NULL,
	"rubric_version_id" uuid NOT NULL,
	"scores" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"factual_notes" text,
	"improvements" text,
	"total_score" numeric(7, 4),
	"state" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"employee_response" text,
	"revision_of_id" uuid,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "quality_reviews_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "quality_reviews_self_ck" CHECK ("subject_membership_id" <> "reviewer_membership_id"),
	CONSTRAINT "quality_reviews_state_ck" CHECK ("state" IN ('draft', 'published', 'disputed', 'resolved'))
);
--> statement-breakpoint
CREATE TABLE "rubric_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"name" text NOT NULL,
	"rubric_key" text NOT NULL,
	"version_no" integer NOT NULL,
	"criteria" jsonb NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "rubric_versions_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "sale_candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"source_namespace" text NOT NULL,
	"source_transaction_id" text NOT NULL,
	"manual_reference" boolean DEFAULT false NOT NULL,
	"contact_id" uuid,
	"shift_id" uuid,
	"operation_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"gross_minor" bigint,
	"refund_minor" bigint,
	"fee_minor" bigint,
	"net_minor" bigint,
	"currency" char(3) NOT NULL,
	"source_note" text,
	"evidence_asset_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"claimed_allocations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"review_note" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"financial_entry_id" uuid,
	"duplicate_warning" jsonb,
	CONSTRAINT "sale_candidates_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "sale_candidates_state_ck" CHECK ("state" IN ('pending', 'verified', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "shift_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"shift_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"coverage_lane" text DEFAULT 'primary' NOT NULL,
	"coverage_lane_label" text,
	"time_allocation_share" numeric(7, 4),
	CONSTRAINT "shift_accounts_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "shift_breaks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"shift_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"reason" text,
	CONSTRAINT "shift_breaks_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "shift_breaks_interval_ck" CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at")
);
--> statement-breakpoint
CREATE TABLE "shift_report_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"report_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"completed_work" text,
	"issues" text,
	"next_actions" text,
	"account_sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"counts" jsonb DEFAULT '{"conversationsHandled":null,"followUpsCompleted":null,"contentRequests":null,"conversionEvents":null}'::jsonb NOT NULL,
	"source_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"no_open_items" boolean DEFAULT false NOT NULL,
	"handover_id" uuid,
	"state" text DEFAULT 'draft' NOT NULL,
	"review_summary" text,
	"submitted_at" timestamp with time zone,
	CONSTRAINT "shift_report_versions_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "shift_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"shift_id" uuid NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"current_version_id" uuid,
	"approved_version_id" uuid,
	"reviewer_membership_id" uuid,
	"submitted_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	CONSTRAINT "shift_reports_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "shift_swap_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"shift_id" uuid NOT NULL,
	"from_membership_id" uuid NOT NULL,
	"proposed_membership_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"state" text DEFAULT 'pending_acceptance' NOT NULL,
	"accepted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"decision_note" text,
	CONSTRAINT "shift_swap_requests_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "shift_time_corrections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"shift_id" uuid NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "shift_time_corrections_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"project_id" uuid NOT NULL,
	"primary_account_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"supervisor_membership_id" uuid,
	"scheduled_start" timestamp with time zone NOT NULL,
	"scheduled_end" timestamp with time zone NOT NULL,
	"timezone" text NOT NULL,
	"state" text DEFAULT 'scheduled' NOT NULL,
	"report_state" text DEFAULT 'not_started' NOT NULL,
	"actual_start" timestamp with time zone,
	"actual_end" timestamp with time zone,
	"parallel_coverage" boolean DEFAULT false NOT NULL,
	"start_override_reason" text,
	"acknowledged_handover_id" uuid,
	"no_handover_reason" text,
	"end_note" text,
	"aborted" boolean DEFAULT false NOT NULL,
	"cancel_reason" text,
	"missed_confirmed_at" timestamp with time zone,
	"needs_review_reason" text,
	"forgot_end_alerted_at" timestamp with time zone,
	"corrected_at" timestamp with time zone,
	"correction_reason" text,
	"repeat_group_id" uuid,
	"occurrence_key" text,
	CONSTRAINT "shifts_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "shifts_state_ck" CHECK ("state" IN ('scheduled', 'active', 'paused', 'ended', 'cancelled', 'missed')),
	CONSTRAINT "shifts_report_state_ck" CHECK ("report_state" IN ('not_started', 'draft', 'submitted', 'changes_requested', 'approved')),
	CONSTRAINT "shifts_schedule_ck" CHECK ("scheduled_end" > "scheduled_start"),
	CONSTRAINT "shifts_actual_ck" CHECK ("actual_end" IS NULL OR "actual_start" IS NULL OR "actual_end" >= "actual_start")
);
--> statement-breakpoint
CREATE TABLE "checkpoint_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"version" integer NOT NULL,
	"config" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "checkpoint_policies_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "goal_check_ins" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"goal_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"note" text NOT NULL,
	"manual_value" numeric(30, 6),
	"manual_source" text,
	"measured_value" numeric(30, 6),
	CONSTRAINT "goal_check_ins_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "goal_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"goal_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"reason" text,
	CONSTRAINT "goal_revisions_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"name" text NOT NULL,
	"owner_membership_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid,
	"metric_key" text NOT NULL,
	"target_type" text NOT NULL,
	"target_value" numeric(30, 6) NOT NULL,
	"unit" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"baseline_value" numeric(30, 6),
	"direction" text DEFAULT 'increase' NOT NULL,
	"linked_campaign_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"revision_no" integer DEFAULT 1 NOT NULL,
	"closed_at" timestamp with time zone,
	"achieved_value" numeric(30, 6),
	"completeness" numeric(7, 4),
	"assessment" text,
	CONSTRAINT "goals_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "goals_period_ck" CHECK ("period_end" >= "period_start")
);
--> statement-breakpoint
CREATE TABLE "metric_checkpoints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"publication_id" uuid,
	"checkpoint_key" text NOT NULL,
	"policy_version" integer NOT NULL,
	"expected_at" timestamp with time zone NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"completed_observation_id" uuid,
	"timing" text,
	"missing_reason" text,
	"cancelled_reason" text,
	"occurrence_key" text NOT NULL,
	"assignee_membership_id" uuid,
	CONSTRAINT "metric_checkpoints_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "metric_checkpoints_state_ck" CHECK ("state" IN ('pending', 'completed', 'missing', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "metric_definitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"label" text NOT NULL,
	"description" text NOT NULL,
	"entity_type" text NOT NULL,
	"observation_kind" text NOT NULL,
	"unit" text NOT NULL,
	"value_type" text NOT NULL,
	"aggregation" text NOT NULL,
	"platforms" text[],
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metric_observations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"publication_id" uuid,
	"kind" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"platform_timezone" text,
	"definition_set_version" integer DEFAULT 1 NOT NULL,
	"segment" text DEFAULT 'unknown' NOT NULL,
	"source_type" text NOT NULL,
	"source_namespace" text DEFAULT 'manual' NOT NULL,
	"source_note" text NOT NULL,
	"evidence_asset_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"entered_at" timestamp with time zone NOT NULL,
	"entered_by_membership_id" uuid,
	"quality_state" text DEFAULT 'unverified' NOT NULL,
	"revision_no" integer DEFAULT 1 NOT NULL,
	"root_observation_id" uuid NOT NULL,
	"supersedes_id" uuid,
	"correction_reason" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"checkpoint_id" uuid,
	"import_job_id" uuid,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"warning_note" text,
	"dedupe_key" text NOT NULL,
	"canonical" boolean DEFAULT true NOT NULL,
	CONSTRAINT "metric_observations_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "metric_observations_period_ck" CHECK ("kind" <> 'period' OR ("period_start" IS NOT NULL AND "period_end" IS NOT NULL AND "period_end" > "period_start")),
	CONSTRAINT "metric_observations_kind_ck" CHECK ("kind" IN ('snapshot', 'period', 'cumulative')),
	CONSTRAINT "metric_observations_quality_ck" CHECK ("quality_state" IN ('unverified', 'reviewed', 'superseded', 'pending_correction', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "metric_values" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"observation_id" uuid NOT NULL,
	"metric_key" text NOT NULL,
	"definition_version" integer DEFAULT 1 NOT NULL,
	"value" numeric(30, 6),
	"availability" text NOT NULL,
	"unit" text NOT NULL,
	"currency" char(3),
	CONSTRAINT "metric_values_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "metric_values_known_ck" CHECK (("availability" = 'known') = ("value" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "report_schedules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"report_id" uuid NOT NULL,
	"cadence" text NOT NULL,
	"recipient_membership_ids" uuid[] NOT NULL,
	"owner_membership_id" uuid NOT NULL,
	"local_time" text DEFAULT '08:00' NOT NULL,
	"timezone" text NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"paused_reason" text,
	"email_notify" boolean DEFAULT false NOT NULL,
	CONSTRAINT "report_schedules_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "report_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"report_id" uuid NOT NULL,
	"config_snapshot" jsonb NOT NULL,
	"generated_for_membership_id" uuid NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"source_bounds" jsonb NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"source_revised" boolean DEFAULT false NOT NULL,
	CONSTRAINT "report_snapshots_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "saved_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"name" text NOT NULL,
	"dataset" text NOT NULL,
	"config" jsonb NOT NULL,
	"config_version" integer DEFAULT 1 NOT NULL,
	"owner_membership_id" uuid NOT NULL,
	"sharing" text DEFAULT 'private' NOT NULL,
	"shared_with_membership_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"duplicated_from_id" uuid,
	CONSTRAINT "saved_reports_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "budget_alerts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"budget_version_id" uuid NOT NULL,
	"threshold" integer NOT NULL,
	"crossed_at" timestamp with time zone NOT NULL,
	"reset_at" timestamp with time zone,
	CONSTRAINT "budget_alerts_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "budget_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"budget_version_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"planned_minor" bigint NOT NULL,
	"note" text,
	CONSTRAINT "budget_lines_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "budget_lines_amount_ck" CHECK ("planned_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "budget_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"budget_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"reason" text,
	"submitted_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	CONSTRAINT "budget_versions_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"name" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"currency" char(3) NOT NULL,
	"owner_membership_id" uuid NOT NULL,
	"approved_version_id" uuid,
	"alert_thresholds" integer[] DEFAULT '{80,100,120}'::int[] NOT NULL,
	"copied_from_id" uuid,
	CONSTRAINT "budgets_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "budgets_period_ck" CHECK ("period_end" >= "period_start")
);
--> statement-breakpoint
CREATE TABLE "commitment_consumptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"commitment_id" uuid NOT NULL,
	"entry_line_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"reversed_at" timestamp with time zone,
	CONSTRAINT "commitment_consumptions_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "commitments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"project_id" uuid NOT NULL,
	"budget_id" uuid,
	"category_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"consumed_minor" bigint DEFAULT 0 NOT NULL,
	"currency" char(3) NOT NULL,
	"due_date" date,
	"counterparty" text,
	"description" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"cancel_reason" text,
	CONSTRAINT "commitments_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "commitments_amount_ck" CHECK ("amount_minor" > 0 AND "consumed_minor" >= 0 AND "consumed_minor" <= "amount_minor")
);
--> statement-breakpoint
CREATE TABLE "compensation_adjustments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"recipient_membership_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"reason" text NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"original_entitlement_key" text,
	"source_run_id" uuid,
	"applied_run_id" uuid,
	"reverses_adjustment_id" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	CONSTRAINT "compensation_adjustments_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "compensation_claims" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"entitlement_key" text NOT NULL,
	"run_id" uuid NOT NULL,
	"line_id" uuid NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "compensation_claims_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "compensation_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"run_id" uuid NOT NULL,
	"calculation_version" integer NOT NULL,
	"recipient_membership_id" uuid NOT NULL,
	"rule_version_id" uuid,
	"adjustment_id" uuid,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"component" text NOT NULL,
	"entitlement_key" text NOT NULL,
	"quantity" numeric(24, 6),
	"rate" text,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"excluded" boolean DEFAULT false NOT NULL,
	"exclusion_reason" text,
	"explanation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "compensation_lines_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "compensation_rule_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"rule_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"type" text NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"rate_minor" bigint,
	"rate_percent" numeric(9, 4),
	"currency" char(3) NOT NULL,
	"revenue_basis" text,
	"hourly_source" text,
	"proration" text DEFAULT 'none' NOT NULL,
	"eligible_project_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"contributor_responsibility" text,
	"refund_policy" text DEFAULT 'adjust_next_open_run' NOT NULL,
	"stacking" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"ended_at" timestamp with time zone,
	CONSTRAINT "compensation_rule_versions_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "crv_percent_ck" CHECK ("rate_percent" IS NULL OR ("rate_percent" > 0 AND "rate_percent" <= 100))
);
--> statement-breakpoint
CREATE TABLE "compensation_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"name" text NOT NULL,
	"recipient_scope_type" text NOT NULL,
	"recipient_membership_id" uuid,
	"recipient_role_id" uuid,
	"component_key" text NOT NULL,
	"stack_group" text,
	"current_version_id" uuid,
	CONSTRAINT "compensation_rules_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "compensation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"participant_membership_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"calculation_version" integer DEFAULT 0 NOT NULL,
	"source_digest" text,
	"calculated_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"expense_entry_id" uuid,
	"cancel_reason" text,
	"return_reason" text,
	"totals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"snapshot" jsonb,
	CONSTRAINT "compensation_runs_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "compensation_runs_period_ck" CHECK ("period_end" >= "period_start"),
	CONSTRAINT "compensation_runs_state_ck" CHECK ("state" IN ('draft', 'calculated', 'submitted', 'approved', 'partially_paid', 'paid', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "finance_categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"accounting_class" text NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "finance_categories_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "finance_categories_class_ck" CHECK ("accounting_class" IN ('revenue', 'contra_revenue', 'fee', 'operating_expense', 'compensation_expense', 'fx_difference'))
);
--> statement-breakpoint
CREATE TABLE "financial_allocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"line_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"project_id" uuid,
	"campaign_id" uuid,
	"content_item_id" uuid,
	"amount_minor" bigint NOT NULL,
	"base_amount_minor" bigint,
	"share_percent" numeric(9, 4),
	"rule_snapshot" jsonb,
	"effective_date" date NOT NULL,
	"adjustment_of_id" uuid,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "financial_allocations_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "financial_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"type" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"recognition_date" date NOT NULL,
	"title" text NOT NULL,
	"counterparty" text,
	"source_namespace" text,
	"source_external_id" text,
	"account_id" uuid,
	"campaign_id" uuid,
	"shift_id" uuid,
	"sale_candidate_id" uuid,
	"deal_id" uuid,
	"compensation_run_id" uuid,
	"note" text,
	"evidence_asset_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"net_only" boolean DEFAULT false NOT NULL,
	"control_total_minor" bigint,
	"control_total_currency" char(3),
	"submitted_at" timestamp with time zone,
	"submitted_by" uuid,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	"self_approval_reason" text,
	"rejected_at" timestamp with time zone,
	"rejected_reason" text,
	"reverses_entry_id" uuid,
	"reversed_by_entry_id" uuid,
	"replacement_of_entry_id" uuid,
	"reversal_reason" text,
	CONSTRAINT "financial_entries_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "financial_entries_type_ck" CHECK ("type" IN ('revenue', 'expense', 'adjustment', 'platform_statement')),
	CONSTRAINT "financial_entries_state_ck" CHECK ("state" IN ('draft', 'submitted', 'posted', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "financial_entry_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"entry_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"category_id" uuid NOT NULL,
	"accounting_class" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"fx_rate" numeric(24, 10),
	"fx_rate_id" uuid,
	"base_amount_minor" bigint,
	"base_currency" char(3) NOT NULL,
	"description" text,
	"source_namespace" text,
	"transaction_ref" text,
	"components_unknown" boolean DEFAULT false NOT NULL,
	"reverses_line_id" uuid,
	"is_reversal" boolean DEFAULT false NOT NULL,
	CONSTRAINT "financial_entry_lines_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "fel_amount_ck" CHECK ("amount_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"from_currency" char(3) NOT NULL,
	"to_currency" char(3) NOT NULL,
	"rate" numeric(24, 10) NOT NULL,
	"effective_date" date NOT NULL,
	"source" text NOT NULL,
	"first_used_at" timestamp with time zone,
	CONSTRAINT "fx_rates_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "fx_rates_positive_ck" CHECK ("rate" > 0)
);
--> statement-breakpoint
CREATE TABLE "period_locks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"state" text DEFAULT 'locked' NOT NULL,
	"locked_at" timestamp with time zone NOT NULL,
	"locked_by" uuid NOT NULL,
	"unresolved_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reopened_at" timestamp with time zone,
	"reopened_by" uuid,
	"reopen_reason" text,
	CONSTRAINT "period_locks_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "revenue_attributions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"entry_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"share_percent" numeric(9, 4) NOT NULL,
	"basis" text NOT NULL,
	"reason" text,
	"sale_candidate_id" uuid,
	"superseded_at" timestamp with time zone,
	"campaign_id" uuid,
	CONSTRAINT "revenue_attributions_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "ra_share_ck" CHECK ("share_percent" > 0 AND "share_percent" <= 100)
);
--> statement-breakpoint
CREATE TABLE "settlement_allocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"settlement_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_entry_id" uuid,
	"target_run_id" uuid,
	"recipient_membership_id" uuid,
	"amount_minor" bigint NOT NULL,
	"document_amount_minor" bigint NOT NULL,
	"document_currency" char(3) NOT NULL,
	"effective_fx_rate" numeric(24, 10),
	"realized_difference_entry_id" uuid,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	CONSTRAINT "settlement_allocations_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "sa_amount_ck" CHECK ("amount_minor" > 0 AND "document_amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"direction" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"payment_source_namespace" text DEFAULT 'manual' NOT NULL,
	"payment_reference" text,
	"manual_reference" boolean DEFAULT false NOT NULL,
	"duplicate_ack_reason" text,
	"counterparty" text,
	"evidence_asset_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"note" text,
	"remainder_policy" text DEFAULT 'none' NOT NULL,
	"unallocated_minor" bigint DEFAULT 0 NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" uuid,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	"reversal_effective_date" date,
	"compensation_run_id" uuid,
	CONSTRAINT "settlements_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "settlements_amount_ck" CHECK ("amount_minor" > 0),
	CONSTRAINT "settlements_state_ck" CHECK ("state" IN ('draft', 'confirmed', 'reversed'))
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid,
	"actor_user_id" uuid,
	"actor_membership_id" uuid,
	"actor_kind" text NOT NULL,
	"actor_display" text,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"project_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" text,
	"source" text DEFAULT 'ui' NOT NULL,
	"reason" text,
	"diff" jsonb,
	"metadata" jsonb,
	"sensitivity" text DEFAULT 'normal' NOT NULL,
	"ip_hash" text
);
--> statement-breakpoint
CREATE TABLE "automation_action_effects" (
	"workspace_id" uuid NOT NULL,
	"effect_key" text NOT NULL,
	"run_id" uuid NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_action_effects_pk" PRIMARY KEY("workspace_id","effect_key")
);
--> statement-breakpoint
CREATE TABLE "automation_rule_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"rule_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"trigger" jsonb NOT NULL,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actions" jsonb NOT NULL,
	"quiet_hours_policy" text DEFAULT 'respect' NOT NULL,
	CONSTRAINT "automation_rule_versions_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "automation_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"name" text NOT NULL,
	"owner_membership_id" uuid,
	"state" text DEFAULT 'draft' NOT NULL,
	"current_version_id" uuid,
	"enabled_version_id" uuid,
	"scope_type" text DEFAULT 'workspace' NOT NULL,
	"scope_id" uuid,
	"last_run_at" timestamp with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"paused_reason" text,
	"next_scheduled_at" timestamp with time zone,
	CONSTRAINT "automation_rules_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "automation_rules_state_ck" CHECK ("state" IN ('draft', 'enabled', 'disabled', 'paused_needs_owner', 'paused_requires_attention'))
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"rule_id" uuid NOT NULL,
	"rule_version_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"root_event_id" uuid NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"operation_key" text NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"action_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_code" text,
	"error_message" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "automation_runs_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "backup_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"recovered_timestamp" timestamp with time zone,
	"duration_seconds" integer,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reported_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bulk_previews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"actor_membership_id" uuid NOT NULL,
	"action" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"targets" jsonb NOT NULL,
	"access_revision" integer NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "bulk_previews_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "custom_field_definitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"entity_type" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"scope_project_id" uuid,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required_at_stage" text,
	"unit" text,
	"precision" integer,
	"replaced_by_id" uuid,
	"used_at" timestamp with time zone,
	CONSTRAINT "custom_field_definitions_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "custom_field_values" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"definition_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"value" jsonb,
	"needs_completion" boolean DEFAULT false NOT NULL,
	CONSTRAINT "custom_field_values_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "deletion_tombstones" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"executed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_stream" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"revision" integer,
	"recipient_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "export_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"requested_by_membership_id" uuid NOT NULL,
	"dataset" text NOT NULL,
	"format" text NOT NULL,
	"fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"classification" text DEFAULT 'normal' NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"source_bound_at" timestamp with time zone NOT NULL,
	"storage_key" text,
	"file_name" text,
	"byte_size" bigint,
	"progress" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"error_message" text,
	"completed_at" timestamp with time zone,
	"job_id" uuid,
	CONSTRAINT "export_jobs_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "external_references" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"namespace" text NOT NULL,
	"external_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	CONSTRAINT "external_references_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope_key" text NOT NULL,
	"workspace_id" uuid,
	"actor_user_id" uuid,
	"route_key" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"entity_type" text,
	"entity_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"dataset" text NOT NULL,
	"state" text DEFAULT 'uploaded' NOT NULL,
	"file_name" text NOT NULL,
	"file_kind" text NOT NULL,
	"file_hash" text NOT NULL,
	"file_storage_key" text NOT NULL,
	"byte_size" integer NOT NULL,
	"row_count" integer,
	"headers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"template_version" integer DEFAULT 1 NOT NULL,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"options" jsonb,
	"validation_report" jsonb,
	"validation_token" text,
	"validated_at" timestamp with time zone,
	"warnings_accepted" boolean DEFAULT false NOT NULL,
	"committed_at" timestamp with time zone,
	"result" jsonb,
	"error_message" text,
	"requested_by_membership_id" uuid NOT NULL,
	"undone_at" timestamp with time zone,
	CONSTRAINT "import_jobs_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "import_jobs_state_ck" CHECK ("state" IN ('uploaded', 'parsed', 'validating', 'validated', 'needs_revalidation', 'committing', 'committed', 'failed', 'cancelled', 'undone'))
);
--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"job_id" uuid NOT NULL,
	"row_no" integer NOT NULL,
	"raw" jsonb NOT NULL,
	"mapped" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"action" text,
	"target_id" uuid,
	"target_row_version" integer,
	"created_entity_id" uuid,
	CONSTRAINT "import_rows_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"account_id" uuid,
	"project_id" uuid,
	"owner_membership_id" uuid,
	"state" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"resolved_at" timestamp with time zone,
	"evidence_asset_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"job_id" uuid,
	"alert_key" text,
	"acknowledged_at" timestamp with time zone,
	CONSTRAINT "incidents_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid,
	"type" text NOT NULL,
	"pool" text DEFAULT 'light' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"payload_version" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_retries" integer DEFAULT 5 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"progress" integer DEFAULT 0 NOT NULL,
	"progress_note" text,
	"last_error_code" text,
	"last_error_message" text,
	"result" jsonb,
	"idempotency_key" text,
	"causation" jsonb,
	"requested_by" uuid,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "jobs_state_ck" CHECK ("state" IN ('queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "mail_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid,
	"to_address" text NOT NULL,
	"subject" text NOT NULL,
	"text_body" text NOT NULL,
	"html_body" text,
	"template" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"transport" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"provider_message_id" text,
	"related_entity_type" text,
	"related_entity_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"recipient_membership_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"event_key" text NOT NULL,
	"channel" text DEFAULT 'in_app' NOT NULL,
	"title" text NOT NULL,
	"excerpt" text,
	"entity_type" text,
	"entity_id" uuid,
	"project_id" uuid,
	"actor_membership_id" uuid,
	"sensitive" boolean DEFAULT false NOT NULL,
	"security" boolean DEFAULT false NOT NULL,
	"read_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"delivery_state" text DEFAULT 'delivered' NOT NULL,
	"deliver_after" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "notifications_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"workspace_id" uuid,
	"event_type" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_membership_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"root_event_id" uuid NOT NULL,
	"parent_event_id" uuid,
	"depth" integer DEFAULT 0 NOT NULL,
	"dispatched_at" timestamp with time zone,
	"dispatch_attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "saved_views" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"owner_membership_id" uuid NOT NULL,
	"module" text NOT NULL,
	"name" text NOT NULL,
	"filter_ast" jsonb NOT NULL,
	"sort" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	CONSTRAINT "saved_views_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "search_documents" (
	"workspace_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(body, ''))) STORED NOT NULL,
	"project_id" uuid,
	"account_id" uuid,
	"direction_id" uuid,
	"permission" text NOT NULL,
	"owner_membership_id" uuid,
	"assignee_membership_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"restricted" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"status" text,
	"thumbnail_asset_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_documents_pk" PRIMARY KEY("workspace_id","entity_type","entity_id")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	CONSTRAINT "tags_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "template_applications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"template_version_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"application_key" text NOT NULL,
	"created_task_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"applied_at" timestamp with time zone NOT NULL,
	CONSTRAINT "template_applications_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "template_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"template_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"config" jsonb NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "template_versions_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"published_version_id" uuid,
	"draft_version_id" uuid,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "templates_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "access_denies" ADD CONSTRAINT "access_denies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_denies" ADD CONSTRAINT "access_denies_member_fk" FOREIGN KEY ("workspace_id","membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_change_requests" ADD CONSTRAINT "email_change_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_requests" ADD CONSTRAINT "invitation_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_requests" ADD CONSTRAINT "invitation_requests_inv_fk" FOREIGN KEY ("workspace_id","invitation_id") REFERENCES "public"."invitations"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_manager_fk" FOREIGN KEY ("workspace_id","manager_membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_transfers" ADD CONSTRAINT "ownership_transfers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_transfers" ADD CONSTRAINT "ownership_transfers_from_fk" FOREIGN KEY ("workspace_id","from_membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_transfers" ADD CONSTRAINT "ownership_transfers_to_fk" FOREIGN KEY ("workspace_id","to_membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_assignments" ADD CONSTRAINT "responsibility_assignments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_assignments" ADD CONSTRAINT "responsibility_assignments_member_fk" FOREIGN KEY ("workspace_id","membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_membership_fk" FOREIGN KEY ("workspace_id","membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_role_fk" FOREIGN KEY ("workspace_id","role_id") REFERENCES "public"."roles"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_assignments" ADD CONSTRAINT "account_assignments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_assignments" ADD CONSTRAINT "account_assignments_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "public"."social_accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_assignments" ADD CONSTRAINT "account_assignments_member_fk" FOREIGN KEY ("workspace_id","membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_identity_history" ADD CONSTRAINT "account_identity_history_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_identity_history" ADD CONSTRAINT "aih_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "public"."social_accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_status_events" ADD CONSTRAINT "account_status_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_status_events" ADD CONSTRAINT "ase_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "public"."social_accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_transfers" ADD CONSTRAINT "account_transfers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_transfers" ADD CONSTRAINT "account_transfers_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "public"."social_accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_versions" ADD CONSTRAINT "character_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_versions" ADD CONSTRAINT "character_versions_character_fk" FOREIGN KEY ("workspace_id","character_id") REFERENCES "public"."characters"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directions" ADD CONSTRAINT "directions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directions" ADD CONSTRAINT "directions_lead_fk" FOREIGN KEY ("workspace_id","lead_membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_season_fk" FOREIGN KEY ("workspace_id","season_id") REFERENCES "public"."seasons"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_decisions" ADD CONSTRAINT "project_decisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_decisions" ADD CONSTRAINT "project_decisions_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_direction_history" ADD CONSTRAINT "project_direction_history_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_direction_history" ADD CONSTRAINT "pdh_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_member_fk" FOREIGN KEY ("workspace_id","membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_direction_fk" FOREIGN KEY ("workspace_id","direction_id") REFERENCES "public"."directions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_fk" FOREIGN KEY ("workspace_id","owner_membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reference_links" ADD CONSTRAINT "reference_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reference_links" ADD CONSTRAINT "reference_links_ref_fk" FOREIGN KEY ("workspace_id","reference_id") REFERENCES "public"."references"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "references" ADD CONSTRAINT "references_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "references" ADD CONSTRAINT "references_owner_fk" FOREIGN KEY ("workspace_id","owner_membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "references" ADD CONSTRAINT "references_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scene_characters" ADD CONSTRAINT "scene_characters_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scene_characters" ADD CONSTRAINT "scene_characters_scene_fk" FOREIGN KEY ("workspace_id","scene_id") REFERENCES "public"."scenes"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scene_characters" ADD CONSTRAINT "scene_characters_cv_fk" FOREIGN KEY ("workspace_id","character_version_id") REFERENCES "public"."character_versions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_episode_fk" FOREIGN KEY ("workspace_id","episode_id") REFERENCES "public"."episodes"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_owner_fk" FOREIGN KEY ("workspace_id","owner_membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_acknowledgements" ADD CONSTRAINT "article_acknowledgements_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_acknowledgements" ADD CONSTRAINT "article_ack_version_fk" FOREIGN KEY ("workspace_id","article_version_id") REFERENCES "public"."article_versions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_acknowledgements" ADD CONSTRAINT "article_ack_member_fk" FOREIGN KEY ("workspace_id","membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_categories" ADD CONSTRAINT "article_categories_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_versions" ADD CONSTRAINT "article_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_versions" ADD CONSTRAINT "article_versions_article_fk" FOREIGN KEY ("workspace_id","article_id") REFERENCES "public"."articles"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_category_fk" FOREIGN KEY ("workspace_id","category_id") REFERENCES "public"."article_categories"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_owner_fk" FOREIGN KEY ("workspace_id","owner_membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_derivatives" ADD CONSTRAINT "asset_derivatives_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_derivatives" ADD CONSTRAINT "asset_derivatives_version_fk" FOREIGN KEY ("workspace_id","asset_version_id") REFERENCES "public"."asset_versions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_links" ADD CONSTRAINT "asset_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_links" ADD CONSTRAINT "asset_links_asset_fk" FOREIGN KEY ("workspace_id","asset_id") REFERENCES "public"."assets"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_links" ADD CONSTRAINT "asset_links_version_fk" FOREIGN KEY ("workspace_id","asset_version_id") REFERENCES "public"."asset_versions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_versions" ADD CONSTRAINT "asset_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_versions" ADD CONSTRAINT "asset_versions_asset_fk" FOREIGN KEY ("workspace_id","asset_id") REFERENCES "public"."assets"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_folder_fk" FOREIGN KEY ("workspace_id","folder_id") REFERENCES "public"."folders"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_fk" FOREIGN KEY ("workspace_id","parent_id") REFERENCES "public"."folders"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_assignments" ADD CONSTRAINT "reading_assignments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_assignments" ADD CONSTRAINT "reading_assignments_version_fk" FOREIGN KEY ("workspace_id","article_version_id") REFERENCES "public"."article_versions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_assignments" ADD CONSTRAINT "reading_assignments_member_fk" FOREIGN KEY ("workspace_id","membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_revisions" ADD CONSTRAINT "comment_revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_revisions" ADD CONSTRAINT "comment_revisions_comment_fk" FOREIGN KEY ("workspace_id","comment_id") REFERENCES "public"."comments"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_fk" FOREIGN KEY ("workspace_id","author_membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_characters" ADD CONSTRAINT "content_characters_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_characters" ADD CONSTRAINT "content_characters_content_fk" FOREIGN KEY ("workspace_id","content_item_id") REFERENCES "public"."content_items"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_characters" ADD CONSTRAINT "content_characters_cv_fk" FOREIGN KEY ("workspace_id","character_version_id") REFERENCES "public"."character_versions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_flag_intervals" ADD CONSTRAINT "content_flag_intervals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_flag_intervals" ADD CONSTRAINT "cfi_content_fk" FOREIGN KEY ("workspace_id","content_item_id") REFERENCES "public"."content_items"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_owner_fk" FOREIGN KEY ("workspace_id","owner_membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_reviewer_fk" FOREIGN KEY ("workspace_id","reviewer_membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_stage_events" ADD CONSTRAINT "content_stage_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_stage_events" ADD CONSTRAINT "cse_content_fk" FOREIGN KEY ("workspace_id","content_item_id") REFERENCES "public"."content_items"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_version_assets" ADD CONSTRAINT "content_version_assets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_version_assets" ADD CONSTRAINT "cva_version_fk" FOREIGN KEY ("workspace_id","content_version_id") REFERENCES "public"."content_versions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_version_assets" ADD CONSTRAINT "cva_asset_version_fk" FOREIGN KEY ("workspace_id","asset_version_id") REFERENCES "public"."asset_versions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_content_fk" FOREIGN KEY ("workspace_id","content_item_id") REFERENCES "public"."content_items"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_review_fk" FOREIGN KEY ("workspace_id","review_id") REFERENCES "public"."reviews"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reviewer_fk" FOREIGN KEY ("workspace_id","reviewer_membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absences" ADD CONSTRAINT "absences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absences" ADD CONSTRAINT "absences_member_fk" FOREIGN KEY ("workspace_id","membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capacities" ADD CONSTRAINT "capacities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capacities" ADD CONSTRAINT "capacities_member_fk" FOREIGN KEY ("workspace_id","membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_reminders" ADD CONSTRAINT "personal_reminders_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_reminders" ADD CONSTRAINT "personal_reminders_member_fk" FOREIGN KEY ("workspace_id","membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurrence_occurrences" ADD CONSTRAINT "recurrence_occurrences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurrence_occurrences" ADD CONSTRAINT "recurrence_occurrences_rule_fk" FOREIGN KEY ("workspace_id","rule_id") REFERENCES "public"."recurrence_rules"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurrence_rules" ADD CONSTRAINT "recurrence_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurrence_rules" ADD CONSTRAINT "recurrence_rules_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_block_intervals" ADD CONSTRAINT "task_block_intervals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_block_intervals" ADD CONSTRAINT "task_block_intervals_task_fk" FOREIGN KEY ("workspace_id","task_id") REFERENCES "public"."tasks"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_checklist_items" ADD CONSTRAINT "task_checklist_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_checklist_items" ADD CONSTRAINT "task_checklist_items_task_fk" FOREIGN KEY ("workspace_id","task_id") REFERENCES "public"."tasks"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_pred_fk" FOREIGN KEY ("workspace_id","predecessor_id") REFERENCES "public"."tasks"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_succ_fk" FOREIGN KEY ("workspace_id","successor_id") REFERENCES "public"."tasks"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_due_revisions" ADD CONSTRAINT "task_due_revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_due_revisions" ADD CONSTRAINT "task_due_revisions_task_fk" FOREIGN KEY ("workspace_id","task_id") REFERENCES "public"."tasks"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_status_events" ADD CONSTRAINT "task_status_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_status_events" ADD CONSTRAINT "task_status_events_task_fk" FOREIGN KEY ("workspace_id","task_id") REFERENCES "public"."tasks"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_fk" FOREIGN KEY ("workspace_id","assignee_membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_reviewer_fk" FOREIGN KEY ("workspace_id","reviewer_membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_fk" FOREIGN KEY ("workspace_id","parent_task_id") REFERENCES "public"."tasks"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "public"."social_accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_content_fk" FOREIGN KEY ("workspace_id","content_item_id") REFERENCES "public"."content_items"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_member_fk" FOREIGN KEY ("workspace_id","membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_task_fk" FOREIGN KEY ("workspace_id","task_id") REFERENCES "public"."tasks"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_sheet_submissions" ADD CONSTRAINT "time_sheet_submissions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_sheet_submissions" ADD CONSTRAINT "tss_member_fk" FOREIGN KEY ("workspace_id","membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workload_allocations" ADD CONSTRAINT "workload_allocations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workload_allocations" ADD CONSTRAINT "workload_allocations_task_fk" FOREIGN KEY ("workspace_id","task_id") REFERENCES "public"."tasks"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_projects" ADD CONSTRAINT "campaign_projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_projects" ADD CONSTRAINT "campaign_projects_campaign_fk" FOREIGN KEY ("workspace_id","campaign_id") REFERENCES "public"."campaigns"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_projects" ADD CONSTRAINT "campaign_projects_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_source_reports" ADD CONSTRAINT "campaign_source_reports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_source_reports" ADD CONSTRAINT "csr_campaign_fk" FOREIGN KEY ("workspace_id","campaign_id") REFERENCES "public"."campaigns"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_owner_fk" FOREIGN KEY ("workspace_id","owner_membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_projects" ADD CONSTRAINT "deal_projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_projects" ADD CONSTRAINT "deal_projects_deal_fk" FOREIGN KEY ("workspace_id","deal_id") REFERENCES "public"."deals"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_projects" ADD CONSTRAINT "deal_projects_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_stage_events" ADD CONSTRAINT "deal_stage_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_stage_events" ADD CONSTRAINT "dse_deal_fk" FOREIGN KEY ("workspace_id","deal_id") REFERENCES "public"."deals"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_partner_fk" FOREIGN KEY ("workspace_id","partner_id") REFERENCES "public"."partners"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_owner_fk" FOREIGN KEY ("workspace_id","owner_membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_deal_fk" FOREIGN KEY ("workspace_id","deal_id") REFERENCES "public"."deals"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_publications" ADD CONSTRAINT "experiment_publications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_publications" ADD CONSTRAINT "ep_experiment_fk" FOREIGN KEY ("workspace_id","experiment_id") REFERENCES "public"."experiments"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_publications" ADD CONSTRAINT "ep_variant_fk" FOREIGN KEY ("workspace_id","variant_id") REFERENCES "public"."experiment_variants"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_publications" ADD CONSTRAINT "ep_publication_fk" FOREIGN KEY ("workspace_id","publication_id") REFERENCES "public"."publications"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_revisions" ADD CONSTRAINT "experiment_revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_revisions" ADD CONSTRAINT "er_experiment_fk" FOREIGN KEY ("workspace_id","experiment_id") REFERENCES "public"."experiments"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_variants" ADD CONSTRAINT "experiment_variants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_variants" ADD CONSTRAINT "experiment_variants_exp_fk" FOREIGN KEY ("workspace_id","experiment_id") REFERENCES "public"."experiments"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_interactions" ADD CONSTRAINT "partner_interactions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_interactions" ADD CONSTRAINT "pi_partner_fk" FOREIGN KEY ("workspace_id","partner_id") REFERENCES "public"."partners"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partners" ADD CONSTRAINT "partners_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partners" ADD CONSTRAINT "partners_owner_fk" FOREIGN KEY ("workspace_id","owner_membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_baseline_items" ADD CONSTRAINT "plan_baseline_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_baseline_items" ADD CONSTRAINT "pbi_baseline_fk" FOREIGN KEY ("workspace_id","baseline_id") REFERENCES "public"."plan_baselines"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_baseline_items" ADD CONSTRAINT "pbi_publication_fk" FOREIGN KEY ("workspace_id","publication_id") REFERENCES "public"."publications"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_baselines" ADD CONSTRAINT "plan_baselines_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_corrections" ADD CONSTRAINT "publication_corrections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_corrections" ADD CONSTRAINT "pc_publication_fk" FOREIGN KEY ("workspace_id","publication_id") REFERENCES "public"."publications"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_plan_revisions" ADD CONSTRAINT "publication_plan_revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_plan_revisions" ADD CONSTRAINT "ppr_publication_fk" FOREIGN KEY ("workspace_id","publication_id") REFERENCES "public"."publications"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_content_fk" FOREIGN KEY ("workspace_id","content_item_id") REFERENCES "public"."content_items"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_version_fk" FOREIGN KEY ("workspace_id","content_version_id") REFERENCES "public"."content_versions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "public"."social_accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_owner_fk" FOREIGN KEY ("workspace_id","owner_membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_campaign_fk" FOREIGN KEY ("workspace_id","primary_campaign_id") REFERENCES "public"."campaigns"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracking_links" ADD CONSTRAINT "tracking_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracking_links" ADD CONSTRAINT "tracking_links_campaign_fk" FOREIGN KEY ("workspace_id","campaign_id") REFERENCES "public"."campaigns"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erasure_requests" ADD CONSTRAINT "erasure_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handover_items" ADD CONSTRAINT "handover_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handover_items" ADD CONSTRAINT "handover_items_handover_fk" FOREIGN KEY ("workspace_id","handover_id") REFERENCES "public"."handovers"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_from_shift_fk" FOREIGN KEY ("workspace_id","from_shift_id") REFERENCES "public"."shifts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_to_shift_fk" FOREIGN KEY ("workspace_id","to_shift_id") REFERENCES "public"."shifts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_logs" ADD CONSTRAINT "interaction_logs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_logs" ADD CONSTRAINT "interaction_logs_contact_fk" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "public"."ofm_contacts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ofm_assignments" ADD CONSTRAINT "ofm_assignments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ofm_assignments" ADD CONSTRAINT "ofm_assignments_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ofm_assignments" ADD CONSTRAINT "ofm_assignments_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "public"."social_accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ofm_assignments" ADD CONSTRAINT "ofm_assignments_member_fk" FOREIGN KEY ("workspace_id","membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ofm_contact_relations" ADD CONSTRAINT "ofm_contact_relations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ofm_contact_relations" ADD CONSTRAINT "ocr_a_fk" FOREIGN KEY ("workspace_id","contact_a_id") REFERENCES "public"."ofm_contacts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ofm_contact_relations" ADD CONSTRAINT "ocr_b_fk" FOREIGN KEY ("workspace_id","contact_b_id") REFERENCES "public"."ofm_contacts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ofm_contacts" ADD CONSTRAINT "ofm_contacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ofm_contacts" ADD CONSTRAINT "ofm_contacts_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "public"."social_accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ofm_contacts" ADD CONSTRAINT "ofm_contacts_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ofm_profiles" ADD CONSTRAINT "ofm_profiles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ofm_profiles" ADD CONSTRAINT "ofm_profiles_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "public"."social_accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_contact_fk" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "public"."ofm_contacts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_owner_fk" FOREIGN KEY ("workspace_id","owner_membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_disputes" ADD CONSTRAINT "quality_disputes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_disputes" ADD CONSTRAINT "quality_disputes_review_fk" FOREIGN KEY ("workspace_id","quality_review_id") REFERENCES "public"."quality_reviews"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_reviews" ADD CONSTRAINT "quality_reviews_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_reviews" ADD CONSTRAINT "quality_reviews_rubric_fk" FOREIGN KEY ("workspace_id","rubric_version_id") REFERENCES "public"."rubric_versions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rubric_versions" ADD CONSTRAINT "rubric_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_candidates" ADD CONSTRAINT "sale_candidates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_candidates" ADD CONSTRAINT "sale_candidates_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "public"."social_accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_accounts" ADD CONSTRAINT "shift_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_accounts" ADD CONSTRAINT "shift_accounts_shift_fk" FOREIGN KEY ("workspace_id","shift_id") REFERENCES "public"."shifts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_accounts" ADD CONSTRAINT "shift_accounts_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "public"."social_accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_breaks" ADD CONSTRAINT "shift_breaks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_breaks" ADD CONSTRAINT "shift_breaks_shift_fk" FOREIGN KEY ("workspace_id","shift_id") REFERENCES "public"."shifts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_report_versions" ADD CONSTRAINT "shift_report_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_report_versions" ADD CONSTRAINT "srv_report_fk" FOREIGN KEY ("workspace_id","report_id") REFERENCES "public"."shift_reports"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_reports" ADD CONSTRAINT "shift_reports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_reports" ADD CONSTRAINT "shift_reports_shift_fk" FOREIGN KEY ("workspace_id","shift_id") REFERENCES "public"."shifts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "ssr_shift_fk" FOREIGN KEY ("workspace_id","shift_id") REFERENCES "public"."shifts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_time_corrections" ADD CONSTRAINT "shift_time_corrections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_time_corrections" ADD CONSTRAINT "stc_shift_fk" FOREIGN KEY ("workspace_id","shift_id") REFERENCES "public"."shifts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_account_fk" FOREIGN KEY ("workspace_id","primary_account_id") REFERENCES "public"."social_accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_member_fk" FOREIGN KEY ("workspace_id","membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoint_policies" ADD CONSTRAINT "checkpoint_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_check_ins" ADD CONSTRAINT "goal_check_ins_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_check_ins" ADD CONSTRAINT "goal_check_ins_goal_fk" FOREIGN KEY ("workspace_id","goal_id") REFERENCES "public"."goals"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_revisions" ADD CONSTRAINT "goal_revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_revisions" ADD CONSTRAINT "goal_revisions_goal_fk" FOREIGN KEY ("workspace_id","goal_id") REFERENCES "public"."goals"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_owner_fk" FOREIGN KEY ("workspace_id","owner_membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_checkpoints" ADD CONSTRAINT "metric_checkpoints_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_observations" ADD CONSTRAINT "metric_observations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_values" ADD CONSTRAINT "metric_values_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_values" ADD CONSTRAINT "metric_values_observation_fk" FOREIGN KEY ("workspace_id","observation_id") REFERENCES "public"."metric_observations"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_report_fk" FOREIGN KEY ("workspace_id","report_id") REFERENCES "public"."saved_reports"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_snapshots" ADD CONSTRAINT "report_snapshots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_snapshots" ADD CONSTRAINT "report_snapshots_report_fk" FOREIGN KEY ("workspace_id","report_id") REFERENCES "public"."saved_reports"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_reports" ADD CONSTRAINT "saved_reports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_reports" ADD CONSTRAINT "saved_reports_owner_fk" FOREIGN KEY ("workspace_id","owner_membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_version_fk" FOREIGN KEY ("workspace_id","budget_version_id") REFERENCES "public"."budget_versions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_category_fk" FOREIGN KEY ("workspace_id","category_id") REFERENCES "public"."finance_categories"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_versions" ADD CONSTRAINT "budget_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_versions" ADD CONSTRAINT "budget_versions_budget_fk" FOREIGN KEY ("workspace_id","budget_id") REFERENCES "public"."budgets"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_owner_fk" FOREIGN KEY ("workspace_id","owner_membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitment_consumptions" ADD CONSTRAINT "commitment_consumptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitment_consumptions" ADD CONSTRAINT "cc_commitment_fk" FOREIGN KEY ("workspace_id","commitment_id") REFERENCES "public"."commitments"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_adjustments" ADD CONSTRAINT "compensation_adjustments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_claims" ADD CONSTRAINT "compensation_claims_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_lines" ADD CONSTRAINT "compensation_lines_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_lines" ADD CONSTRAINT "compensation_lines_run_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."compensation_runs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_rule_versions" ADD CONSTRAINT "compensation_rule_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_rule_versions" ADD CONSTRAINT "crv_rule_fk" FOREIGN KEY ("workspace_id","rule_id") REFERENCES "public"."compensation_rules"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_rules" ADD CONSTRAINT "compensation_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_runs" ADD CONSTRAINT "compensation_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_categories" ADD CONSTRAINT "finance_categories_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_allocations" ADD CONSTRAINT "financial_allocations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_allocations" ADD CONSTRAINT "fa_line_fk" FOREIGN KEY ("workspace_id","line_id") REFERENCES "public"."financial_entry_lines"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_entries" ADD CONSTRAINT "financial_entries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_entry_lines" ADD CONSTRAINT "financial_entry_lines_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_entry_lines" ADD CONSTRAINT "fel_entry_fk" FOREIGN KEY ("workspace_id","entry_id") REFERENCES "public"."financial_entries"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_entry_lines" ADD CONSTRAINT "fel_category_fk" FOREIGN KEY ("workspace_id","category_id") REFERENCES "public"."finance_categories"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_rates" ADD CONSTRAINT "fx_rates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_locks" ADD CONSTRAINT "period_locks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_attributions" ADD CONSTRAINT "revenue_attributions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_attributions" ADD CONSTRAINT "ra_entry_fk" FOREIGN KEY ("workspace_id","entry_id") REFERENCES "public"."financial_entries"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_allocations" ADD CONSTRAINT "settlement_allocations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_allocations" ADD CONSTRAINT "sa_settlement_fk" FOREIGN KEY ("workspace_id","settlement_id") REFERENCES "public"."settlements"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_rule_versions" ADD CONSTRAINT "automation_rule_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_rule_versions" ADD CONSTRAINT "arv_rule_fk" FOREIGN KEY ("workspace_id","rule_id") REFERENCES "public"."automation_rules"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_rule_fk" FOREIGN KEY ("workspace_id","rule_id") REFERENCES "public"."automation_rules"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_previews" ADD CONSTRAINT "bulk_previews_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_def_fk" FOREIGN KEY ("workspace_id","definition_id") REFERENCES "public"."custom_field_definitions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_references" ADD CONSTRAINT "external_references_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_job_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."import_jobs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_fk" FOREIGN KEY ("workspace_id","recipient_membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_owner_fk" FOREIGN KEY ("workspace_id","owner_membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_applications" ADD CONSTRAINT "template_applications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_applications" ADD CONSTRAINT "template_applications_version_fk" FOREIGN KEY ("workspace_id","template_version_id") REFERENCES "public"."template_versions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_template_fk" FOREIGN KEY ("workspace_id","template_id") REFERENCES "public"."templates"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_challenges_token_uq" ON "auth_challenges" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_requests_open_uq" ON "invitation_requests" USING btree ("invitation_id") WHERE status = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_token_uq" ON "invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "invitations_ws_email_idx" ON "invitations" USING btree ("workspace_id","email_normalized");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_ws_user_uq" ON "memberships" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "memberships_ws_status_idx" ON "memberships" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "ownership_transfers_pending_uq" ON "ownership_transfers" USING btree ("workspace_id") WHERE status = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "password_reset_tokens_hash_uq" ON "password_reset_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "recovery_codes_user_idx" ON "recovery_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "role_assignments_member_idx" ON "role_assignments" USING btree ("workspace_id","membership_id","revoked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_ws_key_uq" ON "roles" USING btree ("workspace_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_uq" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id","revoked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_normalized_email_uq" ON "users" USING btree ("normalized_email");--> statement-breakpoint
CREATE INDEX "account_assignments_member_idx" ON "account_assignments" USING btree ("workspace_id","membership_id","valid_to");--> statement-breakpoint
CREATE UNIQUE INDEX "character_versions_no_uq" ON "character_versions" USING btree ("character_id","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "characters_primary_uq" ON "characters" USING btree ("project_id") WHERE is_primary AND archived_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "directions_active_name_uq" ON "directions" USING btree ("workspace_id","name_key") WHERE status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "episodes_number_uq" ON "episodes" USING btree ("season_id","number","language") WHERE archived_at IS NULL;--> statement-breakpoint
CREATE INDEX "project_memberships_member_idx" ON "project_memberships" USING btree ("workspace_id","membership_id","valid_to");--> statement-breakpoint
CREATE INDEX "project_memberships_project_idx" ON "project_memberships" USING btree ("workspace_id","project_id","valid_to");--> statement-breakpoint
CREATE INDEX "projects_list_idx" ON "projects" USING btree ("workspace_id","status","updated_at","id");--> statement-breakpoint
CREATE INDEX "projects_direction_idx" ON "projects" USING btree ("workspace_id","direction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reference_links_uq" ON "reference_links" USING btree ("reference_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "reference_links_target_idx" ON "reference_links" USING btree ("workspace_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "references_list_idx" ON "references" USING btree ("workspace_id","updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "scene_characters_uq" ON "scene_characters" USING btree ("scene_id","character_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "social_accounts_identity_uq" ON "social_accounts" USING btree ("workspace_id","identity_key") WHERE archived_at IS NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "social_accounts_list_idx" ON "social_accounts" USING btree ("workspace_id","status","updated_at","id");--> statement-breakpoint
CREATE INDEX "social_accounts_project_idx" ON "social_accounts" USING btree ("workspace_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "article_ack_uq" ON "article_acknowledgements" USING btree ("article_version_id","membership_id");--> statement-breakpoint
CREATE UNIQUE INDEX "article_versions_no_uq" ON "article_versions" USING btree ("article_id","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_derivatives_kind_uq" ON "asset_derivatives" USING btree ("asset_version_id","kind");--> statement-breakpoint
CREATE INDEX "asset_links_entity_idx" ON "asset_links" USING btree ("workspace_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "asset_links_asset_idx" ON "asset_links" USING btree ("workspace_id","asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_versions_no_uq" ON "asset_versions" USING btree ("asset_id","version_no");--> statement-breakpoint
CREATE INDEX "asset_versions_checksum_idx" ON "asset_versions" USING btree ("workspace_id","checksum_sha256");--> statement-breakpoint
CREATE INDEX "assets_list_idx" ON "assets" USING btree ("workspace_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "folders_parent_idx" ON "folders" USING btree ("workspace_id","parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reading_assignments_uq" ON "reading_assignments" USING btree ("article_version_id","membership_id");--> statement-breakpoint
CREATE INDEX "upload_sessions_state_idx" ON "upload_sessions" USING btree ("state","expires_at");--> statement-breakpoint
CREATE INDEX "comments_parent_idx" ON "comments" USING btree ("workspace_id","parent_type","parent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "content_characters_uq" ON "content_characters" USING btree ("content_item_id","character_version_id");--> statement-breakpoint
CREATE INDEX "content_items_list_idx" ON "content_items" USING btree ("workspace_id","stage","updated_at","id");--> statement-breakpoint
CREATE INDEX "content_items_project_idx" ON "content_items" USING btree ("workspace_id","project_id","stage");--> statement-breakpoint
CREATE INDEX "cse_content_idx" ON "content_stage_events" USING btree ("workspace_id","content_item_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cva_slot_uq" ON "content_version_assets" USING btree ("content_version_id","slot","position");--> statement-breakpoint
CREATE UNIQUE INDEX "content_versions_no_uq" ON "content_versions" USING btree ("content_item_id","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "review_decisions_final_uq" ON "review_decisions" USING btree ("review_id") WHERE decision <> 'revoked';--> statement-breakpoint
CREATE INDEX "reviews_queue_idx" ON "reviews" USING btree ("workspace_id","status","submitted_at");--> statement-breakpoint
CREATE INDEX "reviews_subject_idx" ON "reviews" USING btree ("workspace_id","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_target_step_uq" ON "reviews" USING btree ("target_id","step_kind","round_no");--> statement-breakpoint
CREATE UNIQUE INDEX "capacities_member_from_uq" ON "capacities" USING btree ("membership_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "recurrence_occurrences_key_uq" ON "recurrence_occurrences" USING btree ("rule_id","occurrence_key");--> statement-breakpoint
CREATE INDEX "task_checklist_items_task_idx" ON "task_checklist_items" USING btree ("workspace_id","task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_dependencies_active_uq" ON "task_dependencies" USING btree ("predecessor_id","successor_id") WHERE removed_at IS NULL;--> statement-breakpoint
CREATE INDEX "task_status_events_task_idx" ON "task_status_events" USING btree ("workspace_id","task_id","occurred_at");--> statement-breakpoint
CREATE INDEX "tasks_list_idx" ON "tasks" USING btree ("workspace_id","status","updated_at","id");--> statement-breakpoint
CREATE INDEX "tasks_assignee_due_idx" ON "tasks" USING btree ("workspace_id","assignee_membership_id","due_at");--> statement-breakpoint
CREATE INDEX "tasks_project_idx" ON "tasks" USING btree ("workspace_id","project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "time_entries_one_running_uq" ON "time_entries" USING btree ("membership_id") WHERE state = 'running';--> statement-breakpoint
CREATE INDEX "time_entries_member_date_idx" ON "time_entries" USING btree ("workspace_id","membership_id","work_date");--> statement-breakpoint
CREATE UNIQUE INDEX "workload_allocations_uq" ON "workload_allocations" USING btree ("task_id","membership_id","work_date");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_projects_uq" ON "campaign_projects" USING btree ("campaign_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deal_projects_uq" ON "deal_projects" USING btree ("deal_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ep_uq" ON "experiment_publications" USING btree ("experiment_id","publication_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pbi_uq" ON "plan_baseline_items" USING btree ("baseline_id","publication_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_baselines_week_uq" ON "plan_baselines" USING btree ("workspace_id","week_start");--> statement-breakpoint
CREATE UNIQUE INDEX "publications_post_url_uq" ON "publications" USING btree ("account_id","normalized_post_url") WHERE normalized_post_url IS NOT NULL;--> statement-breakpoint
CREATE INDEX "publications_account_published_idx" ON "publications" USING btree ("account_id","actual_published_at");--> statement-breakpoint
CREATE INDEX "publications_schedule_idx" ON "publications" USING btree ("workspace_id","status","scheduled_at");--> statement-breakpoint
CREATE INDEX "handovers_recipient_idx" ON "handovers" USING btree ("workspace_id","recipient_membership_id","state");--> statement-breakpoint
CREATE INDEX "interaction_logs_contact_idx" ON "interaction_logs" USING btree ("workspace_id","contact_id","occurred_at");--> statement-breakpoint
CREATE INDEX "ofm_assignments_member_idx" ON "ofm_assignments" USING btree ("workspace_id","membership_id","valid_to");--> statement-breakpoint
CREATE UNIQUE INDEX "ofm_contacts_identity_uq" ON "ofm_contacts" USING btree ("account_id","external_identifier");--> statement-breakpoint
CREATE INDEX "ofm_contacts_list_idx" ON "ofm_contacts" USING btree ("workspace_id","account_id","stage");--> statement-breakpoint
CREATE UNIQUE INDEX "ofm_profiles_project_uq" ON "ofm_profiles" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "operations_queue_idx" ON "operations" USING btree ("workspace_id","status","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rubric_versions_uq" ON "rubric_versions" USING btree ("workspace_id","rubric_key","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "sale_candidates_source_uq" ON "sale_candidates" USING btree ("workspace_id","source_namespace","source_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shift_accounts_uq" ON "shift_accounts" USING btree ("shift_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shift_breaks_one_open_uq" ON "shift_breaks" USING btree ("shift_id") WHERE ended_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "srv_no_uq" ON "shift_report_versions" USING btree ("report_id","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "shift_reports_shift_uq" ON "shift_reports" USING btree ("shift_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shifts_one_active_uq" ON "shifts" USING btree ("membership_id") WHERE state IN ('active', 'paused');--> statement-breakpoint
CREATE UNIQUE INDEX "shifts_occurrence_uq" ON "shifts" USING btree ("repeat_group_id","occurrence_key") WHERE occurrence_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shifts_member_time_idx" ON "shifts" USING btree ("workspace_id","membership_id","scheduled_start");--> statement-breakpoint
CREATE INDEX "shifts_state_idx" ON "shifts" USING btree ("workspace_id","state","scheduled_end");--> statement-breakpoint
CREATE UNIQUE INDEX "checkpoint_policies_version_uq" ON "checkpoint_policies" USING btree ("workspace_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "metric_checkpoints_occurrence_uq" ON "metric_checkpoints" USING btree ("workspace_id","occurrence_key");--> statement-breakpoint
CREATE INDEX "metric_checkpoints_due_idx" ON "metric_checkpoints" USING btree ("workspace_id","state","expected_at");--> statement-breakpoint
CREATE UNIQUE INDEX "metric_definitions_key_version_uq" ON "metric_definitions" USING btree ("key","version");--> statement-breakpoint
CREATE INDEX "metric_observations_entity_idx" ON "metric_observations" USING btree ("workspace_id","entity_type","entity_id","observed_at");--> statement-breakpoint
CREATE INDEX "metric_observations_account_idx" ON "metric_observations" USING btree ("workspace_id","account_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "metric_observations_dedupe_uq" ON "metric_observations" USING btree ("workspace_id","dedupe_key") WHERE quality_state NOT IN ('superseded', 'rejected', 'pending_correction');--> statement-breakpoint
CREATE UNIQUE INDEX "metric_values_uq" ON "metric_values" USING btree ("observation_id","metric_key");--> statement-breakpoint
CREATE INDEX "metric_values_key_idx" ON "metric_values" USING btree ("workspace_id","metric_key");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_alerts_active_uq" ON "budget_alerts" USING btree ("budget_version_id","threshold") WHERE reset_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "budget_lines_uq" ON "budget_lines" USING btree ("budget_version_id","category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_versions_no_uq" ON "budget_versions" USING btree ("budget_id","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "cc_uq" ON "commitment_consumptions" USING btree ("commitment_id","entry_line_id") WHERE reversed_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "compensation_claims_key_uq" ON "compensation_claims" USING btree ("workspace_id","entitlement_key");--> statement-breakpoint
CREATE INDEX "compensation_lines_run_idx" ON "compensation_lines" USING btree ("workspace_id","run_id","calculation_version");--> statement-breakpoint
CREATE UNIQUE INDEX "crv_no_uq" ON "compensation_rule_versions" USING btree ("rule_id","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_categories_key_uq" ON "finance_categories" USING btree ("workspace_id","key");--> statement-breakpoint
CREATE INDEX "fa_project_idx" ON "financial_allocations" USING btree ("workspace_id","project_id","effective_date");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_entries_source_uq" ON "financial_entries" USING btree ("workspace_id","source_namespace","source_external_id") WHERE source_external_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "financial_entries_reversal_uq" ON "financial_entries" USING btree ("reverses_entry_id") WHERE reverses_entry_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "financial_entries_comp_run_uq" ON "financial_entries" USING btree ("compensation_run_id") WHERE compensation_run_id IS NOT NULL AND reverses_entry_id IS NULL;--> statement-breakpoint
CREATE INDEX "financial_entries_recognition_idx" ON "financial_entries" USING btree ("workspace_id","state","recognition_date");--> statement-breakpoint
CREATE UNIQUE INDEX "fel_line_no_uq" ON "financial_entry_lines" USING btree ("entry_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "fel_transaction_uq" ON "financial_entry_lines" USING btree ("workspace_id","source_namespace","transaction_ref") WHERE transaction_ref IS NOT NULL AND is_reversal = false;--> statement-breakpoint
CREATE UNIQUE INDEX "fx_rates_uq" ON "fx_rates" USING btree ("workspace_id","from_currency","to_currency","effective_date","source");--> statement-breakpoint
CREATE UNIQUE INDEX "period_locks_active_uq" ON "period_locks" USING btree ("workspace_id","period_start") WHERE state = 'locked';--> statement-breakpoint
CREATE INDEX "sa_target_entry_idx" ON "settlement_allocations" USING btree ("workspace_id","target_entry_id");--> statement-breakpoint
CREATE INDEX "sa_target_run_idx" ON "settlement_allocations" USING btree ("workspace_id","target_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settlements_reference_uq" ON "settlements" USING btree ("workspace_id","payment_source_namespace","payment_reference") WHERE payment_reference IS NOT NULL;--> statement-breakpoint
CREATE INDEX "settlements_paid_idx" ON "settlements" USING btree ("workspace_id","state","paid_at");--> statement-breakpoint
CREATE INDEX "audit_events_ws_actor_idx" ON "audit_events" USING btree ("workspace_id","actor_membership_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_ws_entity_idx" ON "audit_events" USING btree ("workspace_id","entity_type","entity_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_ws_time_idx" ON "audit_events" USING btree ("workspace_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "arv_no_uq" ON "automation_rule_versions" USING btree ("rule_id","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_operation_uq" ON "automation_runs" USING btree ("workspace_id","operation_key");--> statement-breakpoint
CREATE INDEX "automation_runs_rule_idx" ON "automation_runs" USING btree ("workspace_id","rule_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_definitions_key_uq" ON "custom_field_definitions" USING btree ("workspace_id","entity_type","key") WHERE archived_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_values_uq" ON "custom_field_values" USING btree ("definition_id","entity_id");--> statement-breakpoint
CREATE INDEX "custom_field_values_entity_idx" ON "custom_field_values" USING btree ("workspace_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "deletion_tombstones_time_idx" ON "deletion_tombstones" USING btree ("executed_at");--> statement-breakpoint
CREATE INDEX "event_stream_ws_seq_idx" ON "event_stream" USING btree ("workspace_id","seq");--> statement-breakpoint
CREATE INDEX "export_jobs_requester_idx" ON "export_jobs" USING btree ("workspace_id","requested_by_membership_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "external_references_uq" ON "external_references" USING btree ("workspace_id","namespace","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_records_scope_uq" ON "idempotency_records" USING btree ("scope_key");--> statement-breakpoint
CREATE INDEX "idempotency_records_expiry_idx" ON "idempotency_records" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "import_rows_no_uq" ON "import_rows" USING btree ("job_id","row_no");--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_alert_open_uq" ON "incidents" USING btree ("workspace_id","alert_key") WHERE alert_key IS NOT NULL AND state <> 'resolved';--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("pool","state","run_at","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_idempotency_uq" ON "jobs" USING btree ("idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "mail_messages_status_idx" ON "mail_messages" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_uq" ON "notifications" USING btree ("workspace_id","event_key","recipient_membership_id","channel");--> statement-breakpoint
CREATE INDEX "notifications_inbox_idx" ON "notifications" USING btree ("workspace_id","recipient_membership_id","archived_at","read_at","created_at");--> statement-breakpoint
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" USING btree ("dispatched_at","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_events_seq_uq" ON "outbox_events" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "search_documents_tsv_idx" ON "search_documents" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "search_documents_title_trgm_idx" ON "search_documents" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "tags_name_uq" ON "tags" USING btree ("workspace_id","name_key");--> statement-breakpoint
CREATE UNIQUE INDEX "template_applications_key_uq" ON "template_applications" USING btree ("workspace_id","application_key");--> statement-breakpoint
CREATE UNIQUE INDEX "template_versions_no_uq" ON "template_versions" USING btree ("template_id","version_no");