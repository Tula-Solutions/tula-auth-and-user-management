-- An environment's audit retention period takes effect (ADR 0012, ADR 0017): the retention
-- job deletes an environment's audit entries older than its `audit.retentionDays`. Until now
-- the runtime role could only read and append to `audit_logs`; the purge needs DELETE.
--
-- What bounds the new privilege, in the database and not only in the job:
--   * `audit_logs_tenant_isolation` (0000) already covers DELETE: only rows of the environment
--     in `tula.environment_id`, and none at all when it is not set (fail closed).
--   * The restrictive policy below is ANDed with it: no entry younger than one day, the
--     shortest period an environment can set, whatever the statement asks for.
--   * Still no UPDATE, so an entry cannot be changed, or backdated past that floor, and no
--     TRUNCATE.
CREATE POLICY "audit_logs_retention_floor" ON "tula"."audit_logs" AS RESTRICTIVE FOR DELETE TO public USING (occurred_at < now() - interval '1 day');
--> statement-breakpoint
GRANT DELETE ON "tula"."audit_logs" TO tula_app;
