-- A verification of a domain now has a lifetime (ADR 0065, "Verified domains", "Lapse"). A
-- domain can be lost and registered again by someone else; a claim that was never checked
-- again would keep matching their users. `expires_at` is the deadline (the contract's
-- DOMAIN_VERIFICATION_LIFETIME_DAYS after `verified_at`); `reminded_days` records which
-- reminder the managers were last emailed so each is sent once.
--
-- A verified row may now hold a code beside `verified_at` (a manager proving it again; the
-- row keeps matching until `expires_at`), so the state check no longer says that a code
-- exists exactly while the row is unverified: a pending row always has a code, `expires_at`
-- is set exactly when `verified_at` is, and the code columns are all set or all null.
ALTER TABLE "tula"."organization_domains" DROP CONSTRAINT "organization_domains_state";--> statement-breakpoint
ALTER TABLE "tula"."organization_domains" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tula"."organization_domains" ADD COLUMN "reminded_days" integer;--> statement-breakpoint
-- Backfill. A row verified before this change gets the later of its original verification plus
-- 365 days (DOMAIN_VERIFICATION_LIFETIME_DAYS) and 30 days from now
-- (DOMAIN_REVERIFICATION_GRACE_DAYS): the clock starts at `verified_at`, as for any other row,
-- but nobody is cut off the day this ships, and the reminders (30 and 7 days) then reach every
-- manager before a long-verified domain stops matching. The values are written out because a
-- migration must not change when a constant does. Row-level security is forced on the table
-- and a migration sets no environment, so the force is lifted for the one UPDATE and put back
-- (as in 0019 and 0029); src/rls.test.ts fails for a tenant table that is not forced.
ALTER TABLE "tula"."organization_domains" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "tula"."organization_domains"
SET "expires_at" = greatest("verified_at" + interval '365 days', now() + interval '30 days')
WHERE "verified_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "tula"."organization_domains" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "organization_domains_expiry_idx" ON "tula"."organization_domains" USING btree ("expires_at") WHERE "tula"."organization_domains"."verified_at" is not null;--> statement-breakpoint
ALTER TABLE "tula"."organization_domains" ADD CONSTRAINT "organization_domains_reminded" CHECK ("tula"."organization_domains"."reminded_days" is null or "tula"."organization_domains"."reminded_days" > 0);--> statement-breakpoint
ALTER TABLE "tula"."organization_domains" ADD CONSTRAINT "organization_domains_state" CHECK (("tula"."organization_domains"."verified_at" is null) = ("tula"."organization_domains"."expires_at" is null) and ("tula"."organization_domains"."verified_at" is not null or "tula"."organization_domains"."code_hash" is not null) and ("tula"."organization_domains"."code_hash" is null) = ("tula"."organization_domains"."code_expires_at" is null));--> statement-breakpoint
-- The runtime role writes the two new columns (verifying and the reminder job). UPDATE is by
-- column since 0041; this adds to it.
GRANT UPDATE ("expires_at", "reminded_days") ON "tula"."organization_domains" TO tula_app;
