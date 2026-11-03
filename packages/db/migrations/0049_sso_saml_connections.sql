ALTER TABLE "tula"."sso_connections" DROP CONSTRAINT "sso_connections_protocol_known";--> statement-breakpoint
ALTER TABLE "tula"."sso_connections" ADD COLUMN "saml" jsonb;--> statement-breakpoint
ALTER TABLE "tula"."sso_connections" ADD CONSTRAINT "sso_connections_saml_iff_saml" CHECK (("tula"."sso_connections"."protocol" = 'saml') = ("tula"."sso_connections"."saml" is not null));--> statement-breakpoint
ALTER TABLE "tula"."sso_connections" ADD CONSTRAINT "sso_connections_protocol_known" CHECK ("tula"."sso_connections"."protocol" in ('oidc', 'saml'));