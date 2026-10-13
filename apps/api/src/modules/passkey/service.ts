import {
  type AuthenticationMethod,
  androidApkKeyHashOrigin,
  CLIENT_HEADER,
  type EnvironmentSettings,
  MAX_PASSKEYS_PER_USER,
  NATIVE_APP_PLATFORMS,
  type NativeAppPlatform,
  originMatchesRelyingParty,
  PASSKEY_ALGORITHMS,
  PASSKEY_CHALLENGE_TTL_MS,
  type Passkey,
  type PasskeyAssertionCredential,
  type PasskeyCreationOptions,
  type PasskeyRegisterRequest,
  type PasskeyRequestOptions,
} from '@tula/contract'
import type { Deps, Tenant } from '~/dependencies'
import { AuthError, NotFoundError } from '~/exceptions'
import { accountLabel } from '~/lib/account-label'
import type { Actor } from '~/lib/actor'
import * as logger from '~/lib/logger'
import * as WebAuthn from '~/lib/webauthn'
import * as Audit from '~/modules/audit/service'
import * as Notices from '~/modules/notice/service'
import * as OAuth from '~/modules/oauth/service'
import * as Settings from '~/modules/settings/service'
import type { NativeAppRecord } from '~/ports/native-app-store'
import type { PasskeyChallengePurpose, PasskeyRecord } from '~/ports/passkey-store'

type Scope = Pick<Tenant, 'projectId' | 'environmentId'>

/** Purpose of the keyed hash a user's WebAuthn handle is derived with. */
export const USER_HANDLE_PURPOSE = 'passkey-user-handle'

/** The name a passkey gets when its user gives none. */
export const DEFAULT_PASSKEY_NAME = 'Passkey'

/**
 * Who a WebAuthn ceremony is for: the environment's relying-party id, and the origins a
 * response to it may carry in its client data.
 */
export interface RelyingParty {
  rpId: string
  /**
   * For a browser: the request's own `Origin`, alone. For a native app: what the environment's
   * registered apps of its platform present. Never empty.
   */
  origins: readonly string[]
}

/**
 * What of a request decides the relying party of its ceremony: two headers, and nothing of
 * its body.
 */
export interface CeremonyRequest {
  /** The request's `Origin` header; `null` or `undefined` when it has none. */
  origin: string | null | undefined
  /**
   * The client kind the caller declared (`x-tula-client`; for a flow step, the kind its
   * attempt was started with). The caller's claim: read only when there is no `Origin`, and
   * then only to choose which registered apps' origins are accepted.
   */
  client: string | null | undefined
}

/**
 * Read from a request what decides its ceremony's relying party: the `Origin` header and the
 * declared client kind. The one place a route outside a flow builds it, so none reads a body.
 *
 * @param req - The request (Hono's `c.req`).
 * @returns The two header values, `null` for one that is absent.
 */
export function ceremonyOf(req: { header(name: string): string | undefined }): CeremonyRequest {
  return { origin: req.header('origin') ?? null, client: req.header(CLIENT_HEADER) ?? null }
}

/**
 * Whether an environment can use passkeys at all: the method is on and a relying-party id is
 * set. Reads the settings only.
 *
 * @param settings - The environment's settings.
 * @returns `true` when passkeys can be registered and asked for.
 */
export function available(settings: EnvironmentSettings): boolean {
  return settings.signIn.methods.passkey.enabled && settings.passkeys.rpId !== null
}

/**
 * The origins the environment's registered apps of one platform **present** for a passkey:
 * candidates, not what is accepted. A registration alone accepts nothing; which of these a
 * response may carry is {@link acceptedNativeOrigins}.
 *
 * - **Android:** one per registered fingerprint, `android:apk-key-hash:` and the fingerprint's
 *   bytes as unpadded base64url (the contract's `androidApkKeyHashOrigin`), which is what
 *   Credential Manager writes for an app signed with that certificate.
 * - **iOS:** `https://<rpId>`, and only when an iOS app is registered. Apple's API writes that
 *   string for every app whose associated domains include the relying party: it is the origin
 *   of a page on the relying party's own domain, and names no app. What ties a response to a
 *   registered app is Apple's own check of the domain's association file, which the server
 *   serves and cannot see applied. **Because it is a page's origin, {@link relyingParty}
 *   accepts it only where the environment allows that page**: this function says what the
 *   apps present, not what is accepted.
 *
 * @param apps - The environment's rows.
 * @param platform - The platform the caller declared.
 * @param rpId - The environment's relying-party id.
 * @returns The origins, each once; empty when no app of the platform is registered.
 */
