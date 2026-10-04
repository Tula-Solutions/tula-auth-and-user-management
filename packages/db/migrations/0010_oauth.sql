CREATE TABLE "tula"."oauth_providers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"client_id" text NOT NULL,
	"secret" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_providers_environment_provider_key" UNIQUE("environment_id","provider")
);
--> statement-breakpoint
ALTER TABLE "tula"."oauth_providers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tula"."oauth_providers" ADD CONSTRAINT "oauth_providers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."oauth_providers" ADD CONSTRAINT "oauth_providers_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."oauth_providers" ADD CONSTRAINT "oauth_providers_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_providers_environment_id_idx" ON "tula"."oauth_providers" USING btree ("environment_id");--> statement-breakpoint
ALTER TABLE "tula"."identities" ADD CONSTRAINT "identities_user_provider_key" UNIQUE("user_id","provider");--> statement-breakpoint
CREATE POLICY "oauth_providers_tenant_isolation" ON "tula"."oauth_providers" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
-- Added by hand (Drizzle cannot declare either). FORCE applies the policy to the table owner
-- too; src/rls.test.ts fails for a tenant table without it.
ALTER TABLE "tula"."oauth_providers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Runtime grants (new tables get none by default, see 0003). DELETE: an administrator removes a
-- provider's credentials on the request path (`DELETE /v1/admin/oauth-providers/:provider`).
GRANT SELECT, INSERT, UPDATE, DELETE ON "tula"."oauth_providers" TO tula_app;
