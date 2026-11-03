ALTER TABLE "tula"."sso_connections" ADD COLUMN "enforced" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tula"."sso_connections" ADD COLUMN "break_glass_role" text;--> statement-breakpoint
ALTER TABLE "tula"."sso_connections" ADD COLUMN "trust_idp_mfa" boolean DEFAULT false NOT NULL;;--> statement-breakpoint
GRANT UPDATE ("name", "status", "issuer", "client_id", "client_secret_sealed", "default_role", "enforced", "break_glass_role", "trust_idp_mfa", "updated_at") ON "tula"."sso_connections" TO tula_app;
