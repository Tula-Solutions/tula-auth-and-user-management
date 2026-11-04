ALTER TABLE "tula"."users" ADD COLUMN "managed_by_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "tula"."sessions" ADD COLUMN "sso_connection_id" uuid;