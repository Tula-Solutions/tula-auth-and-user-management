CREATE TABLE "tula"."organization_group_roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"group_name" text NOT NULL,
	"role_key" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_group_roles_group_key" UNIQUE("organization_id","group_name"),
	CONSTRAINT "organization_group_roles_name_bounds" CHECK (char_length("tula"."organization_group_roles"."group_name") between 1 and 256)
);
--> statement-breakpoint
ALTER TABLE "tula"."organization_group_roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tula"."sso_connections" ADD COLUMN "attribute_mapping" jsonb;--> statement-breakpoint
ALTER TABLE "tula"."organization_group_roles" ADD CONSTRAINT "organization_group_roles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."organization_group_roles" ADD CONSTRAINT "organization_group_roles_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."organization_group_roles" ADD CONSTRAINT "organization_group_roles_organization_fk" FOREIGN KEY ("environment_id","organization_id") REFERENCES "tula"."organizations"("environment_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."organization_group_roles" ADD CONSTRAINT "organization_group_roles_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organization_group_roles_environment_id_idx" ON "tula"."organization_group_roles" USING btree ("environment_id");--> statement-breakpoint
CREATE POLICY "organization_group_roles_tenant_isolation" ON "tula"."organization_group_roles" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint

-- Added by hand (Drizzle cannot declare any of what follows). FORCE applies the policy to the
-- table owner too; the runtime role holds only what the store needs.
ALTER TABLE "tula"."organization_group_roles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "tula"."organization_group_roles" TO tula_app;--> statement-breakpoint
GRANT UPDATE ("attribute_mapping") ON "tula"."sso_connections" TO tula_app;