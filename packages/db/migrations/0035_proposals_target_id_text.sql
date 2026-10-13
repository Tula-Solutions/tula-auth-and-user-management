-- A proposal's target is a user or a session, named by its UUID, or an OAuth provider, named
-- as the admin API names one everywhere: by its name from the contract's closed list
-- (`google`). So the column becomes text (ADR 0053, "The other reversible operations"). A
-- UUID's text form is lower-case hexadecimal and hyphens, which the check accepts: every
-- existing row passes. The check keeps the column to what an id or such a name is made of,
-- never a sentence. The column-level grants of 0033 are unchanged: the runtime role still
-- cannot update `target_id`.
ALTER TABLE "tula"."proposals" ALTER COLUMN "target_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "tula"."proposals" ADD CONSTRAINT "proposals_target_id_shape" CHECK ("tula"."proposals"."target_id" ~ '^[a-z0-9_-]{1,64}$');