export function nativeOrigins(
  apps: readonly {
    platform: NativeAppRecord['platform']
    sha256CertFingerprints: readonly string[]
  }[],
  platform: NativeAppPlatform,
  rpId: string
): string[] {
  const registered = apps.filter((app) => app.platform === platform)
  if (platform === 'ios') {
    return registered.length > 0 ? [`https://${rpId}`] : []
  }
  const origins = new Set<string>()
  for (const app of registered) {
    for (const fingerprint of app.sha256CertFingerprints) {
      const origin = androidApkKeyHashOrigin(fingerprint)
      if (origin !== null) {
        origins.add(origin)
      }
    }
  }
  return [...origins]
}

/**
 * Whether a response may carry a page's origin: the environment allows the origin
 * (`urls.allowedOrigins`, compared exactly, in every tier: the `local` tier's "any loopback
 * origin" rule of CORS is not applied here) and it belongs to the relying-party id.
 *
 * The one statement of that rule. A browser's `Origin` header is judged by it, and so is the
 * origin an iOS app presents, which is a page's (`https://<rpId>`): a response is never
 * accepted for a page's origin the environment does not allow, whoever sent the request.
 *
 * @param settings - The environment's settings.
 * @param origin - The origin a response would carry.
 * @param rpId - The environment's relying-party id.
 * @returns `true` when a response carrying `origin` may be accepted.
 */
function acceptsPageOrigin(
  settings: Pick<EnvironmentSettings, 'urls'>,
  origin: string,
  rpId: string
): boolean {
  return settings.urls.allowedOrigins.includes(origin) && originMatchesRelyingParty(origin, rpId)
}

/**
 * The origins a response from a native app of one platform may carry: what the environment's
 * registered apps present ({@link nativeOrigins}), less what the environment does not accept.
 *
 * An Android origin is no page's and is accepted as presented. **An iOS origin is a page's**
 * (`https://<rpId>`) and is accepted only where the environment allows that page
 * ({@link acceptsPageOrigin}): otherwise a script on that page could run the browser's
 * ceremony and send the result with no `Origin` header under the name `ios`.
 *
 * The one statement of that rule: {@link relyingParty} decides with it, and the diagnostics
 * ask it why an iOS app's requests would be refused.
 *
 * @param settings - The environment's settings (its allowed origins).
 * @param apps - The environment's rows.
 * @param platform - The platform the caller declared.
 * @param rpId - The environment's relying-party id.
 * @returns The origins to accept; empty when the platform has no registered app or (iOS) the
 *   relying party's own origin is not allowed.
 */
export function acceptedNativeOrigins(
  settings: Pick<EnvironmentSettings, 'urls'>,
  apps: Parameters<typeof nativeOrigins>[0],
  platform: NativeAppPlatform,
  rpId: string
): string[] {
  const presented = nativeOrigins(apps, platform, rpId)
  return platform === 'ios'
    ? presented.filter((origin) => acceptsPageOrigin(settings, origin, rpId))
    : presented
}

