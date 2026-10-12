import type { IdTokenProvider, SignInFlow, TulaClient } from '@tula/core'
import { clientError, toTulaError } from './errors'
import { hostOf, type IdTokenCredential, type IdTokenSheet } from './host'
import type { Schedule } from './secure-storage'
import { sha256Hex } from './sha256'

// Signing in with Google's or Apple's own sheet (ADR 0045, ADR 0047, ADR 0051). The sign-in
// is `@tula/core`'s `signIn.withIdToken`: it asks the server for a nonce and exchanges the
// token. This module shows the sheet between the two, and decides nothing about the account.

/**
 * What a native provider sign-in asks for.
 *
 * @example
 * ```ts
 * const input: IdTokenSignInInput = { provider: 'apple' }
 * ```
 */
export interface IdTokenSignInInput {
  /** The provider whose sheet to show: `google` or `apple`. */
  provider: IdTokenProvider
}

/**
 * How a native provider sign-in ended.
 *
 * - `complete`: signed in. `flow.step` is the `complete` step.
 * - `needs_step`: the provider vouched and the server asks for more (a second factor).
 *   Go on with `flow`.
 * - `cancelled`: the user dismissed the sheet, or nobody answered it in time. Not an error
 *   and not a sign-in: nothing was sent to prove anything, and the action works again.
 *
 * @example
 * ```ts
 * const outcome: IdTokenOutcome = await signInWithIdToken(tula, { provider: 'google' })
 * if (outcome.status === 'complete') showHome()
 * ```
 */
export type IdTokenOutcome =
  | { readonly status: 'complete'; readonly flow: SignInFlow }
  | { readonly status: 'needs_step'; readonly flow: SignInFlow }
  | { readonly status: 'cancelled' }

/**
 * The longest a provider's sheet holds its place, in milliseconds: five minutes, half the
 * lifetime of the attempt its token is for. A native promise can be left unsettled (an app
 * sent to the background while the sheet is up); after this the sign-in ends as one nobody
 * answered, the place is free, and whatever the abandoned sheet answers later is dropped.
 *
 * @example
 * ```ts
 * ID_TOKEN_SHEET_CEILING_MS // 300000
 * ```
 */
export const ID_TOKEN_SHEET_CEILING_MS = 300_000

/** The sheet's answer, or `null` once the ceiling is reached; what comes later is dropped. */
function answered(
  sheet: IdTokenSheet,
  nonce: string,
  schedule: Schedule
): Promise<IdTokenCredential | null> {
  return new Promise((resolve, reject) => {
    let over = false
    const end = (finish: () => void) => {
      if (!over) {
        over = true
        finish()
      }
    }
    const stop = schedule(() => end(() => resolve(null)), ID_TOKEN_SHEET_CEILING_MS)
    // Started inside a promise: a module that throws at the call rejects like one that
    // rejects.
    new Promise<IdTokenCredential | null>((start) => {
      start(sheet.signIn({ nonce }))
    }).then(
      (value) => {
        stop()
        end(() => resolve(value))
      },
      (error: unknown) => {
        stop()
        end(() => reject(error))
      }
    )
  })
}

/** A name of at most the 100 characters the server takes, or nothing. */
function namePart(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 100 ? value : undefined
}

