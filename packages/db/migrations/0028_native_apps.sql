CREATE TABLE "tula"."native_apps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"identifier" text NOT NULL,
	"team_id" text,
	"sha256_cert_fingerprints" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "native_apps_environment_platform_identifier_key" UNIQUE("environment_id","platform","identifier"),
	CONSTRAINT "native_apps_platform_known" CHECK ("tula"."native_apps"."platform" in ('ios', 'android')),
	CONSTRAINT "native_apps_identifier_shape" CHECK (char_length("tula"."native_apps"."identifier") <= 255 and "tula"."native_apps"."identifier" ~ '^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$'),
	CONSTRAINT "native_apps_ios_whole" CHECK ("tula"."native_apps"."platform" <> 'ios' or ("tula"."native_apps"."team_id" is not null and "tula"."native_apps"."team_id" ~ '^[A-Z0-9]{10}$' and cardinality("tula"."native_apps"."sha256_cert_fingerprints") = 0)),
	CONSTRAINT "native_apps_android_whole" CHECK ("tula"."native_apps"."platform" <> 'android' or ("tula"."native_apps"."team_id" is null and cardinality("tula"."native_apps"."sha256_cert_fingerprints") between 1 and 10)),
	CONSTRAINT "native_apps_fingerprints_shape" CHECK (array_position("tula"."native_apps"."sha256_cert_fingerprints", null) is null and array_to_string("tula"."native_apps"."sha256_cert_fingerprints", ',') ~ '^(([0-9A-F]{2}:){31}[0-9A-F]{2}(,([0-9A-F]{2}:){31}[0-9A-F]{2})*)?$' and char_length(array_to_string("tula"."native_apps"."sha256_cert_fingerprints", ',')) = greatest(96 * cardinality("tula"."native_apps"."sha256_cert_fingerprints") - 1, 0))
);
--> statement-breakpoint
ALTER TABLE "tula"."native_apps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tula"."native_apps" ADD CONSTRAINT "native_apps_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "tula"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."native_apps" ADD CONSTRAINT "native_apps_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "tula"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tula"."native_apps" ADD CONSTRAINT "native_apps_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "tula"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "native_apps_environment_id_idx" ON "tula"."native_apps" USING btree ("environment_id");--> statement-breakpoint
CREATE POLICY "native_apps_tenant_isolation" ON "tula"."native_apps" AS PERMISSIVE FOR ALL TO public USING (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid) WITH CHECK (environment_id = nullif(current_setting('tula.environment_id', true), '')::uuid);--> statement-breakpoint
-- Added by hand (Drizzle cannot declare any of what follows). FORCE applies the policy to the
-- table owner too; src/rls.test.ts fails for a tenant table without it.
ALTER TABLE "tula"."native_apps" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Runtime grants (new tables get none by default, see 0003).
--
-- An administrator registers and removes an app on the request path
-- (`/v1/admin/native-apps`), hence INSERT and DELETE; the two association files are read
-- from these rows by anyone (ADR 0040).
GRANT SELECT, INSERT, DELETE ON "tula"."native_apps" TO tula_app;
--> statement-breakpoint
-- UPDATE is by column, as for `hooks` in 0021: exactly what the API changes. An update sets
-- an iOS app's team or an Android app's fingerprints (with `updated_at`). Nothing else: the
-- runtime role cannot rewrite an app's `platform` or `identifier` (what the app is), its id,
-- its tenant columns or `created_at`. The shape of every value is the table's own checks, so
-- no grant can get past them.
GRANT UPDATE ("team_id", "sha256_cert_fingerprints", "updated_at")
  ON "tula"."native_apps" TO tula_app;
