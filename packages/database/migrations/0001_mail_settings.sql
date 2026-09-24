CREATE TABLE "mail_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"secure" boolean DEFAULT false NOT NULL,
	"username" text,
	"password_enc" text,
	"from_address" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	"row_version" integer DEFAULT 1 NOT NULL
);