/**
 * The relying party of a WebAuthn ceremony run from a request, or a refusal.
 *
 * **The one place that decides which origins a response may carry**, from two headers of the
 * request and the environment's own rows; nothing a client puts in a body chooses one.
 *
 * - **A request with an `Origin` header is a browser's and is judged by that header alone**,
 *   whatever client kind it declares: the origin must be one the environment allows
 *   (`urls.allowedOrigins`) and belong to its relying-party id (the id itself or a subdomain).
 *   The response must then carry exactly that origin.
 * - **A request with no `Origin` that declares a native client kind** (`ios`, `android`) is
 *   answered from the environment's registered native apps of that platform
 *   ({@link nativeOrigins}). With no such app it is refused as a request with no origin has
 *   always been: there is no origin it could present that the environment accepts.
 * - **An iOS app's origin is a page's, and is held to the rule for pages**: it is accepted
 *   only when the environment also allows `https://<rpId>` (`urls.allowedOrigins`). Without
 *   that a script on that page could run the browser's ceremony and send the result with no
 *   `Origin` under the name `ios`. Not allowed is answered exactly as "no iOS app". An
 *   Android origin is no page's (no browser writes `android:apk-key-hash:`) and needs no
 *   entry on that list.
 * - **Anything else with no `Origin`** (`web`, `server`, no kind, an unknown one) cannot use
 *   passkeys.
 *
 * The client kind is the caller's word, as an `Origin` header is outside a browser. What it
 * chooses is a set of origins the *response* must then match, inside client data the
 * authenticator signed over (ADR 0027).
 *
 * Checked on **every** passkey step, before anything is counted, spent or stored: an attempt or
 * a challenge started before passkeys were switched off, or before an app was removed, must
 * not finish with one.
 *
 * @param deps - Settings store, native-app store and config.
 * @param scope - The environment.
 * @param request - The request's `Origin` header and the client kind it declared.
 * @returns The relying-party id and the origins to accept.
 * @throws AuthError `auth.method_disabled` when passkeys are off or no relying-party id is
 *   set; or `request.origin_not_allowed` for a foreign or non-matching origin, and for a
 *   request with no origin that is not a native app's, whose platform has no registered app,
 *   or (iOS) whose relying party's own origin the environment does not allow.
 */
export async function relyingParty(
  deps: Pick<Deps, 'environmentSettings' | 'config' | 'nativeApps'>,
  scope: Pick<Scope, 'environmentId'>,
  request: CeremonyRequest
): Promise<RelyingParty> {
  const settings = await Settings.current(deps, scope)
  const { rpId } = settings.passkeys
  if (!available(settings) || rpId === null) {
    throw new AuthError('auth.method_disabled', { method: 'passkey' })
  }
  const { origin } = request
  if (origin !== null && origin !== undefined) {
    // A header that is there is judged as a page's, an empty one and `null` (what a sandboxed
    // frame sends) included: neither is on any list, and neither falls through to the rule
    // for a request that has none.
    if (!acceptsPageOrigin(settings, origin, rpId)) {
      throw new AuthError('request.origin_not_allowed')
    }
    return { rpId, origins: [origin] }
  }
  // A native client kind is a platform's own name, compared whole: `ios` or `android`.
  const platform = NATIVE_APP_PLATFORMS.find((name) => name === request.client)
  if (platform === undefined) {
    throw new AuthError('request.origin_not_allowed')
  }
  const origins = acceptedNativeOrigins(
    settings,
    await deps.nativeApps.list(scope.environmentId),
    platform,
    rpId
  )
  if (origins.length === 0) {
    // The answer a request with no `Origin` got before native apps could use passkeys, kept:
    // registering an app (and, for iOS, allowing the origin) is what changes it. One answer
    // for "no app" and "origin not allowed", so that the two are not told apart.
    throw new AuthError('request.origin_not_allowed')
  }
  return { rpId, origins }
}

/**
 * The options a browser asks an authenticator for an assertion with.
 *
 * @param rp - The relying party.
 * @param challenge - A fresh challenge ({@link WebAuthn.newChallenge}).
 * @param allow - The passkeys to accept, for a user who is already known (a second factor, a
 *   step-up). Left out for a sign-in: the credential is discoverable and the options are the
 *   same for every caller.
 * @returns `PublicKeyCredentialRequestOptionsJSON`.
 */
