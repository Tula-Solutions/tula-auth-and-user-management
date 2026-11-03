CREATE TABLE "tula"."sso_connection_domains" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_connection_domains_connection_domain_key" UNIQUE("connection_id","domain")
);
--> statement-breakpoint
ALTER TABLE "tula"."sso_connection_domains" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tula"."sso_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"protocol" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"issuer" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_sealed" text NOT NULL,
	"default_role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_connections_organization_name_key" UNIQUE("organization_id","name"),
	CONSTRAINT "sso_connections_environment_id_id_key" UNIQUE("environment_id","id"),
	CONSTRAINT "sso_connections_status_known" CHECK ("tula"."sso_connections"."status" in ('draft', 'active', 'disabled')),
	CONSTRAINT "sso_connections_protocol_known" CHECK ("tula"."sso_connections"."protocol" in ('oidc')),
	CONSTRAINT "sso_connections_name_bounds" CHECK (char_length("tula"."sso_connections"."name") between 1 and 100)
);
--> statement-breakpoint
ALTER TABLE "tula"."sso_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tula"."sso_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"last_sign_in_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_identities_connection_subject_key" UNIQUE("connection_id","subject"),
	CONSTRAINT "sso_identities_connection_user_key" UNIQUE("connection_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "tula"."sso_identities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tula"."sso_connection_domains" ADD CONSTRAINT "sso_connection_domains_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."sso_connection_domains" ADD CONSTRAINT "sso_connection_domains_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."sso_connection_domains" ADD CONSTRAINT "sso_connection_domains_connection_fk" FOREIGN KEY ("environment_id","connection_id") REFERENCES "tula"."sso_connections"("environment_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."sso_connection_domains" ADD CONSTRAINT "sso_connection_domains_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."sso_connections" ADD CONSTRAINT "sso_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."sso_connections" ADD CONSTRAINT "sso_connections_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."sso_connections" ADD CONSTRAINT "sso_connections_organization_fk" FOREIGN KEY ("environment_id","organization_id") REFERENCES "tula"."organizations"("environment_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."sso_connections" ADD CONSTRAINT "sso_connections_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."sso_identities" ADD CONSTRAINT "sso_identities_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."sso_identities" ADD CONSTRAINT "sso_identities_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."sso_identities" ADD CONSTRAINT "sso_identities_connection_fk" FOREIGN KEY ("environment_id","connection_id") REFERENCES "tula"."sso_connections"("environment_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."sso_identities" ADD CONSTRAINT "sso_identities_user_fk" FOREIGN KEY ("environment_id","user_id") REFERENCES "tula"."users"("environment_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."sso_identities" ADD CONSTRAINT "sso_identities_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sso_connection_domains_active_domain_key" ON "tula"."sso_connection_domains" USING btree ("environment_id","domain") WHERE "tula"."sso_connection_domains"."active";--> statement-breakpoint
CREATE INDEX "sso_connection_domains_environment_id_idx" ON "tula"."sso_connection_domains" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "sso_connections_organization_idx" ON "tula"."sso_connections" USING btree ("environment_id","organization_id");--> statement-breakpoint
CREATE INDEX "sso_connections_environment_id_idx" ON "tula"."sso_connections" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "sso_identities_user_idx" ON "tula"."sso_identities" USING btree ("environment_id","user_id");--> statement-breakpoint
CREATE INDEX "sso_identities_environment_id_idx" ON "tula"."sso_identities" USING btree ("environment_id");--> statement-breakpoint
CREATE POLICY "sso_connection_domains_tenant_isolation" ON "tula"."sso_connection_domains" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "sso_connections_tenant_isolation" ON "tula"."sso_connections" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "sso_identities_tenant_isolation" ON "tula"."sso_identities" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
-- Added by hand (Drizzle cannot declare any of what follows). FORCE applies the policy to the
-- table owner too; src/rls.test.ts fails for a tenant table without it.
ALTER TABLE "tula"."sso_connections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tula"."sso_connection_domains" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tula"."sso_identities" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Runtime grants (ADR 0067). A connection's protocol, organization and id never change; its
-- domain rows and identities are never moved to another connection or user.
GRANT SELECT, INSERT, DELETE ON "tula"."sso_connections" TO tula_app;
--> statement-breakpoint
GRANT UPDATE ("name", "status", "issuer", "client_id", "client_secret_sealed", "default_role", "updated_at") ON "tula"."sso_connections" TO tula_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "tula"."sso_connection_domains" TO tula_app;
--> statement-breakpoint
GRANT UPDATE ("active", "updated_at") ON "tula"."sso_connection_domains" TO tula_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "tula"."sso_identities" TO tula_app;
--> statement-breakpoint
GRANT UPDATE ("last_sign_in_at", "updated_at") ON "tula"."sso_identities" TO tula_app;
