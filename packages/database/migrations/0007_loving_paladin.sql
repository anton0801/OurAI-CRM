ALTER TABLE "compensation_runs" ADD COLUMN "submitted_by" uuid;--> statement-breakpoint
ALTER TABLE "financial_entries" ADD COLUMN "refund_of_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "financial_entry_lines" ADD COLUMN "fx_effect" text;--> statement-breakpoint
ALTER TABLE "financial_entry_lines" ADD COLUMN "commitment_id" uuid;--> statement-breakpoint
CREATE INDEX "fa_entry_idx" ON "financial_allocations" USING btree ("workspace_id","entry_id");--> statement-breakpoint
CREATE INDEX "fel_entry_idx" ON "financial_entry_lines" USING btree ("workspace_id","entry_id");--> statement-breakpoint
ALTER TABLE "financial_entry_lines" ADD CONSTRAINT "fel_fx_effect_ck" CHECK ("fx_effect" IS NULL OR "fx_effect" IN ('gain', 'loss'));