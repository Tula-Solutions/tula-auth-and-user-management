-- The instance audit log gets a retention period (ADR 0017, ADR 0032): anyone who can reach
-- the dashboard's sign-in can add an entry to it, so it must not grow for ever. The retention
-- job deletes entries older than the deployment's `INSTANCE_AUDIT_RETENTION_DAYS`, which
-- needs DELETE. Still no UPDATE: an entry is never changed. `audit_logs` (an environment's
-- log) keeps SELECT and INSERT only and is never deleted.
GRANT DELETE ON "tula"."instance_audit_logs" TO tula_app;
