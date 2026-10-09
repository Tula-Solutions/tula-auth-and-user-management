CREATE TABLE "tula"."password_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"secret" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_history_position_positive" CHECK ("tula"."password_history"."position" >= 1)
);
--> statement-breakpoint
ALTER TABLE "tula"."password_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tula"."password_history" ADD CONSTRAINT "password_history_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."password_history" ADD CONSTRAINT "password_history_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."password_history" ADD CONSTRAINT "password_history_user_fk" FOREIGN KEY ("environment_id","user_id") REFERENCES "tula"."users"("environment_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."password_history" ADD CONSTRAINT "password_history_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "password_history_environment_position_idx" ON "tula"."password_history" USING btree ("environment_id","position");--> statement-breakpoint
CREATE INDEX "password_history_environment_id_idx" ON "tula"."password_history" USING btree ("environment_id");--> statement-breakpoint
CREATE POLICY "password_history_tenant_isolation" ON "tula"."password_history" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
-- Added by hand (Drizzle cannot declare any of what follows). FORCE applies the policy to the
-- table owner too; src/rls.test.ts fails for a tenant table without it.
ALTER TABLE "tula"."password_history" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Runtime grants (new tables get none by default, see 0003).
--
-- A password change reads the user's previous hashes to compare the new password with, copies
-- the hash that stops being current into a row, and deletes the rows beyond what the
-- environment's `password.history` keeps, all on the request path; the retention job deletes
-- what a lowered `password.history` left behind (ADR 0038, ADR 0017). Rows also go by cascade
-- with their user.
GRANT SELECT, INSERT, DELETE ON "tula"."password_history" TO tula_app;
--> statement-breakpoint
-- UPDATE is by column: a password change moves each of the user's rows one place further back,
-- and that is all it changes. The runtime role cannot rewrite a row's hash, its user, its id,
-- its tenant columns or `created_at`, so a previous password cannot be replaced by another
-- hash or moved to another account.
GRANT UPDATE ("position", "updated_at") ON "tula"."password_history" TO tula_app;
--> statement-breakpoint
-- A user has one row at a position. The store keeps that true by itself (it moves a user's
-- rows under the lock of the user's row); this is the backstop for a writer that does not.
--
-- A constraint, and DEFERRABLE, on purpose. A password change moves every row of a user one
-- place back in one statement (`position = position + 1`). A plain unique index is checked row
-- by row, so that statement would fail as soon as the row at 1 landed on the row still at 2.
-- A deferrable constraint is checked when the statement ends, by which time every row has
-- moved. INITIALLY IMMEDIATE keeps it at the statement's end, not the transaction's: nothing
-- defers it, and a statement that leaves two rows at one position fails there and then.
-- Drizzle cannot declare a deferrable constraint, which is why this is not in the schema file.
-- Its index is what reads a user's rows in order, so the table has no other on these columns.
ALTER TABLE "tula"."password_history" ADD CONSTRAINT "password_history_user_position_unique" UNIQUE ("user_id", "position") DEFERRABLE INITIALLY IMMEDIATE;