export function requestOptions(
  rp: RelyingParty,
  challenge: string,
  allow?: readonly PasskeyRecord[]
): PasskeyRequestOptions {
  return {
    challenge,
    timeout: PASSKEY_CHALLENGE_TTL_MS,
    rpId: rp.rpId,
    userVerification: 'required',
    ...(allow && {
      allowCredentials: allow.map((passkey) => ({
        type: 'public-key' as const,
        id: passkey.credentialId,
        ...(passkey.transports.length > 0 && { transports: passkey.transports }),
      })),
    }),
  }
}

function toPasskey(record: PasskeyRecord): Passkey {
  return {
    id: record.id,
    name: record.name,
    synced: record.backedUp,
    createdAt: record.createdAt.toISOString(),
    lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
  }
}

/**
 * The handle a user is known to authenticators by (`user.id`): 32 bytes, base64url.
 *
 * Derived, `HMAC-SHA256(key from TULA_MASTER_KEY, environment : user)`, rather than drawn and
 * stored ahead of time: it is the same for every passkey of one user (so an authenticator
 * replaces rather than piles up credentials), it says nothing about the email or the user id
 * to anyone without the key, and nothing has to be kept between asking for options and
 * finishing. Each passkey row stores the handle it was registered with, and an assertion is
 * checked against its own row's: after a change of the master key new registrations get a
 * different handle than a user's existing rows, and both keep working (the only effect is
 * that an authenticator holding an old passkey adds the new one beside it instead of
 * replacing it).
 */
async function userHandle(
  deps: Pick<Deps, 'keyedHash'>,
  scope: Pick<Scope, 'environmentId'>,
  userId: string
): Promise<string> {
  const hex = await deps.keyedHash.hmac(USER_HANDLE_PURPOSE, `${scope.environmentId}:${userId}`)
  return Buffer.from(hex, 'hex').toString('base64url')
}

/**
 * Issue a challenge to a signed-in session, replacing an earlier one of the same purpose.
 *
 * @param deps - Passkey store, ids and clock.
 * @param scope - The project and environment.
 * @param self - The signed-in user and their session.
 * @param purpose - What the challenge is for.
 * @returns The challenge: 32 random bytes, honoured once and for five minutes.
 */
export async function issueChallenge(
  deps: Pick<Deps, 'passkeys' | 'ids' | 'clock'>,
  scope: Scope,
  self: { userId: string; sessionId: string },
  purpose: PasskeyChallengePurpose
): Promise<string> {
  const now = deps.clock.now()
  const challenge = WebAuthn.newChallenge()
  await deps.passkeys.putChallenge({
    id: deps.ids.next(),
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    userId: self.userId,
    sessionId: self.sessionId,
    purpose,
    challenge,
    expiresAt: new Date(now.getTime() + PASSKEY_CHALLENGE_TTL_MS),
    createdAt: now,
  })
  return challenge
}

/**
 * Take the challenge a session was issued: it is deleted as it is read, so it works once.
 *
 * @param deps - Passkey store and clock.
 * @param scope - The environment.
 * @param self - The signed-in user and their session.
 * @param purpose - What the challenge was issued for.
 * @returns The challenge, or `null` when the session has none, it expired, or it was issued to
 *   another user.
 */
export async function takeChallenge(
  deps: Pick<Deps, 'passkeys' | 'clock'>,
  scope: Pick<Scope, 'environmentId'>,
  self: { userId: string; sessionId: string },
  purpose: PasskeyChallengePurpose
): Promise<string | null> {
  const taken = await deps.passkeys.takeChallenge(
    scope.environmentId,
    self.sessionId,
    purpose,
    deps.clock.now()
  )
  return taken && taken.userId === self.userId ? taken.challenge : null
}

/**
 * The signed-in user's passkeys. Never key material or a credential id.
 *
 * Works whether or not passkeys are switched on, so that a user can always see and remove what
 * they have.
 *
 * @param deps - Passkey store.
 * @param scope - The environment.
 * @param userId - The signed-in user.
 * @returns The passkeys, oldest first.
 */
export async function list(
  deps: Pick<Deps, 'passkeys'>,
  scope: Pick<Scope, 'environmentId'>,
  userId: string
): Promise<Passkey[]> {
  return (await deps.passkeys.listForUser(scope.environmentId, userId)).map(toPasskey)
}

