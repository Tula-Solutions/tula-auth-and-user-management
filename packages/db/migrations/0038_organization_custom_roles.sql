ALTER TABLE "tula"."organization_roles" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tula"."organization_roles" ADD CONSTRAINT "organization_roles_reserved_keys" CHECK ("tula"."organization_roles"."built_in" or "tula"."organization_roles"."key" not in ('admin', 'member'));--> statement-breakpoint
ALTER TABLE "tula"."organization_roles" ADD CONSTRAINT "organization_roles_version_positive" CHECK ("tula"."organization_roles"."version" >= 1);--> statement-breakpoint
CREATE POLICY "organization_roles_custom_update_only" ON "tula"."organization_roles" AS RESTRICTIVE FOR UPDATE TO public USING (not built_in) WITH CHECK (not built_in);--> statement-breakpoint
CREATE POLICY "organization_roles_custom_delete_only" ON "tula"."organization_roles" AS RESTRICTIVE FOR DELETE TO public USING (not built_in);
--> statement-breakpoint
-- Runtime grants for custom roles (ADR 0065, "Custom roles"; 0036 gave SELECT and INSERT only).
-- UPDATE is by column, as for `native_apps` in 0028: the name, the permissions, the version the
-- API's `If-Match` is checked against, and `updated_at`. A role cannot be given another key, an
-- id or a tenant, and cannot be made built in. DELETE is granted for custom roles: the two
-- restrictive policies above take every built-in row out of every UPDATE and DELETE, and a
-- membership's foreign key (no action) refuses the deletion of a role that is still assigned.
GRANT UPDATE ("name", "permissions", "version", "updated_at") ON "tula"."organization_roles" TO tula_app;
--> statement-breakpoint
GRANT DELETE ON "tula"."organization_roles" TO tula_app;
