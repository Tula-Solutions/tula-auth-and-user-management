-- Webhook retries and the delivery log (ADR 0034, "Retries, disabling and the delivery log").
--
-- What changes:
--   * `webhook_deliveries` becomes the worker's unit of work: a state (`pending`, `delivered`,
--     `failed`), a count of requests made, and when to try next. What was one row with one
--     outcome is now a row that is updated as the delivery moves on.
--   * `webhook_delivery_attempts` is new: one row per request made, append-only. The log of
--     what was tried cannot be rewritten by the runtime role.
--   * `webhook_deliveries.event_id` stops being a foreign key and may be NULL (a test event
--     has no event). A settled event is deleted after its retention period and the record of
--     its deliveries is kept longer, so the cascade that tied the two together had to go.
--   * `webhook_endpoints` gains `failing_since` and `disabled_reason`: how the worker knows an
--     endpoint has kept failing, and why it switched one off.
--   * The runtime role's privileges on `events` are narrowed to what it uses, and it gains the
--     two bounded deletes the retention job needs. See the end of this file.
--
-- LOCKING. This migration takes locks on `tula.events` that block every INSERT into it until
-- the migration commits: the index `events_environment_delivered_idx` is built under one, and
-- the policy and the two `ROW LEVEL SECURITY` statements each take a short exclusive one that
-- is then held to the end of the transaction. Every sign-in, sign-out and admin change inserts
-- an event, so on a large outbox those requests wait for as long as the index build takes:
-- apply this migration in a quiet window. Nothing is built CONCURRENTLY, because the migrator
-- runs a migration in one transaction, where that is not allowed (docs/self-host.md,
-- "Upgrading"). `tula.webhook_deliveries` is rewritten in place; it has existed only since
-- 0018 and is small.
CREATE TABLE "tula"."webhook_delivery_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"attempted_at" timestamp with time zone NOT NULL,
	"status_code" integer,
	"duration_ms" integer NOT NULL,
	"failure_reason" text,
	CONSTRAINT "webhook_delivery_attempts_delivery_attempt_key" UNIQUE("delivery_id","attempt")
);
--> statement-breakpoint
ALTER TABLE "tula"."webhook_delivery_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tula"."webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_event_fk";
--> statement-breakpoint
ALTER TABLE "tula"."webhook_deliveries" ALTER COLUMN "event_id" DROP NOT NULL;--> statement-breakpoint
-- Changed by hand: drizzle-kit wrote `event_type` and `state` as NOT NULL at once, which fails
-- on a table that has rows. They are added nullable, filled below, and then made NOT NULL.
ALTER TABLE "tula"."webhook_deliveries" ADD COLUMN "event_type" text;--> statement-breakpoint
ALTER TABLE "tula"."webhook_deliveries" ADD COLUMN "test" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tula"."webhook_deliveries" ADD COLUMN "state" text;--> statement-breakpoint
ALTER TABLE "tula"."webhook_deliveries" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tula"."webhook_deliveries" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tula"."webhook_deliveries" ADD COLUMN "last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tula"."webhook_deliveries" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tula"."webhook_endpoints" ADD COLUMN "disabled_reason" text;--> statement-breakpoint
ALTER TABLE "tula"."webhook_endpoints" ADD COLUMN "failing_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tula"."webhook_delivery_attempts" ADD CONSTRAINT "webhook_delivery_attempts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."webhook_delivery_attempts" ADD CONSTRAINT "webhook_delivery_attempts_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."webhook_delivery_attempts" ADD CONSTRAINT "webhook_delivery_attempts_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_delivery_attempts_environment_id_idx" ON "tula"."webhook_delivery_attempts" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "events_environment_delivered_idx" ON "tula"."events" USING btree ("environment_id","delivered_at") WHERE delivered_at is not null;--> statement-breakpoint
-- Added by hand: the rows 0018 wrote are carried over into the new shape.
--
-- Both tables force row-level security on their owner, and a migration sets no environment, so
-- as written these statements would match no row unless the migrating role is a superuser. The
-- force is lifted for the length of the backfill and put back right after it (src/rls.test.ts
-- fails for a tenant table that is not forced). The runtime role is not the owner and is
-- bound by the policies throughout.
ALTER TABLE "tula"."webhook_deliveries" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tula"."events" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Every existing row had its event (the foreign key dropped above guaranteed it).
UPDATE "tula"."webhook_deliveries" d
SET "event_type" = e."type"
FROM "tula"."events" e
WHERE e."environment_id" = d."environment_id" AND e."id" = d."event_id";
--> statement-breakpoint
-- A row with one of these two words recorded that NOTHING was sent: they were never attempts
-- and get no attempt row. Every other row was one request, which becomes attempt 1.
INSERT INTO "tula"."webhook_delivery_attempts"
	("id", "project_id", "environment_id", "delivery_id", "attempt", "attempted_at", "status_code", "duration_ms", "failure_reason")
