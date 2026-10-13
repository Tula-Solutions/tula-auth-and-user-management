ALTER TABLE "tula"."users" ADD COLUMN "phone_number" text;--> statement-breakpoint
ALTER TABLE "tula"."users" ADD COLUMN "phone_number_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tula"."users" ADD CONSTRAINT "users_phone_number_whole" CHECK (("tula"."users"."phone_number" IS NULL) = ("tula"."users"."phone_number_verified_at" IS NULL));