type RegistrationDeps = Pick<
  Deps,
  | 'passkeys'
  | 'users'
  | 'keyedHash'
  | 'ids'
  | 'clock'
  | 'environmentSettings'
  | 'config'
  | 'nativeApps'
  | 'mailer'
  | 'rateLimiter'
>

/**
 * Start registering a passkey: the options for `navigator.credentials.create()`.
 *
 * A discoverable credential with user verification (`residentKey: 'required'`,
 * `userVerification: 'required'`), no attestation, and the user's existing passkeys in
 * `excludeCredentials` so that one authenticator is not registered twice. The challenge is
 * stored for the asking session only; asking again replaces it.
 *
 * @param deps - Passkey store, users, keyed hash, settings, ids and clock.
 * @param scope - The project and environment.
 * @param self - The signed-in user and their session, from the access token.
 * @param request - The request's `Origin` and declared client kind.
 * @returns `PublicKeyCredentialCreationOptionsJSON`.
 * @throws AuthError `auth.method_disabled`, `request.origin_not_allowed` or
 *   `passkey.limit_reached`.
 * @throws NotFoundError when the user does not exist.
 */
export async function startRegistration(
  deps: RegistrationDeps,
  scope: Scope,
  self: { userId: string; sessionId: string },
  request: CeremonyRequest
): Promise<PasskeyCreationOptions> {
  const rp = await relyingParty(deps, scope, request)
  const user = await deps.users.findById(scope.environmentId, self.userId)
  if (!user) {
    throw new NotFoundError()
  }
  const existing = await deps.passkeys.listForUser(scope.environmentId, user.id)
  if (existing.length >= MAX_PASSKEYS_PER_USER) {
    throw new AuthError('passkey.limit_reached')
  }
  const settings = await Settings.current(deps, scope)
  const challenge = await issueChallenge(deps, scope, self, 'registration')
  return {
    rp: { id: rp.rpId, name: settings.app.name },
    user: {
      id: await userHandle(deps, scope, user.id),
      name: accountLabel(user),
      displayName: [user.firstName, user.lastName].filter(Boolean).join(' ') || accountLabel(user),
    },
    challenge,
    pubKeyCredParams: PASSKEY_ALGORITHMS.map((alg) => ({ type: 'public-key' as const, alg })),
    timeout: PASSKEY_CHALLENGE_TTL_MS,
    excludeCredentials: existing.map((passkey) => ({
      type: 'public-key' as const,
      id: passkey.credentialId,
      ...(passkey.transports.length > 0 && { transports: passkey.transports }),
    })),
    authenticatorSelection: {
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    },
    attestation: 'none',
  }
}

/**
 * Finish registering a passkey: verify what the browser made and store its public key.
 *
 * The session's challenge is taken **before** the response is verified, so a response can be
 * presented once whatever the outcome. The response must be for that challenge, an origin
 * {@link relyingParty} accepts for this request and the environment's relying-party id, with
 * the user verified. The origin is compared and not kept: a passkey is not tied to where it
 * was registered beyond its relying-party id. Recorded as
 * `user.passkey_added` in the same transaction, and the owner is told.
 *
 * @param deps - Passkey store, users, keyed hash, settings, notices, ids and clock.
 * @param scope - The project and environment.
 * @param self - The signed-in user and their session.
 * @param input - The client's response and an optional name.
 * @param request - The request's `Origin` and declared client kind.
 * @param actor - The user with the request's origin, for the audit log.
 * @returns The stored passkey.
 * @throws AuthError `auth.method_disabled`, `request.origin_not_allowed`,
 *   `passkey.registration_failed` (no challenge, or a response that does not verify),
 *   `passkey.already_registered` or `passkey.limit_reached`.
 */
