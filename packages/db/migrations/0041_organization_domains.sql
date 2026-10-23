CREATE TABLE "tula"."organization_domains" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"mode" text NOT NULL,
	"verified_at" timestamp with time zone,
	"code_hash" text,
	"code_expires_at" timestamp with time zone,
	"code_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_domains_organization_domain_key" UNIQUE("organization_id","domain"),
	CONSTRAINT "organization_domains_domain_shape" CHECK (char_length("tula"."organization_domains"."domain") between 4 and 253 and "tula"."organization_domains"."domain" ~ '^([a-z0-9]([a-z0-9-]*[a-z0-9])?[.])+([a-z]{2,}|xn--[a-z0-9-]*[a-z0-9])$'),
	CONSTRAINT "organization_domains_mode_known" CHECK ("tula"."organization_domains"."mode" in ('suggest', 'auto_join')),
	CONSTRAINT "organization_domains_state" CHECK (("tula"."organization_domains"."verified_at" is null) = ("tula"."organization_domains"."code_hash" is not null) and ("tula"."organization_domains"."code_hash" is null) = ("tula"."organization_domains"."code_expires_at" is null)),
	CONSTRAINT "organization_domains_attempts" CHECK ("tula"."organization_domains"."code_attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "tula"."organization_domains" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tula"."organization_domains" ADD CONSTRAINT "organization_domains_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."organization_domains" ADD CONSTRAINT "organization_domains_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."organization_domains" ADD CONSTRAINT "organization_domains_organization_fk" FOREIGN KEY ("environment_id","organization_id") REFERENCES "tula"."organizations"("environment_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."organization_domains" ADD CONSTRAINT "organization_domains_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_domains_verified_domain_key" ON "tula"."organization_domains" USING btree ("environment_id","domain") WHERE "tula"."organization_domains"."verified_at" is not null;--> statement-breakpoint
CREATE INDEX "organization_domains_organization_idx" ON "tula"."organization_domains" USING btree ("environment_id","organization_id");--> statement-breakpoint
CREATE INDEX "organization_domains_pending_expiry_idx" ON "tula"."organization_domains" USING btree ("code_expires_at") WHERE "tula"."organization_domains"."verified_at" is null;--> statement-breakpoint
CREATE INDEX "organization_domains_environment_id_idx" ON "tula"."organization_domains" USING btree ("environment_id");--> statement-breakpoint
CREATE POLICY "organization_domains_tenant_isolation" ON "tula"."organization_domains" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);
--> statement-breakpoint
-- Added by hand (Drizzle cannot declare any of what follows). FORCE applies the policy to the
-- table owner too; src/rls.test.ts fails for a tenant table without it.
ALTER TABLE "tula"."organization_domains" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Runtime grants (new tables get none by default, see 0003). ADR 0065, "Verified domains".
--
-- A claim is made, its code replaced and entered, its mode changed and removed on the request
-- path; the retention job deletes pending claims whose code expired. UPDATE is by column: the
-- mode, the code and its guess counter, the time it was verified and `updated_at`. A row cannot
-- be moved to another organization or domain, or to another environment.
GRANT SELECT, INSERT, DELETE ON "tula"."organization_domains" TO tula_app;
--> statement-breakpoint
GRANT UPDATE ("mode", "verified_at", "code_hash", "code_expires_at", "code_attempts", "updated_at") ON "tula"."organization_domains" TO tula_app;
