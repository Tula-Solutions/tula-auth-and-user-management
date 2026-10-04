import {
  type EnvironmentSettings,
  MAX_PASSKEYS_PER_USER,
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
import type { Actor } from '~/lib/actor'
import * as logger from '~/lib/logger'
import * as WebAuthn from '~/lib/webauthn'
import * as Audit from '~/modules/audit/service'
import * as Notices from '~/modules/notice/service'
import * as OAuth from '~/modules/oauth/service'
import * as Settings from '~/modules/settings/service'
import type { PasskeyChallengePurpose, PasskeyRecord } from '~/ports/passkey-store'

type Scope = Pick<Tenant, 'projectId' | 'environmentId'>

/** Purpose of the keyed hash a user's WebAuthn handle is derived with. */
export const USER_HANDLE_PURPOSE = 'passkey-user-handle'

/** The name a passkey gets when its user gives none. */
export const DEFAULT_PASSKEY_NAME = 'Passkey'

/** Who a WebAuthn ceremony is for: the environment's relying-party id and the page's origin. */
export interface RelyingParty {
  rpId: string
  origin: string
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
 * The relying party of a WebAuthn ceremony run from a request, or a refusal.
 *
 * The origin a response is verified against is the **request's own `Origin`**, and only when
 * the environment allows that origin (`urls.allowedOrigins`) and it belongs to the environment's
 * relying-party id (the id itself or a subdomain). Nothing a client puts in a body chooses it.
 * A request with no `Origin` (not a browser) cannot use passkeys yet: native apps prove a
 * different kind of origin, which arrives with the native SDKs.
 *
 * Checked on **every** passkey step, before anything is counted, spent or stored: an attempt or
 * a challenge started before passkeys were switched off must not finish with one.
 *
 * @param deps - Settings store and config.
 * @param scope - The environment.
 * @param origin - The request's `Origin` header.
 * @returns The relying-party id and the origin to expect.
 * @throws AuthError `auth.method_disabled` when passkeys are off or no relying-party id is set,
 *   or `request.origin_not_allowed` for a missing, foreign or non-matching origin.
 */
export async function relyingParty(
  deps: Pick<Deps, 'environmentSettings' | 'config'>,
  scope: Pick<Scope, 'environmentId'>,
  origin: string | null | undefined
): Promise<RelyingParty> {
  const settings = await Settings.current(deps, scope)
  const { rpId } = settings.passkeys
  if (!available(settings) || rpId === null) {
    throw new AuthError('auth.method_disabled', { method: 'passkey' })
  }
  if (
    !origin ||
    !settings.urls.allowedOrigins.includes(origin) ||
    !originMatchesRelyingParty(origin, rpId)
  ) {
    throw new AuthError('request.origin_not_allowed')
  }
  return { rpId, origin }
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
 * finishing. Each passkey row stores the handle it was registered with.
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
 * @param origin - The request's `Origin`.
 * @returns `PublicKeyCredentialCreationOptionsJSON`.
 * @throws AuthError `auth.method_disabled`, `request.origin_not_allowed` or
 *   `passkey.limit_reached`.
 * @throws NotFoundError when the user does not exist.
 */
export async function startRegistration(
  deps: RegistrationDeps,
  scope: Scope,
  self: { userId: string; sessionId: string },
  origin: string | null | undefined
): Promise<PasskeyCreationOptions> {
  const rp = await relyingParty(deps, scope, origin)
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
      name: user.email,
      displayName: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email,
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
 * presented once whatever the outcome. The response must be for that challenge, this request's
 * origin and the environment's relying-party id, with the user verified. Recorded as
 * `user.passkey_added` in the same transaction, and the owner is told.
 *
 * @param deps - Passkey store, users, keyed hash, settings, notices, ids and clock.
 * @param scope - The project and environment.
 * @param self - The signed-in user and their session.
 * @param input - The browser's response and an optional name.
 * @param origin - The request's `Origin`.
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
  origin: string | null | undefined,
  actor: Actor
): Promise<Passkey> {
  const rp = await relyingParty(deps, scope, origin)
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
  methods: string[]
}

/**
 * Check a passkey assertion and, if it is right, record the use.
 *
 * **The one place an assertion is accepted.** Right means: the credential id is a passkey of
 * this environment (and of `userId`, where given); the response's user handle is that
 * passkey's (required when no user is given); the response is for the issued challenge, the
 * request's origin and the environment's relying-party id, with the user verified, and its
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