export async function finishRegistration(
  deps: RegistrationDeps,
  scope: Scope,
  self: { userId: string; sessionId: string },
  input: PasskeyRegisterRequest,
  request: CeremonyRequest,
  actor: Actor
): Promise<Passkey> {
  const rp = await relyingParty(deps, scope, request)
  const challenge = await takeChallenge(deps, scope, self, 'registration')
  const credential = challenge
    ? await WebAuthn.verifyRegistration(input.credential, { challenge, ...rp })
    : null
  const user = await deps.users.findById(scope.environmentId, self.userId)
  if (!credential || !user) {
    throw new AuthError('passkey.registration_failed')
  }
  const now = deps.clock.now()
  const record: PasskeyRecord = {
    id: deps.ids.next(),
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    userId: user.id,
    ...credential,
    userHandle: await userHandle(deps, scope, user.id),
    name: input.name ?? DEFAULT_PASSKEY_NAME,
    lastUsedAt: null,
    createdAt: now,
  }
  const outcome = await deps.passkeys.create(
    record,
    MAX_PASSKEYS_PER_USER,
    Audit.entry(deps, scope, {
      type: 'user.passkey_added',
      actor,
      target: { type: 'user', id: user.id },
      data: { passkeyId: record.id, synced: record.backedUp },
    })
  )
  if (outcome === 'duplicate') {
    throw new AuthError('passkey.already_registered')
  }
  if (outcome === 'limit') {
    throw new AuthError('passkey.limit_reached')
  }
  Notices.mfaChanged(deps, scope, user, { change: 'passkey_added', at: now })
  return toPasskey(record)
}

/**
 * Rename one of the signed-in user's passkeys.
 *
 * @param deps - Passkey store, ids and clock.
 * @param scope - The project and environment.
 * @param userId - The signed-in user.
 * @param passkeyId - The passkey.
 * @param name - The new name.
 * @param actor - The user with the request's origin.
 * @returns The passkey with its new name.
 * @throws NotFoundError when the user has no such passkey.
 */
export async function rename(
  deps: Pick<Deps, 'passkeys' | 'ids' | 'clock'>,
  scope: Scope,
  userId: string,
  passkeyId: string,
  name: string,
  actor: Actor
): Promise<Passkey> {
  const renamed = await deps.passkeys.rename(
    scope.environmentId,
    userId,
    passkeyId,
    name,
    deps.clock.now(),
    Audit.entry(deps, scope, {
      type: 'user.passkey_renamed',
      actor,
      target: { type: 'user', id: userId },
      data: { passkeyId },
    })
  )
  const passkey = renamed
    ? (await deps.passkeys.listForUser(scope.environmentId, userId)).find(
        (candidate) => candidate.id === passkeyId
      )
    : undefined
  if (!passkey) {
    throw new NotFoundError()
  }
  return toPasskey(passkey)
}

/**
 * Remove one of the signed-in user's passkeys.
 *
 * Refused when it would remove their last way to sign in (`OAuth.canStillSignIn`: a password,
 * a verified address where the email code is on, a connected provider, another passkey); the
 * check runs inside the store's transaction. Works with passkeys switched off, so that a
 * user can always remove what they have. Recorded as `user.passkey_removed`, and the owner is
 * told.
 *
 * @param deps - Passkey store, users, settings, provider store, notices, ids and clock.
 * @param scope - The project and environment.
 * @param userId - The signed-in user.
 * @param passkeyId - The passkey.
 * @param actor - The user with the request's origin.
 * @throws NotFoundError when the user has no such passkey.
 * @throws AuthError `passkey.last_sign_in_method` when nothing else would let them in.
 */
export async function remove(
  deps: Pick<
    Deps,
    | 'passkeys'
    | 'users'
    | 'oauthProviders'
    | 'ids'
    | 'clock'
    | 'environmentSettings'
    | 'config'
    | 'mailer'
    | 'rateLimiter'
  >,
  scope: Scope,
  userId: string,
  passkeyId: string,
  actor: Actor
): Promise<void> {
  const settings = await Settings.current(deps, scope)
  const providers = await OAuth.enabledProviders(deps, scope)
  const outcome = await deps.passkeys.remove(
    scope.environmentId,
    userId,
    passkeyId,
    (remaining) => OAuth.canStillSignIn(settings, providers, remaining),
    Audit.entry(deps, scope, {
      type: 'user.passkey_removed',
      actor,
      target: { type: 'user', id: userId },
      data: { passkeyId, method: 'user' },
    })
  )
  if (outcome === 'not_found') {
    throw new NotFoundError()
  }
  if (outcome === 'last_method') {
    throw new AuthError('passkey.last_sign_in_method')
  }
  const user = await deps.users.findById(scope.environmentId, userId)
  if (user) {
    Notices.mfaChanged(deps, scope, user, { change: 'passkey_removed', at: deps.clock.now() })
  }
}

