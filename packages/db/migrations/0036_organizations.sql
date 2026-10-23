CREATE TABLE "tula"."organization_memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_memberships_organization_user_key" UNIQUE("organization_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "tula"."organization_memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tula"."organization_roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"built_in" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_roles_environment_key_key" UNIQUE("environment_id","key"),
	CONSTRAINT "organization_roles_environment_id_id_key" UNIQUE("environment_id","id"),
	CONSTRAINT "organization_roles_key_shape" CHECK ("tula"."organization_roles"."key" ~ '^[a-z][a-z0-9_]{0,31}$'),
	CONSTRAINT "organization_roles_name_length" CHECK (char_length("tula"."organization_roles"."name") between 1 and 100),
	CONSTRAINT "organization_roles_built_in_known" CHECK (not "tula"."organization_roles"."built_in" or "tula"."organization_roles"."key" in ('admin', 'member')),
	CONSTRAINT "organization_roles_permissions_shape" CHECK (cardinality("tula"."organization_roles"."permissions") <= 32 and array_position("tula"."organization_roles"."permissions", null) is null and array_to_string("tula"."organization_roles"."permissions", ',') ~ '^((org:(sys:[a-z][a-z0-9_]{0,31}|(?!sys:)[a-z][a-z0-9_]{0,31}):[a-z][a-z0-9_]{0,31})(,org:(sys:[a-z][a-z0-9_]{0,31}|(?!sys:)[a-z][a-z0-9_]{0,31}):[a-z][a-z0-9_]{0,31})*)?$' and char_length(array_to_string("tula"."organization_roles"."permissions", ',')) - char_length(replace(array_to_string("tula"."organization_roles"."permissions", ','), ',', '')) = greatest(cardinality("tula"."organization_roles"."permissions") - 1, 0))
);
--> statement-breakpoint
ALTER TABLE "tula"."organization_roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tula"."organizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_environment_slug_key" UNIQUE("environment_id","slug"),
	CONSTRAINT "organizations_environment_id_id_key" UNIQUE("environment_id","id"),
	CONSTRAINT "organizations_slug_shape" CHECK (char_length("tula"."organizations"."slug") between 2 and 48 and "tula"."organizations"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "organizations_name_length" CHECK (char_length("tula"."organizations"."name") between 1 and 100)
);
--> statement-breakpoint
ALTER TABLE "tula"."organizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tula"."organization_memberships" ADD CONSTRAINT "organization_memberships_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."organization_memberships" ADD CONSTRAINT "organization_memberships_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."organization_memberships" ADD CONSTRAINT "organization_memberships_organization_fk" FOREIGN KEY ("environment_id","organization_id") REFERENCES "tula"."organizations"("environment_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."organization_memberships" ADD CONSTRAINT "organization_memberships_user_fk" FOREIGN KEY ("environment_id","user_id") REFERENCES "tula"."users"("environment_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."organization_memberships" ADD CONSTRAINT "organization_memberships_role_fk" FOREIGN KEY ("environment_id","role_id") REFERENCES "tula"."organization_roles"("environment_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."organization_memberships" ADD CONSTRAINT "organization_memberships_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."organization_roles" ADD CONSTRAINT "organization_roles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."organization_roles" ADD CONSTRAINT "organization_roles_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."organization_roles" ADD CONSTRAINT "organization_roles_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."organizations" ADD CONSTRAINT "organizations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."organizations" ADD CONSTRAINT "organizations_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."organizations" ADD CONSTRAINT "organizations_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organization_memberships_user_idx" ON "tula"."organization_memberships" USING btree ("environment_id","user_id");--> statement-breakpoint
CREATE INDEX "organization_memberships_role_idx" ON "tula"."organization_memberships" USING btree ("environment_id","role_id");--> statement-breakpoint
CREATE INDEX "organization_memberships_environment_id_idx" ON "tula"."organization_memberships" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "organization_roles_environment_id_idx" ON "tula"."organization_roles" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "organizations_environment_id_idx" ON "tula"."organizations" USING btree ("environment_id");--> statement-breakpoint
CREATE POLICY "organization_memberships_tenant_isolation" ON "tula"."organization_memberships" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organization_roles_tenant_isolation" ON "tula"."organization_roles" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organizations_tenant_isolation" ON "tula"."organizations" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);
--> statement-breakpoint
-- Added by hand (Drizzle cannot declare any of what follows). FORCE applies the policy to the
-- table owner too; src/rls.test.ts fails for a tenant table without it.
ALTER TABLE "tula"."organizations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tula"."organization_roles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tula"."organization_memberships" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Runtime grants (new tables get none by default, see 0003). ADR 0065.
--
-- An organization is created, renamed and deleted on the request path (the admin API now, a
-- signed-in user's routes later). UPDATE is by column, as for `native_apps` in 0028: the name,
-- the slug and `updated_at`. The runtime role cannot rewrite who created an organization, its
-- id or its tenant columns.
GRANT SELECT, INSERT, DELETE ON "tula"."organizations" TO tula_app;
--> statement-breakpoint
GRANT UPDATE ("name", "slug", "updated_at") ON "tula"."organizations" TO tula_app;
--> statement-breakpoint
-- A role is read and, for an environment that has none yet, inserted: the API creates the two
-- built-in roles of an environment on first use. No UPDATE and no DELETE in this version: a
-- built-in role cannot be rewritten or removed by the runtime role, and the endpoints that
-- manage custom roles (ADR 0065, Orgs 02) extend this grant deliberately.
GRANT SELECT, INSERT ON "tula"."organization_roles" TO tula_app;
--> statement-breakpoint
-- A membership is added, moved to another role and removed on the request path. UPDATE is by
-- column: the role and `updated_at`. A row cannot be moved to another user or organization.
GRANT SELECT, INSERT, DELETE ON "tula"."organization_memberships" TO tula_app;
--> statement-breakpoint
GRANT UPDATE ("role_id", "updated_at") ON "tula"."organization_memberships" TO tula_app;
--> statement-breakpoint
-- The built-in roles of every environment that exists now (`admin` holds every system
-- permission of the contract's SYSTEM_PERMISSIONS, `member` may read the member list). An
-- environment created later gets them from the API on first use. FORCE ROW LEVEL SECURITY is
-- lifted for the insert and restored in the same file, as in 0019: the owner is bound by the
-- policy too and a migration sets no environment. The ids are random (v4): the API's own are
-- v7, and nothing orders roles by id. `ON CONFLICT DO NOTHING` makes a re-run harmless.
ALTER TABLE "tula"."organization_roles" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO "tula"."organization_roles" ("id", "project_id", "environment_id", "key", "name", "permissions", "built_in")
SELECT gen_random_uuid(), e."project_id", e."id", r."key", r."name", r."permissions", true
FROM "tula"."environments" e
CROSS JOIN (VALUES
  ('admin', 'Admin', ARRAY['org:sys:organization:manage', 'org:sys:organization:delete', 'org:sys:memberships:read', 'org:sys:memberships:manage', 'org:sys:invitations:manage', 'org:sys:domains:manage']::text[]),
  ('member', 'Member', ARRAY['org:sys:memberships:read']::text[])
) AS r ("key", "name", "permissions")
ON CONFLICT ("environment_id", "key") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "tula"."organization_roles" FORCE ROW LEVEL SECURITY;