SELECT gen_random_uuid(), d."project_id", d."environment_id", d."id", 1, d."attempted_at", d."status_code", d."duration_ms", d."failure_reason"
FROM "tula"."webhook_deliveries" d
WHERE d."failure_reason" IS NULL OR d."failure_reason" NOT IN ('signing_failed', 'endpoint_unresponsive');
--> statement-breakpoint
-- What 0018 settled as failed stays given up, with one exception: a delivery that was settled
-- WITHOUT being tried (`endpoint_unresponsive`, `signing_failed`) in the last three days, the
-- age at which the worker gives a delivery up, is handed back to the worker. ADR 0034 promised
-- that retries would pick those up first. A failed request from before retries existed is not
-- sent again: its receiver has not been told to expect it.
UPDATE "tula"."webhook_deliveries"
SET
	"state" = CASE
		WHEN "outcome" = 'delivered' THEN 'delivered'
		WHEN "failure_reason" IN ('signing_failed', 'endpoint_unresponsive') AND "created_at" > now() - interval '3 days' THEN 'pending'
		ELSE 'failed'
	END,
	"attempts" = CASE WHEN "failure_reason" IN ('signing_failed', 'endpoint_unresponsive') THEN 0 ELSE 1 END,
	"last_attempt_at" = CASE WHEN "failure_reason" IN ('signing_failed', 'endpoint_unresponsive') THEN NULL ELSE "attempted_at" END,
	"next_attempt_at" = CASE
		WHEN "outcome" <> 'delivered' AND "failure_reason" IN ('signing_failed', 'endpoint_unresponsive') AND "created_at" > now() - interval '3 days' THEN now()
		ELSE NULL
	END,
	"completed_at" = CASE
		WHEN "outcome" <> 'delivered' AND "failure_reason" IN ('signing_failed', 'endpoint_unresponsive') AND "created_at" > now() - interval '3 days' THEN NULL
		ELSE "attempted_at"
	END;
