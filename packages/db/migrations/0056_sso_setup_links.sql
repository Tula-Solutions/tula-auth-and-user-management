CREATE TABLE "tula"."setup_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_by_type" text NOT NULL,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "setup_links_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "setup_links_name_bounds" CHECK (char_length("tula"."setup_links"."name") between 1 and 100)
);
--> statement-breakpoint
ALTER TABLE "tula"."setup_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tula"."setup_links" ADD CONSTRAINT "setup_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."setup_links" ADD CONSTRAINT "setup_links_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."setup_links" ADD CONSTRAINT "setup_links_organization_fk" FOREIGN KEY ("environment_id","organization_id") REFERENCES "tula"."organizations"("environment_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."setup_links" ADD CONSTRAINT "setup_links_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "setup_links_organization_idx" ON "tula"."setup_links" USING btree ("environment_id","organization_id");--> statement-breakpoint
CREATE INDEX "setup_links_expiry_idx" ON "tula"."setup_links" USING btree ("environment_id","expires_at");--> statement-breakpoint
CREATE INDEX "setup_links_environment_id_idx" ON "tula"."setup_links" USING btree ("environment_id");--> statement-breakpoint
CREATE POLICY "setup_links_tenant_isolation" ON "tula"."setup_links" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
-- Added by hand (Drizzle cannot declare any of what follows). FORCE applies the policy to the
-- table owner too; src/rls.test.ts fails for a tenant table without it.
ALTER TABLE "tula"."setup_links" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Runtime grants (ADR 0067, "Setup links"). A link's hash, expiry, organization and creator
-- never change: a longer life is a new link. Only its use and its revocation are written.
GRANT SELECT, INSERT, DELETE ON "tula"."setup_links" TO tula_app;
--> statement-breakpoint
GRANT UPDATE ("last_used_at", "revoked_at", "updated_at") ON "tula"."setup_links" TO tula_app;
