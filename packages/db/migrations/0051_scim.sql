CREATE TABLE "tula"."scim_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scim_tokens_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "scim_tokens_name_bounds" CHECK (char_length("tula"."scim_tokens"."name") between 1 and 100)
);
--> statement-breakpoint
ALTER TABLE "tula"."scim_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tula"."scim_users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"external_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scim_users_organization_user_key" UNIQUE("organization_id","user_id"),
	CONSTRAINT "scim_users_organization_external_key" UNIQUE("organization_id","external_id"),
	CONSTRAINT "scim_users_external_id_bounds" CHECK ("tula"."scim_users"."external_id" is null or char_length("tula"."scim_users"."external_id") between 1 and 256)
);
--> statement-breakpoint
ALTER TABLE "tula"."scim_users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tula"."users" ADD COLUMN "managed_by_directory_id" uuid;--> statement-breakpoint
ALTER TABLE "tula"."scim_tokens" ADD CONSTRAINT "scim_tokens_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."scim_tokens" ADD CONSTRAINT "scim_tokens_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."scim_tokens" ADD CONSTRAINT "scim_tokens_organization_fk" FOREIGN KEY ("environment_id","organization_id") REFERENCES "tula"."organizations"("environment_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."scim_tokens" ADD CONSTRAINT "scim_tokens_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."scim_users" ADD CONSTRAINT "scim_users_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."scim_users" ADD CONSTRAINT "scim_users_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."scim_users" ADD CONSTRAINT "scim_users_organization_fk" FOREIGN KEY ("environment_id","organization_id") REFERENCES "tula"."organizations"("environment_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."scim_users" ADD CONSTRAINT "scim_users_user_fk" FOREIGN KEY ("environment_id","user_id") REFERENCES "tula"."users"("environment_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."scim_users" ADD CONSTRAINT "scim_users_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scim_tokens_organization_idx" ON "tula"."scim_tokens" USING btree ("environment_id","organization_id");--> statement-breakpoint
CREATE INDEX "scim_tokens_environment_id_idx" ON "tula"."scim_tokens" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "scim_users_user_idx" ON "tula"."scim_users" USING btree ("environment_id","user_id");--> statement-breakpoint
CREATE INDEX "scim_users_environment_id_idx" ON "tula"."scim_users" USING btree ("environment_id");--> statement-breakpoint
CREATE POLICY "scim_tokens_tenant_isolation" ON "tula"."scim_tokens" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "scim_users_tenant_isolation" ON "tula"."scim_users" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
-- Added by hand (Drizzle cannot declare any of what follows). FORCE applies the policy to the
-- table owner too; src/rls.test.ts fails for a tenant table without it.
ALTER TABLE "tula"."scim_tokens" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tula"."scim_users" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Runtime grants (ADR 0067, "SCIM"). A token's hash, organization and name never change; a
-- directory user row is never moved to another user or organization.
GRANT SELECT, INSERT, DELETE ON "tula"."scim_tokens" TO tula_app;
--> statement-breakpoint
GRANT UPDATE ("last_used_at", "revoked_at", "updated_at") ON "tula"."scim_tokens" TO tula_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "tula"."scim_users" TO tula_app;
--> statement-breakpoint
GRANT UPDATE ("external_id", "active", "updated_at") ON "tula"."scim_users" TO tula_app;
