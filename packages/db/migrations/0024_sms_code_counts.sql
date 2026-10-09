CREATE TABLE "tula"."sms_code_counts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"day" date NOT NULL,
	"prefix" text NOT NULL,
	"sent" integer DEFAULT 0 NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_code_counts_environment_day_prefix_key" UNIQUE("environment_id","day","prefix"),
	CONSTRAINT "sms_code_counts_prefix_shape" CHECK ("tula"."sms_code_counts"."prefix" ~ '^\+[0-9]{1,4}$'),
	CONSTRAINT "sms_code_counts_bounds" CHECK ("tula"."sms_code_counts"."sent" >= 0 and "tula"."sms_code_counts"."used" >= 0 and "tula"."sms_code_counts"."used" <= "tula"."sms_code_counts"."sent")
);
--> statement-breakpoint
ALTER TABLE "tula"."sms_code_counts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tula"."sms_code_counts" ADD CONSTRAINT "sms_code_counts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."sms_code_counts" ADD CONSTRAINT "sms_code_counts_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."sms_code_counts" ADD CONSTRAINT "sms_code_counts_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sms_code_counts_environment_id_idx" ON "tula"."sms_code_counts" USING btree ("environment_id");--> statement-breakpoint
CREATE POLICY "sms_code_counts_tenant_isolation" ON "tula"."sms_code_counts" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
-- Added by hand (Drizzle cannot declare any of what follows). FORCE applies the policy to the
-- table owner too; src/rls.test.ts fails for a tenant table without it.
ALTER TABLE "tula"."sms_code_counts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Runtime grants (new tables get none by default, see 0003).
--
-- A code about to be sent inserts its prefix's row for the day or counts on it, on the request
-- path, after the day's rows were added up for the daily limit; a message the sender did not
-- take is counted back out; the admin API reads the counts (`GET /v1/admin/sms/usage`); the
-- retention job deletes the rows of days past its period (ADR 0037, ADR 0017).
GRANT SELECT, INSERT, DELETE ON "tula"."sms_code_counts" TO tula_app;
--> statement-breakpoint
-- UPDATE is by column: the two counters and `updated_at`, which is all a sent or a used code
-- changes. The runtime role cannot rewrite a row's day, its prefix, its id, its tenant
-- columns or `created_at`: a count cannot be moved to another day or another destination.
GRANT UPDATE ("sent", "used", "updated_at") ON "tula"."sms_code_counts" TO tula_app;