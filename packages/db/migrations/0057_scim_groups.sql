CREATE TABLE "tula"."scim_group_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scim_group_members_group_user_key" UNIQUE("group_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "tula"."scim_group_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tula"."scim_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scim_groups_organization_name_key" UNIQUE("organization_id","display_name"),
	CONSTRAINT "scim_groups_environment_id_id_key" UNIQUE("environment_id","id"),
	CONSTRAINT "scim_groups_name_bounds" CHECK (char_length("tula"."scim_groups"."display_name") between 1 and 256),
	CONSTRAINT "scim_groups_external_id_bounds" CHECK ("tula"."scim_groups"."external_id" is null or char_length("tula"."scim_groups"."external_id") between 1 and 256)
);
--> statement-breakpoint
ALTER TABLE "tula"."scim_groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tula"."scim_group_members" ADD CONSTRAINT "scim_group_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."scim_group_members" ADD CONSTRAINT "scim_group_members_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."scim_group_members" ADD CONSTRAINT "scim_group_members_group_fk" FOREIGN KEY ("environment_id","group_id") REFERENCES "tula"."scim_groups"("environment_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."scim_group_members" ADD CONSTRAINT "scim_group_members_user_fk" FOREIGN KEY ("environment_id","user_id") REFERENCES "tula"."users"("environment_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."scim_group_members" ADD CONSTRAINT "scim_group_members_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."scim_groups" ADD CONSTRAINT "scim_groups_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."scim_groups" ADD CONSTRAINT "scim_groups_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."scim_groups" ADD CONSTRAINT "scim_groups_organization_fk" FOREIGN KEY ("environment_id","organization_id") REFERENCES "tula"."organizations"("environment_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."scim_groups" ADD CONSTRAINT "scim_groups_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scim_group_members_user_idx" ON "tula"."scim_group_members" USING btree ("environment_id","user_id");--> statement-breakpoint
CREATE INDEX "scim_group_members_environment_id_idx" ON "tula"."scim_group_members" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "scim_groups_environment_id_idx" ON "tula"."scim_groups" USING btree ("environment_id");--> statement-breakpoint
CREATE POLICY "scim_group_members_tenant_isolation" ON "tula"."scim_group_members" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "scim_groups_tenant_isolation" ON "tula"."scim_groups" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
-- Added by hand (Drizzle cannot declare any of what follows).
ALTER TABLE "tula"."scim_groups" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tula"."scim_group_members" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Runtime grants (ADR 0067, "SCIM"). A group never moves organization; a member row is only
-- inserted or deleted, never rewritten.
GRANT SELECT, INSERT, DELETE ON "tula"."scim_groups" TO tula_app;
--> statement-breakpoint
GRANT UPDATE ("display_name", "external_id", "updated_at") ON "tula"."scim_groups" TO tula_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "tula"."scim_group_members" TO tula_app;
