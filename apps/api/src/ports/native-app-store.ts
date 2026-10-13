import type { NativeAppPlatform } from '@tula/contract'
import type { Recorded } from '~/ports/activity-log'

/** A native app's identity as stored (ADR 0040). */
export interface NativeAppRecord {
  id: string
  projectId: string
  environmentId: string
  platform: NativeAppPlatform
  /** The bundle id (iOS) or the package name (Android). An environment has one per platform. */
  identifier: string
  /** The Apple team of an iOS app; `null` for an Android app. */
  teamId: string | null
  /**
   * An Android app's signing-certificate fingerprints, in the stored form (upper case,
   * colons), sorted, each once. Empty for an iOS app.
   */
  sha256CertFingerprints: string[]
  /**
   * The exact paths of the operator's domain the app opens as app links (ADR 0044), sorted,
   * each once. Empty, the default, means the association files hand the app no link.
   */
  appLinkPaths: string[]
  createdAt: Date
  updatedAt: Date
}

/** The fields of an app an update may change. The platform and the identifier are not among them. */
export interface NativeAppChanges {
  teamId?: string
  sha256CertFingerprints?: string[]
  appLinkPaths?: string[]
}

/**
 * What of an app a change was judged against: its team, its fingerprints and its link paths. A write that
 * records whether it widened the app's identity is made only over a row that still says this,
 * so the record is about the change that was actually made.
 */
export interface NativeAppExpectation {
  teamId: string | null
  sha256CertFingerprints: readonly string[]
  appLinkPaths: readonly string[]
}

/** Native apps, always read and written inside one environment. */
export interface NativeAppStore {
  /**
   * @param environmentId - The environment to look in. Another environment's app is never returned.
   * @returns Its apps, oldest first.
   */
  list(environmentId: string): Promise<NativeAppRecord[]>

  /**
   * @param environmentId - The environment to look in.
   * @param id - The app.
   * @returns The app, or `null` when the environment has none with that id.
   */
  find(environmentId: string, id: string): Promise<NativeAppRecord | null>

  /**
   * Store a new app.
   *
   * @param record - The app.
   * @param activity - Recorded in the same transaction, only if the app was stored.
   * @returns The row as stored, or `null` when the environment already has an app of that
   *   platform and identifier: the unique key decides, so of two registrations at once one
   *   is stored.
   */
  insert(record: NativeAppRecord, activity: Recorded): Promise<NativeAppRecord | null>

  /**
   * Change an app, **only if its team, fingerprints and link paths are still what the caller
   * read**.
   *
   * @param environmentId - The environment. An app of another is not touched.
   * @param id - The app.
   * @param expected - What the caller read and judged the change against.
   * @param changes - The fields to set; one left out keeps its value.
   * @param updatedAt - When the change is made.
   * @param activity - Recorded in the same transaction, only if the row was written.
   * @returns The app as it is now, or `null` when nothing was written: the app is gone, or
   *   it is no longer what `expected` says.
   */
  update(
    environmentId: string,
    id: string,
    expected: NativeAppExpectation,
    changes: NativeAppChanges,
    updatedAt: Date,
    activity: Recorded
  ): Promise<NativeAppRecord | null>

  /**
   * Remove an app.
   *
   * @param environmentId - The environment. An app of another is not touched.
   * @param id - The app.
   * @param activity - Recorded in the same transaction, only if something was removed.
   * @returns `false` when the environment had no app with that id.
   */
  delete(environmentId: string, id: string, activity: Recorded): Promise<boolean>
}
