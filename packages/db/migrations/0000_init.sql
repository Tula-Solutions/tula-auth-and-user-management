CREATE SCHEMA "tula";
--> statement-breakpoint
CREATE TABLE "tula"."api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"last_four" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_key" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "tula"."audit_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"ip_address" "inet",
	"user_agent" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tula"."audit_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tula"."credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"secret" text NOT NULL,
	"policy_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credentials_user_type_key" UNIQUE("user_id","type")
);
--> statement-breakpoint
ALTER TABLE "tula"."credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tula"."environments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environments_project_kind_key" UNIQUE("project_id","kind"),
	CONSTRAINT "environments_id_project_key" UNIQUE("id","project_id")
);
--> statement-breakpoint
CREATE TABLE "tula"."events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "tula"."events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tula"."flow_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"user_id" uuid,
	"identifier" text NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tula"."flow_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tula"."identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identities_environment_provider_subject_key" UNIQUE("environment_id","provider","provider_subject")
);
--> statement-breakpoint
ALTER TABLE "tula"."identities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tula"."projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tula"."refresh_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"parent_id" uuid,
	"replaced_by_id" uuid,
	"replacement_ciphertext" text,
	"used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_key" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "tula"."refresh_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tula"."sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"profile" text NOT NULL,
	"client" text NOT NULL,
	"user_agent" text,
	"ip_address" "inet",
	"last_active_at" timestamp with time zone NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tula"."sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tula"."signing_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"algorithm" text DEFAULT 'EdDSA' NOT NULL,
	"public_jwk" jsonb NOT NULL,
	"private_key_ciphertext" text NOT NULL,
	"status" text NOT NULL,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tula"."signing_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tula"."users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"email" text NOT NULL,
	"email_normalized" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"first_name" text,
	"last_name" text,
	"banned_at" timestamp with time zone,
	"last_sign_in_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_environment_email_key" UNIQUE("environment_id","email_normalized")
);
--> statement-breakpoint
ALTER TABLE "tula"."users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tula"."verification_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"user_id" uuid,
	"flow_attempt_id" uuid,
	"purpose" text NOT NULL,
	"destination" text NOT NULL,
	"code_hash" text NOT NULL,
	"link_token_hash" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_tokens_link_token_hash_key" UNIQUE("link_token_hash")
);
--> statement-breakpoint
ALTER TABLE "tula"."verification_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tula"."workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tula"."api_keys" ADD CONSTRAINT "api_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."api_keys" ADD CONSTRAINT "api_keys_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."audit_logs" ADD CONSTRAINT "audit_logs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."audit_logs" ADD CONSTRAINT "audit_logs_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."audit_logs" ADD CONSTRAINT "audit_logs_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."credentials" ADD CONSTRAINT "credentials_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."credentials" ADD CONSTRAINT "credentials_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."credentials" ADD CONSTRAINT "credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "tula"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."credentials" ADD CONSTRAINT "credentials_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."environments" ADD CONSTRAINT "environments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."events" ADD CONSTRAINT "events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."events" ADD CONSTRAINT "events_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."events" ADD CONSTRAINT "events_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."flow_attempts" ADD CONSTRAINT "flow_attempts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."flow_attempts" ADD CONSTRAINT "flow_attempts_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."flow_attempts" ADD CONSTRAINT "flow_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "tula"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."flow_attempts" ADD CONSTRAINT "flow_attempts_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."identities" ADD CONSTRAINT "identities_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."identities" ADD CONSTRAINT "identities_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."identities" ADD CONSTRAINT "identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "tula"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."identities" ADD CONSTRAINT "identities_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "tula"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "tula"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_parent_id_refresh_tokens_id_fk" FOREIGN KEY ("parent_id") REFERENCES "tula"."refresh_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_replaced_by_id_refresh_tokens_id_fk" FOREIGN KEY ("replaced_by_id") REFERENCES "tula"."refresh_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."sessions" ADD CONSTRAINT "sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."sessions" ADD CONSTRAINT "sessions_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "tula"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."sessions" ADD CONSTRAINT "sessions_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."signing_keys" ADD CONSTRAINT "signing_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."signing_keys" ADD CONSTRAINT "signing_keys_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."signing_keys" ADD CONSTRAINT "signing_keys_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."users" ADD CONSTRAINT "users_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."users" ADD CONSTRAINT "users_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."users" ADD CONSTRAINT "users_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."verification_tokens" ADD CONSTRAINT "verification_tokens_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."verification_tokens" ADD CONSTRAINT "verification_tokens_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."verification_tokens" ADD CONSTRAINT "verification_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "tula"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."verification_tokens" ADD CONSTRAINT "verification_tokens_flow_attempt_id_flow_attempts_id_fk" FOREIGN KEY ("flow_attempt_id") REFERENCES "tula"."flow_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."verification_tokens" ADD CONSTRAINT "verification_tokens_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_environment_id_idx" ON "tula"."api_keys" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "audit_logs_environment_occurred_idx" ON "tula"."audit_logs" USING btree ("environment_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_logs_environment_id_idx" ON "tula"."audit_logs" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "credentials_environment_id_idx" ON "tula"."credentials" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "environments_project_id_idx" ON "tula"."environments" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "events_undelivered_idx" ON "tula"."events" USING btree ("occurred_at") WHERE delivered_at is null;--> statement-breakpoint
CREATE INDEX "events_environment_id_idx" ON "tula"."events" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "flow_attempts_environment_id_idx" ON "tula"."flow_attempts" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "identities_user_id_idx" ON "tula"."identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "identities_environment_id_idx" ON "tula"."identities" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "projects_workspace_id_idx" ON "tula"."projects" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_session_id_idx" ON "tula"."refresh_tokens" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_environment_id_idx" ON "tula"."refresh_tokens" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "tula"."sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_environment_id_idx" ON "tula"."sessions" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "signing_keys_environment_status_idx" ON "tula"."signing_keys" USING btree ("environment_id","status");--> statement-breakpoint
CREATE INDEX "signing_keys_environment_id_idx" ON "tula"."signing_keys" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "users_environment_id_idx" ON "tula"."users" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "verification_tokens_flow_attempt_id_idx" ON "tula"."verification_tokens" USING btree ("flow_attempt_id");--> statement-breakpoint
CREATE INDEX "verification_tokens_environment_id_idx" ON "tula"."verification_tokens" USING btree ("environment_id");--> statement-breakpoint
CREATE POLICY "audit_logs_tenant_isolation" ON "tula"."audit_logs" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "credentials_tenant_isolation" ON "tula"."credentials" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "events_tenant_isolation" ON "tula"."events" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "flow_attempts_tenant_isolation" ON "tula"."flow_attempts" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "identities_tenant_isolation" ON "tula"."identities" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "refresh_tokens_tenant_isolation" ON "tula"."refresh_tokens" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "sessions_tenant_isolation" ON "tula"."sessions" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "signing_keys_tenant_isolation" ON "tula"."signing_keys" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "users_tenant_isolation" ON "tula"."users" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "verification_tokens_tenant_isolation" ON "tula"."verification_tokens" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);