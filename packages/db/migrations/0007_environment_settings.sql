CREATE TABLE "tula"."environment_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"settings" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environment_settings_environment_id_key" UNIQUE("environment_id")
);
--> statement-breakpoint
ALTER TABLE "tula"."environment_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tula"."environment_settings" ADD CONSTRAINT "environment_settings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."environment_settings" ADD CONSTRAINT "environment_settings_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."environment_settings" ADD CONSTRAINT "environment_settings_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "environment_settings_environment_id_idx" ON "tula"."environment_settings" USING btree ("environment_id");--> statement-breakpoint
CREATE POLICY "environment_settings_tenant_isolation" ON "tula"."environment_settings" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
-- Added by hand (Drizzle cannot declare either). FORCE applies the policy to the table owner
-- too; src/rls.test.ts fails for a tenant table without it.
ALTER TABLE "tula"."environment_settings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Runtime grants (new tables get none by default, see 0003). No DELETE: the API replaces an
-- environment's settings, it never removes them; the row goes when its environment does.
GRANT SELECT, INSERT, UPDATE ON "tula"."environment_settings" TO tula_app;
