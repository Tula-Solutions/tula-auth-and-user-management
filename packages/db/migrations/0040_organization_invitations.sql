CREATE TABLE "tula"."organization_invitations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"email_normalized" text NOT NULL,
	"role_key" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"invited_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_invitations_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "organization_invitations_status_known" CHECK ("tula"."organization_invitations"."status" in ('pending', 'accepted', 'declined', 'revoked')),
	CONSTRAINT "organization_invitations_role_key_shape" CHECK ("tula"."organization_invitations"."role_key" ~ '^[a-z][a-z0-9_]{0,31}$'),
	CONSTRAINT "organization_invitations_email_length" CHECK (char_length("tula"."organization_invitations"."email") between 3 and 320 and char_length("tula"."organization_invitations"."email_normalized") between 3 and 320),
	CONSTRAINT "organization_invitations_resolved_consistent" CHECK (("tula"."organization_invitations"."status" = 'pending') = ("tula"."organization_invitations"."resolved_at" is null))
);
--> statement-breakpoint
ALTER TABLE "tula"."organization_invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tula"."organization_invitations" ADD CONSTRAINT "organization_invitations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."organization_invitations" ADD CONSTRAINT "organization_invitations_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."organization_invitations" ADD CONSTRAINT "organization_invitations_organization_fk" FOREIGN KEY ("environment_id","organization_id") REFERENCES "tula"."organizations"("environment_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."organization_invitations" ADD CONSTRAINT "organization_invitations_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_invitations_pending_key" ON "tula"."organization_invitations" USING btree ("organization_id","email_normalized") WHERE "tula"."organization_invitations"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "organization_invitations_organization_idx" ON "tula"."organization_invitations" USING btree ("environment_id","organization_id");--> statement-breakpoint
CREATE INDEX "organization_invitations_expires_idx" ON "tula"."organization_invitations" USING btree ("environment_id","expires_at");--> statement-breakpoint
CREATE INDEX "organization_invitations_environment_id_idx" ON "tula"."organization_invitations" USING btree ("environment_id");--> statement-breakpoint
CREATE POLICY "organization_invitations_tenant_isolation" ON "tula"."organization_invitations" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);
--> statement-breakpoint
-- Added by hand (Drizzle cannot declare any of what follows). FORCE applies the policy to the
-- table owner too; src/rls.test.ts fails for a tenant table without it.
ALTER TABLE "tula"."organization_invitations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Runtime grants (new tables get none by default, see 0003). ADR 0065, "Invitations".
--
-- An invitation is created, resolved and (once it has expired) deleted on the request path and
-- by the retention job. UPDATE is by column, as for `native_apps` in 0028: the three columns a
-- resolution writes (accepted, declined or revoked) and `updated_at`. A row cannot be moved to
-- another organization, address, role or token, and its expiry cannot be extended.
GRANT SELECT, INSERT, DELETE ON "tula"."organization_invitations" TO tula_app;
--> statement-breakpoint
GRANT UPDATE ("status", "resolved_at", "resolved_by", "updated_at") ON "tula"."organization_invitations" TO tula_app;
