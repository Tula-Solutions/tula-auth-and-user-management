CREATE TABLE "tula"."proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"proposed_by" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_by_type" text,
	"approved_by_id" text,
	"approved_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposals_status_known" CHECK ("tula"."proposals"."status" in ('pending', 'approved', 'executed', 'failed')),
	CONSTRAINT "proposals_operation_shape" CHECK ("tula"."proposals"."operation" ~ '^[a-z_]{1,64}$'),
	CONSTRAINT "proposals_target_type_shape" CHECK ("tula"."proposals"."target_type" ~ '^[a-z_]{1,64}$'),
	CONSTRAINT "proposals_approval_whole" CHECK (("tula"."proposals"."status" = 'pending') = ("tula"."proposals"."approved_at" is null) and ("tula"."proposals"."status" = 'pending') = ("tula"."proposals"."approved_by_type" is null) and ("tula"."proposals"."approved_by_type" is null or "tula"."proposals"."approved_by_type" in ('admin', 'instance_admin')) and ("tula"."proposals"."approved_by_id" is null or ("tula"."proposals"."approved_by_type" is not null and char_length("tula"."proposals"."approved_by_id") between 1 and 128))),
	CONSTRAINT "proposals_failure_whole" CHECK (("tula"."proposals"."status" = 'failed') = ("tula"."proposals"."failure_reason" is not null) and ("tula"."proposals"."failure_reason" is null or "tula"."proposals"."failure_reason" ~ '^[a-z_]{1,64}$')),
	CONSTRAINT "proposals_lifetime_bounds" CHECK ("tula"."proposals"."expires_at" <= "tula"."proposals"."created_at" + interval '1 hour')
);
--> statement-breakpoint
ALTER TABLE "tula"."proposals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tula"."proposals" ADD CONSTRAINT "proposals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."proposals" ADD CONSTRAINT "proposals_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."proposals" ADD CONSTRAINT "proposals_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proposals_environment_created_idx" ON "tula"."proposals" USING btree ("environment_id","created_at");--> statement-breakpoint
CREATE INDEX "proposals_environment_id_idx" ON "tula"."proposals" USING btree ("environment_id");--> statement-breakpoint
CREATE POLICY "proposals_tenant_isolation" ON "tula"."proposals" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
-- Added by hand (Drizzle cannot declare any of what follows). FORCE applies the policy to the
-- table owner too; src/rls.test.ts fails for a tenant table without it.
ALTER TABLE "tula"."proposals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Runtime grants (new tables get none by default, see 0003).
--
-- An agent's proposal is inserted on the request path (`POST /v1/agent/proposals`), and the
-- retention job deletes rows long past their expiry (ADR 0053, ADR 0017).
GRANT SELECT, INSERT, DELETE ON "tula"."proposals" TO tula_app;
--> statement-breakpoint
-- UPDATE is by column, as for `hooks` in 0021: exactly what an approval and its outcome
-- write. Nothing else: the runtime role cannot rewrite what a proposal would do
-- (`operation`), to what (`target_type`, `target_id`), who asked (`proposed_by`) or until
-- when it may be approved (`expires_at`), nor its id, its tenant columns or `created_at`.
-- What a human approves is therefore what was proposed. Never widen this grant to one of
-- those columns.
GRANT UPDATE ("status", "approved_by_type", "approved_by_id", "approved_at", "failure_reason", "updated_at")
  ON "tula"."proposals" TO tula_app;