ALTER TABLE "tula"."users" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "tula"."users" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tula"."users" ADD CONSTRAINT "users_metadata_bounds" CHECK (jsonb_typeof("tula"."users"."metadata") = 'object' AND octet_length("tula"."users"."metadata"::text) <= 4096);