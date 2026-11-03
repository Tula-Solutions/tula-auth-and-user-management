ALTER TABLE "tula"."sso_connections" ADD COLUMN "tested_fingerprint" text;
--> statement-breakpoint
-- The runtime role updates columns by name (0047); the test mark is one more.
GRANT UPDATE ("tested_fingerprint") ON "tula"."sso_connections" TO tula_app;