/**
 * Sign in with a provider's native sheet: ask the server for a nonce, show the sheet with
 * it, and exchange the ID token the sheet hands back.
 *
 * The sign-in is `@tula/core`'s (`signIn.withIdToken`); the attempt is started as this
 * app's platform. **For Apple this function hashes the nonce** (the lowercase hexadecimal
 * SHA-256 of the server's nonce, the one form the server accepts in Apple's token) and
 * passes the name Apple's sheet hands over beside the token; Google is given the server's
 * nonce as it is. The ID token is sent once, in a JSON body, and kept nowhere: not in
 * storage, an error, a log line or what this function returns.
 *
 * One sheet at a time: a call while a sheet, a passkey sheet or a provider's browser of
 * this client is out is `flow.busy`, before any request. Where the sheet cannot be shown
 * (the client was created without one, the native module is not in the build, the device
 * has no such sign-in) the call is refused with `storage.failed`, before any request:
 * leave the control out there (`useIdTokenProviders`).
 *
 * @param client - A client from `createTulaExpoClient`, created with `google` or `apple`.
 * @param input - The provider.
 * @returns How the sign-in ended.
 * @throws TulaError what the start answered (`auth.method_disabled`, `rate_limited`,
 *   `device.binding_not_supported`), what the exchange answered
 *   (`auth.invalid_credentials` for a token the server refuses, `oauth.account_exists`,
 *   `oauth.email_unverified`, `service.unavailable`), `network.failed` or
 *   `network.timeout`, `flow.busy`, `storage.failed` where there is no sheet, and
 *   `internal` when the sheet itself failed.
 *
 * @example
 * ```ts
 * const outcome = await signInWithIdToken(tula, { provider: 'apple' })
 * ```
 */
export async function signInWithIdToken(
  client: TulaClient,
  input: IdTokenSignInInput
): Promise<IdTokenOutcome> {
  const host = hostOf(client)
  const { provider } = input
  const sheet = host?.idTokenSheet(provider)
  if (!host || !sheet) {
    // No sheet to show: as a client with no browser for a round trip, before any request.
    throw clientError('storage.failed')
  }
  if (host.idTokenSheetOut || host.roundTrip || host.sheetHeld()) {
    throw clientError('flow.busy')
  }
  host.idTokenSheetOut = true
  try {
    // Asked each time: a build without the module, or a device without the sign-in, is
    // found out here and not when the client was created.
    if (!(await host.askIdTokenWays()).includes(provider)) {
      throw clientError('storage.failed')
    }
    const pending = await client.signIn.withIdToken({ provider })
    // Apple's token carries the hash of the nonce its request was given; the server
    // compares it with the hash of its own (ADR 0047). The app's side of that is here.
    const nonce = provider === 'apple' ? sha256Hex(pending.nonce) : pending.nonce
    let credential: IdTokenCredential | null
    try {
      credential = await answered(sheet, nonce, host.schedule)
    } catch {
      // Whatever the sheet said stays with it: an app's own sheet, or a module, may put
      // anything in an error, and a `TulaError` keeps its cause.
      throw toTulaError(new Error('The provider\u2019s sheet failed.'))
    }
    if (credential === null) {
      return { status: 'cancelled' }
    }
    if (typeof credential?.idToken !== 'string' || credential.idToken === '') {
      throw toTulaError(new Error('The sheet handed over no ID token.'))
    }
    // Only Apple's sheet hands a name over that its token does not carry.
    const givenName = namePart(credential.givenName)
    const familyName = namePart(credential.familyName)
    const flow = await pending.exchange(
      credential.idToken,
      provider === 'apple' && (givenName !== undefined || familyName !== undefined)
        ? { ...(givenName && { givenName }), ...(familyName && { familyName }) }
        : undefined
    )
    return { status: flow.step.status === 'complete' ? 'complete' : 'needs_step', flow }
  } finally {
    host.idTokenSheetOut = false
  }
}

/**
 * Ask which providers' native sheets can be shown right now, for deciding which controls
 * to draw outside a component (`useIdTokenProviders` is the same inside one).
 *
 * @param client - A client from `createTulaExpoClient`.
 * @returns The providers; empty for a client created with neither sheet, and for a build
 *   or a device that has neither.
 *
 * @example
 * ```ts
 * const providers = await idTokenProviders(tula) // ['apple']
 * ```
 */
export async function idTokenProviders(client: TulaClient): Promise<readonly IdTokenProvider[]> {
  return (await hostOf(client)?.askIdTokenWays()) ?? []
}
