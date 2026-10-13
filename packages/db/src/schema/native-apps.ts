import { sql } from 'drizzle-orm'
import { check, text, unique } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import { tenantColumns, tenantConstraints } from '../tenant-columns'
import { tula } from './pg-schema'

/**
 * The native apps an environment says are its own (ADR 0040): what the two association files
 * served for the environment are built from, and from nothing else.
 *
 * An app is its `platform` and its `identifier` (an iOS bundle id, an Android package name):
 * one row per pair in an environment (`native_apps_environment_platform_identifier_key`),
 * and neither can be changed afterwards.
 *
 * An iOS app has a `team_id` and no fingerprints; an Android app has between one and ten
 * `sha256_cert_fingerprints` and no team. The API validates all of it, and the database
 * refuses a row of another shape by itself: the files are public and are served from these
 * rows as they are, so no write of any kind may put something else into one.
 *
 * Either may have `app_link_paths` (ADR 0044): exact paths whose links the served files hand
 * the app. The check `native_apps_app_link_paths_shape` holds each to one plain path.
 *
 * Nothing here is a secret.
 */
export const nativeApps = tula.table(
  'native_apps',
  {
    id: primaryKey(),
    ...tenantColumns(),
    /** Names from the contract's `NATIVE_APP_PLATFORMS`. */
    platform: text('platform', { enum: ['ios', 'android'] }).notNull(),
    /** The bundle id (iOS) or the package name (Android). Compared exactly. */
    identifier: text('identifier').notNull(),
    /** The Apple team an iOS app is signed by. `null` for an Android app. */
    teamId: text('team_id'),
    /**
     * SHA-256 fingerprints of an Android app's signing certificates: upper-case hex pairs
     * joined by colons, sorted. Empty for an iOS app.
     */
    sha256CertFingerprints: text('sha256_cert_fingerprints')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /**
     * The exact paths whose links the platform hands this app (ADR 0044), sorted. Empty,
     * the default, hands it none: no `applinks` entry for an iOS app, no `handle_all_urls`
     * for an Android one.
     */
    appLinkPaths: text('app_link_paths').array().notNull().default(sql`'{}'::text[]`),
    ...timestamps(),
  },
  (t) => [
    unique('native_apps_environment_platform_identifier_key').on(
      t.environmentId,
      t.platform,
      t.identifier
    ),
    check('native_apps_platform_known', sql`${t.platform} in ('ios', 'android')`),
    // Wide enough for a bundle id and a package name alike, and for nothing that could be
    // read as anything but a name where the files quote it.
    check(
      'native_apps_identifier_shape',
      sql`char_length(${t.identifier}) <= 255 and ${t.identifier} ~ '^[A-Za-z0-9_-]+(\\.[A-Za-z0-9_-]+)+$'`
    ),
    check(
      'native_apps_ios_whole',
      sql`${t.platform} <> 'ios' or (${t.teamId} is not null and ${t.teamId} ~ '^[A-Z0-9]{10}$' and cardinality(${t.sha256CertFingerprints}) = 0)`
    ),
    check(
      'native_apps_android_whole',
      sql`${t.platform} <> 'android' or (${t.teamId} is null and cardinality(${t.sha256CertFingerprints}) between 1 and 10)`
    ),
    // Joined by commas, the array must read as fingerprints and commas and nothing else, and
    // be exactly as long as that many fingerprints are: an element that holds two of them,
    // or a part of one, changes the length. `array_to_string` leaves a null element out, so
    // a null is refused by itself.
    check(
      'native_apps_fingerprints_shape',
      sql`array_position(${t.sha256CertFingerprints}, null) is null and array_to_string(${t.sha256CertFingerprints}, ',') ~ '^(([0-9A-F]{2}:){31}[0-9A-F]{2}(,([0-9A-F]{2}:){31}[0-9A-F]{2})*)?$' and char_length(array_to_string(${t.sha256CertFingerprints}, ',')) = greatest(96 * cardinality(${t.sha256CertFingerprints}) - 1, 0)`
    ),
    // At most ten paths, each one or more segments of unreserved characters after a slash:
    // no wildcard, query, fragment, encoded octet, empty segment or trailing slash, and no
    // `.` or `..` segment. Judged on the array joined by commas, as the fingerprints are: a
    // comma is in no path, so the number of commas says an element holds one path and not
    // two, and a null element (left out by `array_to_string`) is refused by itself. Apple
    // reads `*` and `?` in a served path as patterns: none may ever be stored.
    check(
      'native_apps_app_link_paths_shape',
      sql`cardinality(${t.appLinkPaths}) <= 10 and array_position(${t.appLinkPaths}, null) is null and array_to_string(${t.appLinkPaths}, ',') ~ '^((/[A-Za-z0-9._~-]+)+(,(/[A-Za-z0-9._~-]+)+)*)?$' and array_to_string(${t.appLinkPaths}, ',') !~ '/\\.\\.?(/|,|$)' and char_length(array_to_string(${t.appLinkPaths}, ',')) - char_length(replace(array_to_string(${t.appLinkPaths}, ','), ',', '')) = greatest(cardinality(${t.appLinkPaths}) - 1, 0) and char_length(array_to_string(${t.appLinkPaths}, ',')) <= 2560 and (cardinality(${t.appLinkPaths}) = 0 or char_length(array_to_string(${t.appLinkPaths}, ',')) >= 2)`
    ),
    ...tenantConstraints('native_apps', t),
  ]
)

/** A native app row. */
export type NativeAppRow = typeof nativeApps.$inferSelect
/** Insert shape for a native app. */
export type NewNativeAppRow = typeof nativeApps.$inferInsert
