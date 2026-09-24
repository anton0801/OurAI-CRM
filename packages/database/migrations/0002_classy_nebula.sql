ALTER TABLE "article_categories" ADD COLUMN "name_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "article_categories" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "asset_versions" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "asset_versions" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "asset_versions" ADD COLUMN "delete_reason" text;--> statement-breakpoint
ALTER TABLE "asset_versions" ADD COLUMN "purged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "name_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "reading_assignments" ADD COLUMN "source" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "reading_assignments" ADD COLUMN "assigned_by_membership_id" uuid;--> statement-breakpoint
ALTER TABLE "reading_assignments" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reading_assignments" ADD COLUMN "close_reason" text;--> statement-breakpoint
CREATE UNIQUE INDEX "article_categories_name_uq" ON "article_categories" USING btree ("workspace_id","name_key") WHERE archived_at IS NULL;--> statement-breakpoint
CREATE INDEX "articles_list_idx" ON "articles" USING btree ("workspace_id","status","updated_at","id");--> statement-breakpoint
CREATE INDEX "assets_folder_idx" ON "assets" USING btree ("workspace_id","folder_id");--> statement-breakpoint
CREATE INDEX "assets_project_idx" ON "assets" USING btree ("workspace_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "folders_sibling_name_uq" ON "folders" USING btree ("workspace_id",coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),"name_key") WHERE archived_at IS NULL;--> statement-breakpoint
CREATE INDEX "reading_assignments_member_idx" ON "reading_assignments" USING btree ("workspace_id","membership_id","status");--> statement-breakpoint
CREATE INDEX "reading_assignments_article_idx" ON "reading_assignments" USING btree ("workspace_id","article_id","status");