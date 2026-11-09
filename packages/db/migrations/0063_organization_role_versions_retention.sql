-- A superseded role snapshot past the environment's audit retention period is deleted by the
-- retention job (ADR 0068, ADR 0017). 0062 gave the runtime role INSERT and SELECT only; the
-- purge needs DELETE.
--
-- What bounds the new privilege, in the database and not only in the job:
--   * `organization_role_versions_tenant_isolation` already covers DELETE: only rows of the
--     environment in `tula.environment_id`, none when it is not set (fail closed).
--   * The restrictive policy below is ANDed with it: no snapshot younger than one day, the
--     shortest period an environment can set, whatever the statement asks for.
--   * Still no UPDATE, so a snapshot cannot be changed or backdated past that floor.
CREATE POLICY "organization_role_versions_retention_floor" ON "tula"."organization_role_versions" AS RESTRICTIVE FOR DELETE TO public USING (created_at < now() - interval '1 day');
--> statement-breakpoint
GRANT DELETE ON "tula"."organization_role_versions" TO tula_app;
