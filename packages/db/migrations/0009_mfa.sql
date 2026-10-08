CREATE TABLE "tula"."backup_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backup_codes_user_code_hash_key" UNIQUE("user_id","code_hash")
);
--> statement-breakpoint
ALTER TABLE "tula"."backup_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tula"."user_factors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"secret" text NOT NULL,
	"name" text,
	"confirmed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"last_used_step" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_factors_user_type_key" UNIQUE("user_id","type")
);
--> statement-breakpoint
ALTER TABLE "tula"."user_factors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tula"."sessions" ADD COLUMN "factor_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tula"."sessions" ADD COLUMN "auth_methods" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "tula"."backup_codes" ADD CONSTRAINT "backup_codes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."backup_codes" ADD CONSTRAINT "backup_codes_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."backup_codes" ADD CONSTRAINT "backup_codes_user_fk" FOREIGN KEY ("environment_id","user_id") REFERENCES "tula"."users"("environment_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."backup_codes" ADD CONSTRAINT "backup_codes_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."user_factors" ADD CONSTRAINT "user_factors_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."user_factors" ADD CONSTRAINT "user_factors_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."user_factors" ADD CONSTRAINT "user_factors_user_fk" FOREIGN KEY ("environment_id","user_id") REFERENCES "tula"."users"("environment_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."user_factors" ADD CONSTRAINT "user_factors_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backup_codes_user_id_idx" ON "tula"."backup_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "backup_codes_environment_id_idx" ON "tula"."backup_codes" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "user_factors_expires_at_idx" ON "tula"."user_factors" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "user_factors_environment_id_idx" ON "tula"."user_factors" USING btree ("environment_id");--> statement-breakpoint
CREATE POLICY "backup_codes_tenant_isolation" ON "tula"."backup_codes" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "user_factors_tenant_isolation" ON "tula"."user_factors" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
-- Added by hand (Drizzle cannot declare either). FORCE applies the policy to the table owner
-- too; src/rls.test.ts fails for a tenant table without it.
ALTER TABLE "tula"."user_factors" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tula"."backup_codes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Runtime grants (new tables get none by default, see 0003). DELETE on both: turning two-step
-- verification off, an admin reset and regenerating codes remove rows on the request path, and
-- the retention job removes enrolments that were never confirmed.
GRANT SELECT, INSERT, UPDATE, DELETE ON "tula"."user_factors" TO tula_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tula"."backup_codes" TO tula_app;
