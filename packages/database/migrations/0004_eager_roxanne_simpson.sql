ALTER TABLE "personal_reminders" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_reminders" ADD COLUMN "threshold" text;--> statement-breakpoint
ALTER TABLE "personal_reminders" ADD COLUMN "deadline_revision" integer;--> statement-breakpoint
ALTER TABLE "personal_reminders" ADD COLUMN "fired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "personal_reminders" ADD COLUMN "dismissed_reason" text;--> statement-breakpoint
ALTER TABLE "time_sheet_submissions" ADD COLUMN "approver_membership_id" uuid;--> statement-breakpoint
ALTER TABLE "time_sheet_submissions" ADD CONSTRAINT "tss_approver_fk" FOREIGN KEY ("workspace_id","approver_membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_reminders_member_idx" ON "personal_reminders" USING btree ("workspace_id","membership_id","dismissed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "personal_reminders_due_uq" ON "personal_reminders" USING btree ("membership_id","entity_type","entity_id","threshold","deadline_revision") WHERE source = 'due';--> statement-breakpoint
CREATE UNIQUE INDEX "tss_member_week_pending_uq" ON "time_sheet_submissions" USING btree ("membership_id","week_start") WHERE state = 'submitted';