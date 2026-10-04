CREATE TABLE "tula"."passkey_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"challenge" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "passkey_challenges_session_purpose_key" UNIQUE("session_id","purpose")
);
--> statement-breakpoint
ALTER TABLE "tula"."passkey_challenges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tula"."passkeys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" "bytea" NOT NULL,
	"sign_count" bigint DEFAULT 0 NOT NULL,
	"transports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"aaguid" text NOT NULL,
	"backup_eligible" boolean DEFAULT false NOT NULL,
	"backed_up" boolean DEFAULT false NOT NULL,
	"user_handle" text NOT NULL,
	"name" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "passkeys_environment_credential_id_key" UNIQUE("environment_id","credential_id")
);
--> statement-breakpoint
ALTER TABLE "tula"."passkeys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tula"."passkey_challenges" ADD CONSTRAINT "passkey_challenges_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."passkey_challenges" ADD CONSTRAINT "passkey_challenges_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."passkey_challenges" ADD CONSTRAINT "passkey_challenges_user_fk" FOREIGN KEY ("environment_id","user_id") REFERENCES "tula"."users"("environment_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."passkey_challenges" ADD CONSTRAINT "passkey_challenges_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."passkeys" ADD CONSTRAINT "passkeys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."passkeys" ADD CONSTRAINT "passkeys_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."passkeys" ADD CONSTRAINT "passkeys_user_fk" FOREIGN KEY ("environment_id","user_id") REFERENCES "tula"."users"("environment_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."passkeys" ADD CONSTRAINT "passkeys_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "passkey_challenges_expires_at_idx" ON "tula"."passkey_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "passkey_challenges_environment_id_idx" ON "tula"."passkey_challenges" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "passkeys_user_id_idx" ON "tula"."passkeys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passkeys_environment_id_idx" ON "tula"."passkeys" USING btree ("environment_id");--> statement-breakpoint
CREATE POLICY "passkey_challenges_tenant_isolation" ON "tula"."passkey_challenges" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "passkeys_tenant_isolation" ON "tula"."passkeys" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "tula"."passkeys" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tula"."passkey_challenges" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Runtime grants (new tables get none by default, see 0003). DELETE on both: a user removes a
-- passkey and an admin reset removes them all on the request path; a challenge is taken by
-- deleting its row, and the retention job removes the expired ones.
GRANT SELECT, INSERT, UPDATE, DELETE ON "tula"."passkeys" TO tula_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tula"."passkey_challenges" TO tula_app;
