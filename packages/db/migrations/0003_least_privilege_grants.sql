-- Least privilege for the runtime role (replaces the blanket grants in 0001).
--
-- Why: RI cascades run as the table owner, so row-level security cannot stop a runtime
-- `DELETE FROM tula.workspaces` from wiping every tenant's data. Destructive control-plane
-- operations belong to admin tooling running as the owner, never to the request path.
ALTER DEFAULT PRIVILEGES IN SCHEMA tula REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM tula_app;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA tula FROM tula_app;
--> statement-breakpoint
-- Control plane: read, create, update (API keys are revoked via revoked_at, not deleted).
GRANT SELECT, INSERT, UPDATE ON tula.workspaces, tula.projects, tula.environments, tula.api_keys TO tula_app;
--> statement-breakpoint
-- Tenant data: full CRUD, always scoped by row-level security.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  tula.users, tula.identities, tula.credentials, tula.sessions, tula.refresh_tokens,
  tula.signing_keys, tula.flow_attempts, tula.verification_tokens
TO tula_app;
--> statement-breakpoint
-- Outbox: append, and mark delivered.
GRANT SELECT, INSERT, UPDATE ON tula.events TO tula_app;
--> statement-breakpoint
-- Audit log: append-only.
GRANT SELECT, INSERT ON tula.audit_logs TO tula_app;
