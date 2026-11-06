ALTER TABLE "tula"."users" ADD COLUMN "ban_origin" text;--> statement-breakpoint
-- Existing bans: a directory's own is a managed user whose SCIM record is inactive; every other
-- ban is an operator's, which a directory reactivation must not lift.
UPDATE "tula"."users" u SET "ban_origin" = CASE WHEN u."managed_by_directory_id" IS NOT NULL AND EXISTS (SELECT 1 FROM "tula"."scim_users" s WHERE s."user_id" = u."id" AND s."organization_id" = u."managed_by_directory_id" AND s."active" = false) THEN 'directory' ELSE 'operator' END WHERE u."banned_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "tula"."users" ADD CONSTRAINT "users_ban_origin_whole" CHECK (("tula"."users"."banned_at" IS NULL) = ("tula"."users"."ban_origin" IS NULL) AND ("tula"."users"."ban_origin" IS NULL OR "tula"."users"."ban_origin" IN ('operator', 'directory')));
