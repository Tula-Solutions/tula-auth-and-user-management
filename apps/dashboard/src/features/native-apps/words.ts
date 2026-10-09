import { type NativeAppIdentity, nativeAppWeakenings } from '@tula/contract'
import { messageFor, toApiError } from '~/api/errors'
import type { NativeApp } from '~/api/generated/api.gen'
import { own } from '~/lib/own'
import { printable } from '~/lib/printable'

// Every sentence the native apps screen says about an app, a widening or a refusal. What a
// change widens is the contract's rule (`nativeAppWeakenings`, shared with the audit log and
// `tula apply`); only the words are the dashboard's.

const PLATFORMS: Record<string, string> = { ios: 'iOS', android: 'Android' }

/**
 * A platform's name for a person.
 *
 * @param platform - `ios`, `android`, or whatever a later server sent.
 * @returns `iOS`, `Android`, or the server's word written out so that all of it can be seen.
 */
export function platformLabel(platform: string): string {
  return own(PLATFORMS, platform) ?? printable(platform)
}

/**
 * What names an app on its platform: the bundle id or the package name.
 *
 * It is text from the server, shown and typed to confirm, so it is written out: what a
 * reader cannot see becomes an escape.
 *
 * @param app - The app as the API lists it.
 * @returns The identifier as shown; empty for an app of a platform this version does not know.
 */
export function identifierOf(app: NativeApp): string {
  const loose = app as { bundleId?: unknown; packageName?: unknown }
  const identifier = loose.bundleId ?? loose.packageName
  return typeof identifier === 'string' ? printable(identifier) : ''
}

/**
 * The app as the contract's rules read it.
 *
 * @param app - The app as the API lists it.
 * @returns Its identity; `null` for an app of a platform this version does not know.
 */
export function identityOf(app: NativeApp): NativeAppIdentity | null {
  if (app.platform === 'ios') {
    return { platform: 'ios', teamId: app.teamId, bundleId: app.bundleId }
  }
  if (app.platform === 'android') {
    return {
      platform: 'android',
      packageName: app.packageName,
      sha256CertFingerprints: app.sha256CertFingerprints,
    }
  }
  return null
}

/**
 * The fingerprints a text area holds: one per line, or separated by spaces or commas.
 *
 * @param typed - The field's text.
 * @returns The entries as typed, in order; whether each is a fingerprint is the contract's
 *   schema to say.
 */
export function fingerprintsOf(typed: string): string[] {
  return typed.split(/[\s,]+/).filter((entry) => entry !== '')
}

const WIDENINGS: Record<'ios' | 'android', Record<string, string>> = {
  ios: {
    app: 'The file Apple fetches for this environment will name this app. An app named there may use the passwords and passkeys saved for the domain the file is published on.',
    teamId:
      'The file Apple fetches will name the app under another team: whoever signs for that team can ship the app Apple accepts as this one.',
  },
  android: {
    app: 'The file Android fetches for this environment will name this app, signed with any of these certificates. An app named there may use the passwords and passkeys saved for the domain the file is published on.',
    sha256CertFingerprints:
      'Whoever holds the key of an added certificate can sign an app that Android accepts as this one.',
  },
}

/**
 * What a change widens, in sentences: one for each thing the contract's
 * `nativeAppWeakenings` names. Removing an app, or a fingerprint, widens nothing.
 *
 * @param was - The app before; `null` when it is being registered.
 * @param is - The app after; `null` when it is being removed.
 * @returns The sentences; empty when the change widens nothing.
 */
export function wideningSentences(
  was: NativeAppIdentity | null,
  is: NativeAppIdentity | null
): string[] {
  if (is === null) {
    return []
  }
  return nativeAppWeakenings(was, is).map(
    (field) => own(WIDENINGS[is.platform], field) ?? WIDENINGS[is.platform].app
  ) as string[]
}

/**
 * Where the two association files of an environment are served.
 *
 * @param origin - The API's origin, which is the dashboard's own.
 * @param environmentId - The environment.
 * @returns The address of Apple's file and of Android's.
 */
export function associationUrls(
  origin: string,
  environmentId: string
): { apple: string; android: string } {
  const base = `${origin}/v1/environments/${encodeURIComponent(environmentId)}/.well-known`
  return {
    apple: `${base}/apple-app-site-association`,
    android: `${base}/assetlinks.json`,
  }
}

/** Which action failed, for the refusals that mean something different by action. */
export type NativeAppAction = 'create' | 'change'

/**
 * The sentence to show when a call about a native app was refused or failed.
 *
 * A conflict is "the environment is full" when it carries the cap, "already registered" when
 * adding, and "changed since it was read" otherwise. Anything else is what every other
 * screen says.
 *
 * @param error - What the mutation threw.
 * @param action - What was being done.
 * @returns A sentence for the operator, never a bare code.
 */
export function nativeAppMessageFor(error: unknown, action: NativeAppAction = 'change'): string {
  const failure = toApiError(error)
  if (failure.code === 'resource.conflict') {
    const max = own(failure.params, 'max')
    if (typeof max === 'number') {
      return `This environment already has ${max} native apps, which is as many as it may have. Remove one first.`
    }
    return action === 'create'
      ? 'This environment already has that app. Close this and look at the list again.'
      : 'It was changed elsewhere since this screen read it. Close this, look at it again, and repeat the change if it is still wanted.'
  }
  if (action === 'change' && failure.status === 404) {
    return 'It no longer exists: it was removed elsewhere. Close this and look at the list again.'
  }
  return messageFor(error)
}
