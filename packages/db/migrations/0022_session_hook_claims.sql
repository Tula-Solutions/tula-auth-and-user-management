-- What the environment's `before_token` hook last answered for a session (ADR 0035, "Hooks
-- before a session and before a token"). Nullable with no default: every session that exists
-- has none, and nothing is backfilled. A refresh issues what is stored here and asks nobody.
--
-- No grant changes: the runtime role has had SELECT, INSERT, UPDATE and DELETE on
-- `tula.sessions` as a table since 0003, which covers a column added later. The two new hook
-- points (`before_session`, `before_token`) need no statement at all: `hooks.point` is text
-- with no check, and the unique key `(environment_id, point)` already keeps one row a point.
ALTER TABLE "tula"."sessions" ADD COLUMN "hook_claims" jsonb;--> statement-breakpoint
-- The table's own bound: an object or nothing, and never an unbounded document. The rules a
-- claim must keep (key grammar, reserved names, 1,024 bytes of compact JSON) are the
-- service's, held when it writes and again when it reads; 4,096 bytes of the stored text is
-- deliberately looser, because that text has spaces the compact form has not.
ALTER TABLE "tula"."sessions" ADD CONSTRAINT "sessions_hook_claims_bounds" CHECK ("tula"."sessions"."hook_claims" is null or (jsonb_typeof("tula"."sessions"."hook_claims") = 'object' and octet_length("tula"."sessions"."hook_claims"::text) <= 4096));