/** What an assertion is checked against. */
export interface AssertionInput {
  /** The browser's response. */
  credential: PasskeyAssertionCredential
  /** The challenge the server issued, already taken (used up) by the caller. */
  challenge: string
  rp: RelyingParty
  /**
   * The user the passkey must belong to, where one is already known (a second factor, a
   * step-up). Left out for a sign-in, which then requires the response's user handle.
   */
  userId?: string
  /** Who is asking, for the audit entry of a refused counter. */
  actor: Actor
}

/** A proven passkey. */
export interface Asserted {
  passkey: PasskeyRecord
  /**
   * What it adds to a session's `amr`: `hwk` for a credential bound to one device or `swk` for
   * one eligible for backup, and `user` (the authenticator verified the user).
   */
  methods: AuthenticationMethod[]
}

/**
 * Check a passkey assertion and, if it is right, record the use.
 *
 * **The one place an assertion is accepted.** Right means: the credential id is a passkey of
 * this environment (and of `userId`, where given); the response's user handle is that
 * passkey's (required when no user is given); the response is for the issued challenge, the
 * relying party's origins and the environment's relying-party id, with the user verified, and its
 * signature verifies with the stored public key; the signature counter did not go backwards;
 * and the use is recorded with a compare-and-set on the stored counter.
 *
 * A counter that went backwards means the credential was copied: the assertion is refused and
 * `user.passkey_counter_regressed` is recorded. Counters of zero (synced passkeys keep none)
 * are fine.
 *
 * Never throws for a wrong assertion, and every reason is the same `null`. Taking the
 * challenge, counting the attempt and choosing the error are the caller's job.
 *
 * @param deps - Passkey store, ids and clock.
 * @param scope - The project and environment.
 * @param input - The response and what it must match.
 * @returns The passkey and its `amr` values, or `null`.
 */
export async function assert(
  deps: Pick<Deps, 'passkeys' | 'ids' | 'clock'>,
  scope: Scope,
  input: AssertionInput
): Promise<Asserted | null> {
  const { credential, challenge, rp } = input
  const passkey = await deps.passkeys.findByCredentialId(scope.environmentId, credential.id)
  if (!passkey || (input.userId !== undefined && passkey.userId !== input.userId)) {
    return null
  }
  const handle = credential.response.userHandle
  if (handle ? handle !== passkey.userHandle : input.userId === undefined) {
    return null
  }
  const verified = await WebAuthn.verifyAssertion(credential, { challenge, ...rp }, passkey)
  if (!verified) {
    return null
  }
  const now = deps.clock.now()
  if (WebAuthn.counterRegressed(passkey.signCount, verified.signCount)) {
    logger.warn('passkey signature counter went backwards: assertion refused', {
      environmentId: scope.environmentId,
      userId: passkey.userId,
      passkeyId: passkey.id,
    })
    await deps.passkeys.reportRegression(
      scope.environmentId,
      passkey.id,
      Audit.entry(deps, scope, {
        type: 'user.passkey_counter_regressed',
        actor: input.actor,
        target: { type: 'user', id: passkey.userId },
        data: { passkeyId: passkey.id },
      })
    )
    return null
  }
  const used = await deps.passkeys.recordUse(scope.environmentId, passkey.id, {
    expectedSignCount: passkey.signCount,
    signCount: verified.signCount,
    backupEligible: verified.backupEligible,
    backedUp: verified.backedUp,
    at: now,
  })
  if (!used) {
    return null
  }
  return { passkey, methods: [verified.backupEligible ? 'swk' : 'hwk', 'user'] }
}
