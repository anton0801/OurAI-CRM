ALTER TABLE "automation_runs" ADD COLUMN "trigger_event" text;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "entity_type" text;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "entity_id" uuid;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "not_before" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "event_payload" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "automation_action_effects_run_idx" ON "automation_action_effects" USING btree ("workspace_id","run_id");--> statement-breakpoint
CREATE INDEX "automation_action_effects_entity_idx" ON "automation_action_effects" USING btree ("workspace_id","entity_id");--> statement-breakpoint
CREATE INDEX "automation_runs_root_idx" ON "automation_runs" USING btree ("workspace_id","root_event_id");