-- When a password was set (ADR 0041, password expiry).
--
-- `credentials.secret_changed_at` is the time a credential's secret last became a different
-- secret. `password.expiryDays` counts a password's age from it. `updated_at` could not be
-- used: it also moves when the same password is hashed again with stronger parameters after
-- a sign-in, and a rehash must not make an old password look new.
--
-- THE BACKFILL. A password that exists gets its row's `updated_at`: the last time its hash
-- was written. That is when it was set, unless it was rehashed since, in which case it is
-- later than the truth and the password is taken for younger than it is, never older. No
-- release has changed the hash parameters so far, so on a deployment that has only run
-- releases the two are the same. The migration's own time was the other choice; it would have
-- thrown away an age the table knows.
--
-- So an environment whose policy already had `expiryDays` (every one on the `legacy` preset
-- has 90) sees it enforced from this version on, counted from when each password was last
-- set: a password older than that is replaced at its owner's next password sign-in.
--
-- Changed by hand: drizzle-kit wrote the first statement only. The table is under FORCE ROW
-- LEVEL SECURITY, which binds its owner too, and a migration sets no environment: the force
-- is lifted for the one UPDATE and restored (as in 0019). The runtime role's table-level
-- UPDATE on `credentials` (0003) covers the new column; no grant changes.
ALTER TABLE "tula"."credentials" ADD COLUMN "secret_changed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "tula"."credentials" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "tula"."credentials" SET "secret_changed_at" = "updated_at";--> statement-breakpoint
ALTER TABLE "tula"."credentials" FORCE ROW LEVEL SECURITY;
