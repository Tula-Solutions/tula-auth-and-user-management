-- Runtime role for the API. The API must NOT connect as the table owner: owners (and superusers)
-- bypass row-level security. Deployments create a LOGIN user that is a member of tula_app
-- (docker/postgres/init.sql does this locally). NOLOGIN here keeps the migration password-free.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tula_app') THEN
    CREATE ROLE tula_app NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA tula TO tula_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA tula TO tula_app;
--> statement-breakpoint
-- Tables created by future migrations get the same grants automatically.
ALTER DEFAULT PRIVILEGES IN SCHEMA tula GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tula_app;
--> statement-breakpoint
-- FORCE makes policies apply to the table owner too, so a misconfigured deployment that
-- connects as the owner still can't read across environments. Every tenant table must be listed;
-- src/rls.test.ts fails for any table with environment_id that isn't forced.
ALTER TABLE tula.users FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tula.identities FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tula.credentials FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tula.sessions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tula.refresh_tokens FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tula.signing_keys FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tula.flow_attempts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tula.verification_tokens FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tula.events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tula.audit_logs FORCE ROW LEVEL SECURITY;
