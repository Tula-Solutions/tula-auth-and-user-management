-- `GET /v1/instance/diagnostics` (tula doctor) answers "is this database migrated to what this
-- image ships?". The API connects as a member of tula_app, which has no access to the `drizzle`
-- schema and keeps none: this function, owned by the schema owner, answers the one thing the
-- API needs (when each applied migration was generated) and nothing else from that schema.
CREATE FUNCTION tula.applied_migrations() RETURNS TABLE (created_at bigint)
  LANGUAGE sql STABLE SECURITY DEFINER
  -- A fixed search path: a SECURITY DEFINER function must not resolve names through the caller's.
  SET search_path = pg_catalog
  AS $$ SELECT m.created_at FROM drizzle.__drizzle_migrations m ORDER BY m.created_at $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION tula.applied_migrations() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION tula.applied_migrations() TO tula_app;