--> statement-breakpoint
ALTER TABLE "tula"."events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tula"."webhook_deliveries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tula"."webhook_deliveries" ALTER COLUMN "event_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tula"."webhook_deliveries" ALTER COLUMN "state" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "tula"."webhook_deliveries" USING btree ("environment_id","endpoint_id","next_attempt_at") WHERE state = 'pending';--> statement-breakpoint
CREATE INDEX "webhook_deliveries_pending_age_idx" ON "tula"."webhook_deliveries" USING btree ("environment_id","created_at") WHERE state = 'pending';--> statement-breakpoint
CREATE INDEX "webhook_deliveries_endpoint_log_idx" ON "tula"."webhook_deliveries" USING btree ("environment_id","endpoint_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_environment_created_idx" ON "tula"."webhook_deliveries" USING btree ("environment_id","created_at");--> statement-breakpoint
ALTER TABLE "tula"."webhook_deliveries" DROP COLUMN "attempted_at";--> statement-breakpoint
ALTER TABLE "tula"."webhook_deliveries" DROP COLUMN "outcome";--> statement-breakpoint
ALTER TABLE "tula"."webhook_deliveries" DROP COLUMN "duration_ms";--> statement-breakpoint
ALTER TABLE "tula"."webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_environment_id_id_key" UNIQUE("environment_id","id");--> statement-breakpoint
-- Moved down by hand: this foreign key references the unique constraint just above.
ALTER TABLE "tula"."webhook_delivery_attempts" ADD CONSTRAINT "webhook_delivery_attempts_delivery_fk" FOREIGN KEY ("environment_id","delivery_id") REFERENCES "tula"."webhook_deliveries"("environment_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "events_retention_floor" ON "tula"."events" AS RESTRICTIVE FOR DELETE TO public USING (delivered_at is not null and occurred_at < now() - interval '1 day');--> statement-breakpoint
CREATE POLICY "webhook_deliveries_retention_floor" ON "tula"."webhook_deliveries" AS RESTRICTIVE FOR DELETE TO public USING (state <> 'pending' and created_at < now() - interval '7 days');--> statement-breakpoint
CREATE POLICY "webhook_delivery_attempts_tenant_isolation" ON "tula"."webhook_delivery_attempts" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
-- Everything below is added by hand (Drizzle cannot declare any of it).
--
-- FORCE applies the policy to the table owner too; src/rls.test.ts fails for a tenant table
-- without it.
ALTER TABLE "tula"."webhook_delivery_attempts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Runtime grants. Each is the least the code path that needs it can work with.
--
-- `webhook_delivery_attempts`: append-only. The worker inserts a row for every request it
-- makes and nothing rewrites one. No UPDATE and no DELETE: a row goes only with its delivery,
-- by cascade, and a cascade runs as the table's owner.
GRANT SELECT, INSERT ON "tula"."webhook_delivery_attempts" TO tula_app;
--> statement-breakpoint
-- `webhook_deliveries`: until now SELECT and INSERT. A delivery now moves (pending, then
-- delivered or given up), so the runtime role may update the columns that say where it stands
-- and no others: not the endpoint, the event, the type, the test flag or `created_at`. A
-- delivery cannot be pointed at another endpoint or event, or made to look older or younger.
GRANT UPDATE ("state", "attempts", "next_attempt_at", "last_attempt_at", "status_code", "failure_reason", "completed_at", "updated_at")
	ON "tula"."webhook_deliveries" TO tula_app;
--> statement-breakpoint
-- The retention job deletes old delivery rows (ADR 0017). What bounds the delete, in the
-- database and not only in the job:
--   * `webhook_deliveries_tenant_isolation` (0018) covers DELETE: only rows of the environment
--     in `tula.environment_id`, and none when it is not set (fail closed).
--   * `webhook_deliveries_retention_floor` above is ANDed with it: never a row that is still
--     `pending`, and never one younger than seven days, whatever the statement asks for.
--     `created_at` is not among the updatable columns, so a row cannot be aged past the floor.
--   * Still no TRUNCATE.
GRANT DELETE ON "tula"."webhook_deliveries" TO tula_app;
--> statement-breakpoint
-- `events`: the runtime role has held UPDATE on the whole table since 0003, though the only
-- thing it has ever updated is `delivered_at` (the webhook worker; every other writer inserts).
-- Narrowed here to that one column: a payload, a type or a time can no longer be changed by
-- the API's role.
REVOKE UPDATE ON "tula"."events" FROM tula_app;
--> statement-breakpoint
GRANT UPDATE ("delivered_at") ON "tula"."events" TO tula_app;
--> statement-breakpoint
-- The retention job deletes settled events (ADR 0017). Bounded like the audit log's delete in
-- 0017: the tenant policy to the environment in scope, and `events_retention_floor` above to
-- events that a worker has settled (`delivered_at` set) and that happened more than a day ago.
-- `occurred_at` cannot be updated by this role any more, so the floor cannot be got past by
-- backdating. An event no worker has settled can never be deleted by the API.
GRANT DELETE ON "tula"."events" TO tula_app;
