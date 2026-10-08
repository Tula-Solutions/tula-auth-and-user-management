CREATE TABLE "tula"."hooks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"point" text NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"deadline_ms" integer DEFAULT 2000 NOT NULL,
	"failure_mode" text DEFAULT 'deny' NOT NULL,
	"last_failed_at" timestamp with time zone,
	"last_failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hooks_environment_point_key" UNIQUE("environment_id","point"),
	CONSTRAINT "hooks_deadline_bounds" CHECK ("tula"."hooks"."deadline_ms" between 100 and 5000),
	CONSTRAINT "hooks_failure_mode_known" CHECK ("tula"."hooks"."failure_mode" in ('deny', 'allow')),
	CONSTRAINT "hooks_last_failure_whole" CHECK (("tula"."hooks"."last_failed_at" is null) = ("tula"."hooks"."last_failure_reason" is null))
);
--> statement-breakpoint
ALTER TABLE "tula"."hooks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tula"."hooks" ADD CONSTRAINT "hooks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."hooks" ADD CONSTRAINT "hooks_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."hooks" ADD CONSTRAINT "hooks_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hooks_environment_id_idx" ON "tula"."hooks" USING btree ("environment_id");--> statement-breakpoint
CREATE POLICY "hooks_tenant_isolation" ON "tula"."hooks" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
-- Added by hand (Drizzle cannot declare any of what follows). FORCE applies the policy to the
-- table owner too; src/rls.test.ts fails for a tenant table without it.
ALTER TABLE "tula"."hooks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Runtime grants (new tables get none by default, see 0003).
--
-- An administrator registers and removes a hook on the request path (`/v1/admin/hooks`),
-- hence INSERT and DELETE; a sign-up reads the environment's hook (ADR 0035).
GRANT SELECT, INSERT, DELETE ON "tula"."hooks" TO tula_app;
--> statement-breakpoint
-- UPDATE is by column, as for `webhook_deliveries` in 0019: exactly what the API changes. An
-- administrator's update sets the address, the switch, the deadline and the failure mode
-- (with `updated_at`), and a failed call writes `last_failed_at` and `last_failure_reason`.
-- Nothing else: the runtime role cannot rewrite a hook's `secret` (so a sealed secret cannot
-- be swapped for another), its `point`, its id, its tenant columns or `created_at`. A secret
-- rotation, when one is built, extends this grant on purpose. The bounds of `deadline_ms`
-- are the table's own check, so no grant can get past them.
GRANT UPDATE ("url", "enabled", "deadline_ms", "failure_mode", "last_failed_at", "last_failure_reason", "updated_at")
  ON "tula"."hooks" TO tula_app;