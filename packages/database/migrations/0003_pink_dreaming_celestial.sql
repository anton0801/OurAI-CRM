ALTER TABLE "reference_links" ADD COLUMN "kind" text DEFAULT 'link' NOT NULL;--> statement-breakpoint
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "public"."social_accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_content_fk" FOREIGN KEY ("workspace_id","content_item_id") REFERENCES "public"."content_items"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_assignments_account_idx" ON "account_assignments" USING btree ("workspace_id","account_id","valid_to");--> statement-breakpoint
CREATE UNIQUE INDEX "account_assignments_open_uq" ON "account_assignments" USING btree ("account_id","membership_id","duty") WHERE valid_to IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "character_versions_open_uq" ON "character_versions" USING btree ("character_id") WHERE state IN ('draft', 'submitted');--> statement-breakpoint
CREATE UNIQUE INDEX "reference_links_idea_uq" ON "reference_links" USING btree ("reference_id") WHERE kind = 'idea';--> statement-breakpoint
CREATE UNIQUE INDEX "scenes_order_uq" ON "scenes" USING btree ("episode_id","order_no") WHERE archived_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "seasons_order_uq" ON "seasons" USING btree ("project_id","order_no") WHERE archived_at IS NULL;--> statement-breakpoint
CREATE INDEX "deal_projects_project_idx" ON "deal_projects" USING btree ("workspace_id","project_id");--> statement-breakpoint
CREATE INDEX "deals_list_idx" ON "deals" USING btree ("workspace_id","stage","updated_at","id");--> statement-breakpoint
CREATE INDEX "deals_partner_idx" ON "deals" USING btree ("workspace_id","partner_id");--> statement-breakpoint
CREATE INDEX "deliverables_deal_idx" ON "deliverables" USING btree ("workspace_id","deal_id");--> statement-breakpoint
CREATE INDEX "pi_partner_idx" ON "partner_interactions" USING btree ("workspace_id","partner_id","occurred_at");--> statement-breakpoint
CREATE INDEX "partners_list_idx" ON "partners" USING btree ("workspace_id","updated_at","id");--> statement-breakpoint
ALTER TABLE "references" ADD CONSTRAINT "references_source_ck" CHECK ("source_url" IS NOT NULL OR "source_asset_id" IS NOT NULL);