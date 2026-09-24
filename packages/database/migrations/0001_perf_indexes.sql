CREATE INDEX "tasks_open_due_idx" ON "tasks" USING btree ("workspace_id",coalesce("due_at", 'infinity'::timestamptz),"id") WHERE deleted_at IS NULL AND archived_at IS NULL AND status IN ('draft', 'backlog', 'ready', 'in_progress', 'in_review');--> statement-breakpoint
CREATE INDEX "tasks_parent_idx" ON "tasks" USING btree ("workspace_id","parent_task_id") WHERE parent_task_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tasks_content_item_idx" ON "tasks" USING btree ("workspace_id","content_item_id") WHERE content_item_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "publications_when_idx" ON "publications" USING btree ("workspace_id",coalesce("actual_published_at", "scheduled_at", "created_at"),"id");--> statement-breakpoint
CREATE INDEX "publications_content_item_idx" ON "publications" USING btree ("workspace_id","content_item_id");--> statement-breakpoint
CREATE INDEX "publications_project_schedule_idx" ON "publications" USING btree ("workspace_id","project_id","status","scheduled_at");--> statement-breakpoint
CREATE INDEX "metric_observations_project_idx" ON "metric_observations" USING btree ("workspace_id","project_id","observed_at");