CREATE TABLE "tula"."organization_role_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"role_key" text NOT NULL,
	"version" integer NOT NULL,
	"permissions" text[] NOT NULL,
	"permissions_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_role_versions_role_version_key" UNIQUE("environment_id","role_id","version"),
	CONSTRAINT "organization_role_versions_version_positive" CHECK ("tula"."organization_role_versions"."version" >= 1),
	CONSTRAINT "organization_role_versions_hash_shape" CHECK ("tula"."organization_role_versions"."permissions_hash" ~ '^1\.[A-Za-z0-9_-]{43}$')
);
--> statement-breakpoint
ALTER TABLE "tula"."organization_role_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tula"."organization_role_versions" ADD CONSTRAINT "organization_role_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."organization_role_versions" ADD CONSTRAINT "organization_role_versions_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."organization_role_versions" ADD CONSTRAINT "organization_role_versions_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organization_role_versions_environment_id_idx" ON "tula"."organization_role_versions" USING btree ("environment_id");--> statement-breakpoint
CREATE POLICY "organization_role_versions_tenant_isolation" ON "tula"."organization_role_versions" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "tula"."organization_role_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT ON "tula"."organization_role_versions" TO tula_app;--> statement-breakpoint
ALTER TABLE "tula"."organization_role_versions" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- One snapshot per existing role at its current version. The hash is over the JSON of the sorted,
-- deduplicated keys with no spaces (to_jsonb would add some), exactly as permissionsHash() in
-- @tula-tech/contract builds it: "1." + base64url, unpadded, of the SHA-256.
INSERT INTO "tula"."organization_role_versions" ("id", "project_id", "environment_id", "role_id", "role_key", "version", "permissions", "permissions_hash")
SELECT gen_random_uuid(), r."project_id", r."environment_id", r."id", r."key", r."version",
  ARRAY(SELECT k FROM (SELECT DISTINCT unnest(r."permissions") AS k) d ORDER BY k COLLATE "C"),
  '1.' || rtrim(translate(replace(encode(sha256(convert_to(
    '[' || coalesce((SELECT string_agg('"' || k || '"', ',' ORDER BY k COLLATE "C") FROM (SELECT DISTINCT unnest(r."permissions") AS k) d), '') || ']',
    'UTF8')), 'base64'), E'\n', ''), '+/', '-_'), '=')
FROM "tula"."organization_roles" r;--> statement-breakpoint
ALTER TABLE "tula"."organization_role_versions" FORCE ROW LEVEL SECURITY;
