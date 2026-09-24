ALTER TABLE "comments" DROP CONSTRAINT "comments_severity_ck";--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_account_fk" FOREIGN KEY ("workspace_id","account_id") REFERENCES "public"."social_accounts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_items_account_idx" ON "content_items" USING btree ("workspace_id","account_id");--> statement-breakpoint
CREATE INDEX "content_items_owner_idx" ON "content_items" USING btree ("workspace_id","owner_membership_id","stage");--> statement-breakpoint
CREATE UNIQUE INDEX "content_versions_draft_uq" ON "content_versions" USING btree ("content_item_id") WHERE submitted_at IS NULL;--> statement-breakpoint
CREATE INDEX "reviews_reviewer_idx" ON "reviews" USING btree ("workspace_id","reviewer_membership_id","status");--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_severity_ck" CHECK ("severity" IN ('note', 'issue', 'blocking'));