CREATE INDEX "erasure_requests_entity_idx" ON "erasure_requests" USING btree ("workspace_id","entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "erasure_requests_open_uq" ON "erasure_requests" USING btree ("entity_type","entity_id") WHERE state IN ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "handover_items_open_task_uq" ON "handover_items" USING btree ("task_id") WHERE state = 'open' AND task_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "handover_items_open_operation_uq" ON "handover_items" USING btree ("operation_id") WHERE state = 'open' AND operation_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "handover_items_handover_idx" ON "handover_items" USING btree ("workspace_id","handover_id");--> statement-breakpoint
CREATE INDEX "handovers_from_shift_idx" ON "handovers" USING btree ("workspace_id","from_shift_id");--> statement-breakpoint
CREATE INDEX "ofm_contacts_manager_idx" ON "ofm_contacts" USING btree ("workspace_id","manager_membership_id");--> statement-breakpoint
CREATE INDEX "operations_contact_idx" ON "operations" USING btree ("workspace_id","contact_id");--> statement-breakpoint
CREATE INDEX "operations_shift_idx" ON "operations" USING btree ("workspace_id","shift_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quality_disputes_one_open_uq" ON "quality_disputes" USING btree ("quality_review_id") WHERE state = 'open';--> statement-breakpoint
CREATE INDEX "quality_reviews_subject_idx" ON "quality_reviews" USING btree ("workspace_id","subject_membership_id","state");--> statement-breakpoint
CREATE INDEX "sale_candidates_state_idx" ON "sale_candidates" USING btree ("workspace_id","state","occurred_at");--> statement-breakpoint
CREATE INDEX "sale_candidates_shift_idx" ON "sale_candidates" USING btree ("workspace_id","shift_id");--> statement-breakpoint
CREATE INDEX "shift_accounts_account_idx" ON "shift_accounts" USING btree ("workspace_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ssr_one_open_uq" ON "shift_swap_requests" USING btree ("shift_id") WHERE state IN ('pending_acceptance', 'pending_approval');