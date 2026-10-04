CREATE TABLE "tula"."instance_audit_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"ip_address" "inet",
	"user_agent" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "instance_audit_logs_occurred_idx" ON "tula"."instance_audit_logs" USING btree ("occurred_at");
--> statement-breakpoint
-- Runtime grants (new tables get none by default, see 0003). Append-only, like `audit_logs`:
-- the API may read and insert, never change or delete an entry. No row-level security: the
-- table is control plane (no tenant columns), as `workspaces` and `projects` are.
GRANT SELECT, INSERT ON "tula"."instance_audit_logs" TO tula_app;
