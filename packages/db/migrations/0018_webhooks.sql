CREATE TABLE "tula"."webhook_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"attempted_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"status_code" integer,
	"duration_ms" integer NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_endpoint_event_key" UNIQUE("endpoint_id","event_id")
);
--> statement-breakpoint
ALTER TABLE "tula"."webhook_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tula"."webhook_endpoints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"url" text NOT NULL,
	"event_types" text[] NOT NULL,
	"secret" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_endpoints_environment_id_id_key" UNIQUE("environment_id","id")
);
--> statement-breakpoint
ALTER TABLE "tula"."webhook_endpoints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP INDEX "tula"."events_undelivered_idx";--> statement-breakpoint
-- Moved up by hand: drizzle-kit wrote this after the foreign key that needs it
-- (`webhook_deliveries_event_fk` references exactly these two columns).
ALTER TABLE "tula"."events" ADD CONSTRAINT "events_environment_id_id_key" UNIQUE("environment_id","id");--> statement-breakpoint
ALTER TABLE "tula"."webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_fk" FOREIGN KEY ("environment_id","endpoint_id") REFERENCES "tula"."webhook_endpoints"("environment_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_fk" FOREIGN KEY ("environment_id","event_id") REFERENCES "tula"."events"("environment_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_environment_id_idx" ON "tula"."webhook_deliveries" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_environment_id_idx" ON "tula"."webhook_endpoints" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "events_environment_undelivered_idx" ON "tula"."events" USING btree ("environment_id","occurred_at","id") WHERE delivered_at is null;--> statement-breakpoint
CREATE POLICY "webhook_deliveries_tenant_isolation" ON "tula"."webhook_deliveries" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "webhook_endpoints_tenant_isolation" ON "tula"."webhook_endpoints" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
-- Added by hand (Drizzle cannot declare any of what follows). FORCE applies the policy to the
-- table owner too; src/rls.test.ts fails for a tenant table without it.
ALTER TABLE "tula"."webhook_endpoints" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tula"."webhook_deliveries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Runtime grants (new tables get none by default, see 0003).
--
-- `webhook_endpoints`: an administrator registers, changes and removes an endpoint on the
-- request path (`/v1/admin/webhook-endpoints`), hence DELETE.
GRANT SELECT, INSERT, UPDATE, DELETE ON "tula"."webhook_endpoints" TO tula_app;
--> statement-breakpoint
-- `webhook_deliveries`: the worker appends one row per endpoint and event (ADR 0034). No
-- UPDATE and no DELETE: what happened to a delivery cannot be rewritten by the runtime role,
-- and a row goes only with its endpoint or its event, by cascade.
--
-- `events` needs nothing new: the runtime role has held UPDATE on it since 0003, which is what
-- lets the worker set `delivered_at`. It still has no DELETE: deleting delivered events is the
-- retention job's, in a later migration (ADR 0017).
GRANT SELECT, INSERT ON "tula"."webhook_deliveries" TO tula_app;