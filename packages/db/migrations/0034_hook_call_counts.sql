CREATE TABLE "tula"."hook_call_counts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"hook_id" uuid NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"last_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hook_call_counts_hook_hour_outcome_key" UNIQUE("hook_id","hour","outcome"),
	CONSTRAINT "hook_call_counts_outcome_known" CHECK ("tula"."hook_call_counts"."outcome" in ('allowed', 'denied', 'failed', 'timed_out')),
	CONSTRAINT "hook_call_counts_calls_bounds" CHECK ("tula"."hook_call_counts"."calls" >= 0),
	CONSTRAINT "hook_call_counts_hour_whole" CHECK ("tula"."hook_call_counts"."hour" = date_trunc('hour', "tula"."hook_call_counts"."hour", 'UTC')),
	CONSTRAINT "hook_call_counts_last_at_in_hour" CHECK ("tula"."hook_call_counts"."last_at" >= "tula"."hook_call_counts"."hour" and "tula"."hook_call_counts"."last_at" < "tula"."hook_call_counts"."hour" + interval '1 hour')
);
--> statement-breakpoint
ALTER TABLE "tula"."hook_call_counts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Moved up by hand: the generator wrote this after the foreign key that refers to it
-- (`hook_call_counts_hook_fk`), which a database refuses (42830).
ALTER TABLE "tula"."hooks" ADD CONSTRAINT "hooks_environment_id_id_key" UNIQUE("environment_id","id");--> statement-breakpoint
ALTER TABLE "tula"."hook_call_counts" ADD CONSTRAINT "hook_call_counts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."hook_call_counts" ADD CONSTRAINT "hook_call_counts_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."hook_call_counts" ADD CONSTRAINT "hook_call_counts_hook_fk" FOREIGN KEY ("environment_id","hook_id") REFERENCES "tula"."hooks"("environment_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."hook_call_counts" ADD CONSTRAINT "hook_call_counts_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hook_call_counts_environment_id_idx" ON "tula"."hook_call_counts" USING btree ("environment_id");--> statement-breakpoint
CREATE POLICY "hook_call_counts_tenant_isolation" ON "tula"."hook_call_counts" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
-- Added by hand (Drizzle cannot declare any of what follows). FORCE applies the policy to the
-- table owner too; src/rls.test.ts fails for a tenant table without it.
ALTER TABLE "tula"."hook_call_counts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Runtime grants (new tables get none by default, see 0003).
--
-- A call of a hook inserts the row of its hook, hour and outcome or counts on it, after the
-- call was answered or failed; the admin API reads the last hours' rows beside a hook
-- (`recentOutcomes`); the retention job deletes the hours past its period (ADR 0035, "Recent
-- outcomes"; ADR 0017). Nothing is decided by these rows: they are what an operator is shown.
GRANT SELECT, INSERT, DELETE ON "tula"."hook_call_counts" TO tula_app;
--> statement-breakpoint
-- UPDATE is by column: the counter, when its latest call was, and `updated_at`. The runtime
-- role cannot move a row to another hook, hour, outcome or environment.
GRANT UPDATE ("calls", "last_at", "updated_at") ON "tula"."hook_call_counts" TO tula_app;
