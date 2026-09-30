-- Runs once when the local Postgres volume is first created.
-- `tula` (POSTGRES_USER) owns the schema and runs migrations (DATABASE_MIGRATION_URL).
-- `tula_api` is the API's login: a member of tula_app, NOT an owner, so row-level security applies.
-- Migration 0001 creates tula_app itself if missing and grants it table privileges.
CREATE ROLE tula_app NOLOGIN;
CREATE ROLE tula_api LOGIN PASSWORD 'tula_api' IN ROLE tula_app;
