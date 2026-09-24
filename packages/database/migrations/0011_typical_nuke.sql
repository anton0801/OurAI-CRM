CREATE TABLE "saved_report_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"report_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"change_note" text,
	CONSTRAINT "saved_report_versions_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "metric_observations" ADD COLUMN "decision_note" text;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD COLUMN "last_run_result" jsonb;--> statement-breakpoint
ALTER TABLE "saved_report_versions" ADD CONSTRAINT "saved_report_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_report_versions" ADD CONSTRAINT "saved_report_versions_report_fk" FOREIGN KEY ("workspace_id","report_id") REFERENCES "public"."saved_reports"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "saved_report_versions_no_uq" ON "saved_report_versions" USING btree ("report_id","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "metric_observations_pending_uq" ON "metric_observations" USING btree ("workspace_id","root_observation_id") WHERE quality_state = 'pending_correction';--> statement-breakpoint
CREATE INDEX "metric_observations_publication_idx" ON "metric_observations" USING btree ("workspace_id","publication_id","observed_at");