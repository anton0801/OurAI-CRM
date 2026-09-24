CREATE TABLE "analytics_dashboard_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"row_version" bigint DEFAULT 1 NOT NULL,
	"tab" text NOT NULL,
	"cache_key" text NOT NULL,
	"input" jsonb NOT NULL,
	"scope_signature" text NOT NULL,
	"timezone" text NOT NULL,
	"membership_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"compute_ms" integer NOT NULL,
	"stale" boolean DEFAULT false NOT NULL,
	"last_requested_at" timestamp with time zone NOT NULL,
	CONSTRAINT "analytics_dashboard_snapshots_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "analytics_dashboard_snapshots" ADD CONSTRAINT "analytics_dashboard_snapshots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_dashboard_snapshots" ADD CONSTRAINT "analytics_dashboard_snapshots_member_fk" FOREIGN KEY ("workspace_id","membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_dashboard_snapshots_key_uq" ON "analytics_dashboard_snapshots" USING btree ("workspace_id","cache_key");--> statement-breakpoint
CREATE INDEX "analytics_dashboard_snapshots_refresh_idx" ON "analytics_dashboard_snapshots" USING btree ("workspace_id","stale","last_requested_at");