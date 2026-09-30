-- Scopes every child → parent reference to one environment (composite FKs on environment_id),
-- and drops refresh_tokens.replacement_ciphertext (child tokens are now derived, never stored).
--
-- On a database with data: adding the FKs validates existing rows and FAILS if any row already
-- references a parent in another environment (fix the data first). The column drop is
-- destructive by design. Statement order is hand-edited: the (environment_id, id) UNIQUE keys
-- must exist before the FKs that reference them (drizzle-kit emitted them last).
ALTER TABLE "tula"."credentials" DROP CONSTRAINT "credentials_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "tula"."flow_attempts" DROP CONSTRAINT "flow_attempts_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "tula"."identities" DROP CONSTRAINT "identities_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "tula"."refresh_tokens" DROP CONSTRAINT "refresh_tokens_session_id_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "tula"."refresh_tokens" DROP CONSTRAINT "refresh_tokens_parent_id_refresh_tokens_id_fk";
--> statement-breakpoint
ALTER TABLE "tula"."refresh_tokens" DROP CONSTRAINT "refresh_tokens_replaced_by_id_refresh_tokens_id_fk";
--> statement-breakpoint
ALTER TABLE "tula"."sessions" DROP CONSTRAINT "sessions_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "tula"."verification_tokens" DROP CONSTRAINT "verification_tokens_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "tula"."verification_tokens" DROP CONSTRAINT "verification_tokens_flow_attempt_id_flow_attempts_id_fk";
--> statement-breakpoint
ALTER TABLE "tula"."flow_attempts" ADD CONSTRAINT "flow_attempts_environment_id_id_key" UNIQUE("environment_id","id");
--> statement-breakpoint
ALTER TABLE "tula"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_environment_id_id_key" UNIQUE("environment_id","id");
--> statement-breakpoint
ALTER TABLE "tula"."sessions" ADD CONSTRAINT "sessions_environment_id_id_key" UNIQUE("environment_id","id");
--> statement-breakpoint
ALTER TABLE "tula"."users" ADD CONSTRAINT "users_environment_id_id_key" UNIQUE("environment_id","id");
--> statement-breakpoint
ALTER TABLE "tula"."credentials" ADD CONSTRAINT "credentials_user_fk" FOREIGN KEY ("environment_id","user_id") REFERENCES "tula"."users"("environment_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tula"."flow_attempts" ADD CONSTRAINT "flow_attempts_user_fk" FOREIGN KEY ("environment_id","user_id") REFERENCES "tula"."users"("environment_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tula"."identities" ADD CONSTRAINT "identities_user_fk" FOREIGN KEY ("environment_id","user_id") REFERENCES "tula"."users"("environment_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tula"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_session_fk" FOREIGN KEY ("environment_id","session_id") REFERENCES "tula"."sessions"("environment_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tula"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_parent_fk" FOREIGN KEY ("environment_id","parent_id") REFERENCES "tula"."refresh_tokens"("environment_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tula"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_replaced_by_fk" FOREIGN KEY ("environment_id","replaced_by_id") REFERENCES "tula"."refresh_tokens"("environment_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tula"."sessions" ADD CONSTRAINT "sessions_user_fk" FOREIGN KEY ("environment_id","user_id") REFERENCES "tula"."users"("environment_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tula"."verification_tokens" ADD CONSTRAINT "verification_tokens_user_fk" FOREIGN KEY ("environment_id","user_id") REFERENCES "tula"."users"("environment_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tula"."verification_tokens" ADD CONSTRAINT "verification_tokens_flow_attempt_fk" FOREIGN KEY ("environment_id","flow_attempt_id") REFERENCES "tula"."flow_attempts"("environment_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tula"."refresh_tokens" DROP COLUMN "replacement_ciphertext";
