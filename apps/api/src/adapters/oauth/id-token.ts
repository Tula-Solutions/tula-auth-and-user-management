import {
  ArcticFetchError,
  OAuth2RequestError,
  type OAuth2Tokens,
  UnexpectedErrorResponseBodyError,
  UnexpectedResponseError,
} from 'arctic'
import {
  createRemoteJWKSet,
  customFetch,
  errors,
  type JWTPayload,
  type JWTVerifyGetKey,
  type JWTVerifyResult,
  jwtVerify,
} from 'jose'
import { timingSafeEqual } from '~/lib/crypto'
import { type OAuthProfile, OAuthProviderError } from '~/ports/oauth-provider'

/** Longest display name kept from a provider. Longer ones are cut, never refused. */
const MAX_NAME_LENGTH = 100
/** Seconds of clock difference with a provider that an ID token's times may be off by. */
const CLOCK_TOLERANCE_SECONDS = 30

/**
 * How long any one call to a provider may take: the code exchange, a key-set fetch, a profile
 * read. A provider that accepts the connection and then says nothing must not hold a callback
 * (and the user's browser) open; ten seconds is far beyond a healthy provider's answer.
 */
export const PROVIDER_TIMEOUT_MS = 10_000

/** Options of a provider adapter. */
export interface ProviderOptions {
  /** The longest one outbound call may take, in milliseconds ({@link PROVIDER_TIMEOUT_MS}). */
  timeoutMs?: number
}

/**
 * Give a call to a provider a deadline.
 *
 * `arctic` takes neither a `fetch` nor an `AbortSignal`, so its code exchange cannot be
 * cancelled, only abandoned: the caller stops waiting and whatever arrives later is dropped
 * with the promise. Nothing of a late answer is read, logged or kept.
 *
 * @param work - The call.
 * @param timeoutMs - How long to wait for it.
 * @returns What `work` resolves to.
 * @throws OAuthProviderError `unavailable` when the deadline passes first; otherwise whatever
 *   `work` rejects with.
 */
export function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OAuthProviderError('unavailable')), timeoutMs)
  })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}

/** How one OIDC provider's ID tokens are verified. */
export interface IdTokenRules {
  /** The values `iss` may have. */
  issuers: string[]
  /** Where the provider publishes its signing keys. */
  jwksUrl: string
}

/**
 * Verifies the ID tokens of one OIDC provider.
 *
 * `handedOver` says the token came from a client (a native app, ADR 0045) and not from the
 * provider's own token endpoint: see {@link keysForHandedOverToken} for what that changes.
 */
export type IdTokenVerifier = (
  idToken: string,
  expected: { audience: string | readonly string[]; nonce: string; handedOver?: true }
) => Promise<JWTPayload>

/** A provider's published signing keys, fetched and cached by `jose`. */
export type ProviderKeySet = ReturnType<typeof createRemoteJWKSet>

/**
 * A provider's key set, fetched through the global `fetch` looked up at call time (so tests can
 * stub it and stay offline), cached, and refetched when a token names a key that is not in the
 * cache.
 *
 * @param jwksUrl - Where the provider publishes its signing keys.
 * @param timeoutMs - How long the fetch may take.
 * @returns The key set.
 */
export function remoteKeySet(jwksUrl: string, timeoutMs: number): ProviderKeySet {
  return createRemoteJWKSet(new URL(jwksUrl), {
    // `jose` aborts the key-set request with this (it hands the signal to the fetch below).
    timeoutDuration: timeoutMs,
    [customFetch]: (url, init) => globalThis.fetch(url, init),
  })
}

/**
 * A provider's key set, as it is asked for a token **a client handed over** (ADR 0045, "Keys
 * that could not be had").
 *
 * Two things differ from the key set a code exchange's token is checked against:
 *
 * - **A key set that could not be had is `unavailable`, whatever the way it failed**: no
 *   answer in time, a request that failed, a status other than 200, a body that is not a
 *   key set. None of them says anything about the token, and an honest user must not be
 *   told their sign-in was wrong because the provider's keys were down. A key set that
 *   **was** had and holds no key for the token is the token's fault and stays
 *   `invalid_token`.
 * - **A token that names no key is refused before the keys are asked for.** `jose` calls
 *   this function only for a token whose header it could read and whose `alg` is allowed,
 *   so with this a token that is malformed, has no `alg`, names an `alg` that is not
 *   allowed or names no key is refused without a request, and gets the same answer whether
 *   the keys are up or down. Nothing more is promised: `jose` reads the claims (`exp`,
 *   `aud`, `iss`) only after the key lookup and the signature, so a well-formed token that
 *   names a key and would be refused for its claims still asks for the keys, and is
 *   `unavailable` while they cannot be had.
 *
 * It does not decide by the kind of error a failed request raised: everything the key set
 * throws that is not "no key for this token" is the key set's failure.
 *
 * @param keys - The provider's key set.
 * @returns The function `jose` asks for a token's key.
 */
export function keysForHandedOverToken(keys: ProviderKeySet): JWTVerifyGetKey {
  return async (protectedHeader, token) => {
    if (typeof protectedHeader.kid !== 'string' || protectedHeader.kid === '') {
      throw new OAuthProviderError('invalid_token')
    }
    try {
      return await keys(protectedHeader, token)
    } catch (error) {
      throw new OAuthProviderError(
        error instanceof errors.JWKSNoMatchingKey ||
          error instanceof errors.JWKSMultipleMatchingKeys
          ? 'invalid_token'
          : 'unavailable'
      )
    }
  }
}

/**
 * Who judges an ID token's `iss`: {@link verifyIdToken}, against this list of the issuer's
 * spellings, or its caller.
 *
 * `'caller-verifies'` is for a provider whose issuer depends on the token itself (Microsoft's
 * is per tenant): the caller **must** check `iss` on what the verifier returns. The choice has
 * no default, so that leaving it out cannot turn the check off unnoticed.
 */
export type ExpectedIssuers = readonly string[] | 'caller-verifies'

/**
 * In place of an attempt's nonce: the provider is sent none and its ID tokens carry none.
 *
 * For a provider whose documentation names no `nonce` parameter and no `nonce` claim
 * (LinkedIn): there is nothing to compare, and asking for an undocumented echo would prove
 * nothing. Such a token is tied to the attempt only by how it was obtained (the code exchange
 * of this attempt's callback, over TLS, with the client's secret), never by its contents.
 */
export const NONCE_NOT_ECHOED: unique symbol = Symbol('nonce-not-echoed')

/**
 * What ties an ID token to the attempt: the nonce the attempt put in the authorization
 * request, or {@link NONCE_NOT_ECHOED}. The choice has no default, so that leaving it out
 * cannot turn the check off unnoticed.
 */
export type ExpectedNonce = string | typeof NONCE_NOT_ECHOED

/**
 * Verify an ID token against a key set: the signature, `RS256` only, the audience, the expiry
 * and the attempt's nonce (unless the provider echoes none: {@link ExpectedNonce}), and the
 * issuer unless the caller says it judges that itself ({@link ExpectedIssuers}).
 *
 * @param keys - The provider's key set.
 * @param idToken - The token.
 * @param expected - The client id (or, for a native app's token, the client ids: the token's
 *   `aud` must name one of them, and an empty list accepts none), the attempt's nonce and who
 *   judges the issuer. A value for
 *   `issuers` that is neither a list nor `'caller-verifies'` refuses every token, and so does
 *   a `nonce` that is neither a non-empty string nor {@link NONCE_NOT_ECHOED}.
 *   `handedOver` is for a token a client presented ({@link keysForHandedOverToken}): left
 *   out, the keys are judged as they always were for a code exchange's token.
 * @param timeoutMs - How long the key-set fetch may take.
 * @returns The verified claims and the token's protected header.
 * @throws OAuthProviderError `invalid_token`, `invalid_profile` (no `sub`) or `unavailable`
 *   (the key set did not arrive in time; for a token handed over, could not be had at all).
 */
export async function verifyIdToken(
  keys: ProviderKeySet,
  idToken: string,
  expected: {
    audience: string | readonly string[]
    nonce: ExpectedNonce
    issuers: ExpectedIssuers
    handedOver?: true
  },
  timeoutMs: number
): Promise<JWTVerifyResult> {
  const { issuers, nonce } = expected
  // `jose` takes "no audience" for "do not check": an empty list or string must refuse.
  if (expected.audience.length === 0) {
    throw new OAuthProviderError('invalid_token')
  }
  // As for `issuers` below: for a caller the compiler did not see.
  if (nonce !== NONCE_NOT_ECHOED && (typeof nonce !== 'string' || nonce === '')) {
    throw new OAuthProviderError('invalid_token')
  }
  // The type says the same; this is for a caller the compiler did not see. An empty list is
  // passed on as a list: it accepts no issuer.
  if (issuers !== 'caller-verifies' && !Array.isArray(issuers)) {
    throw new OAuthProviderError('invalid_token')
  }
  let verified: JWTVerifyResult
  try {
    // The only network call in here is the key-set fetch. The deadline is a second guard
    // around it, for a `fetch` that does not honour the abort signal.
    verified = await withDeadline(
      jwtVerify(idToken, expected.handedOver === true ? keysForHandedOverToken(keys) : keys, {
        ...(issuers !== 'caller-verifies' && { issuer: [...issuers] }),
        audience:
          typeof expected.audience === 'string' ? expected.audience : [...expected.audience],
        algorithms: ['RS256'],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ['sub', 'exp', 'iat'],
      }),
      timeoutMs
    )
  } catch (error) {
    if (error instanceof OAuthProviderError) {
      throw error
    }
    // A key set that did not arrive in time says nothing about the token. For a code
    // exchange's token that is the one failure of the keys told apart, and it stays so (a
    // test pins it; ADR 0045 says why the two paths differ). A token handed over never gets
    // here for its keys: `keysForHandedOverToken` has already said which it was.
    throw new OAuthProviderError(
      error instanceof errors.JWKSTimeout ? 'unavailable' : 'invalid_token'
    )
  }
  const { payload } = verified
  if (
    nonce !== NONCE_NOT_ECHOED &&
    (typeof payload.nonce !== 'string' || !timingSafeEqual(payload.nonce, nonce))
  ) {
    throw new OAuthProviderError('invalid_token')
  }
  if (typeof payload.sub !== 'string' || payload.sub === '') {
    throw new OAuthProviderError('invalid_profile')
  }
  return verified
}

/**
 * Judge the claims of an ID token **a native app handed over** (ADR 0045), once its
 * signature, issuer and expiry are known to be good, and read the profile from them.
 *
 * The one statement of the rule, shared by the real adapter and the mock provider:
 *
 * - `aud` is **one string** and one of the accepted client ids. A list of audiences is
 *   refused: no provider here issues one, and a token meant for several parties is not one
 *   a single check of "ours is among them" should accept.
 * - `azp`, when the token has one, is one of the accepted client ids too. The provider
 *   names there the client that asked for the token (the app), where `aud` may name the
 *   backend: a token that some other app obtained for our audience is refused.
 * - `nonce` is exactly the attempt's, compared in constant time. A missing one is refused.
 * - `sub` is there.
 *
 * `email_verified` counts only as the JSON boolean `true` here, and the nonce is compared
 * as given. Apple's tokens differ in both (a string or a boolean; the SHA-256 of the
 * attempt's nonce) and carry no name: `appleNativeIdTokenProfile` (`./apple`) holds a token
 * to this rule for the audience, `azp`, the nonce and the subject, and reads the rest its
 * own way.
 *
 * @param payload - The token's claims.
 * @param expected - The accepted client ids and the attempt's nonce.
 * @returns The profile.
 * @throws OAuthProviderError `invalid_token`, or `invalid_profile` for a token with no
 *   subject.
 */
export function nativeIdTokenProfile(
  payload: JWTPayload,
  expected: { audiences: readonly string[]; nonce: string }
): OAuthProfile {
  const { audiences, nonce } = expected
  const accepted = (value: unknown): boolean =>
    typeof value === 'string' && value !== '' && audiences.includes(value)
  if (
    !accepted(payload.aud) ||
    (payload.azp !== undefined && !accepted(payload.azp)) ||
    typeof nonce !== 'string' ||
    nonce === '' ||
    typeof payload.nonce !== 'string' ||
    !timingSafeEqual(payload.nonce, nonce)
  ) {
    throw new OAuthProviderError('invalid_token')
  }
  if (typeof payload.sub !== 'string' || payload.sub === '') {
    throw new OAuthProviderError('invalid_profile')
  }
  const email = typeof payload.email === 'string' && payload.email !== '' ? payload.email : null
  return {
    subject: payload.sub,
    email,
    emailVerified: email !== null && payload.email_verified === true,
    givenName: displayName(payload.given_name),
    familyName: displayName(payload.family_name),
  }
}

/**
 * Build the ID-token verifier of an OIDC provider (Google, Apple).
 *
 * Checks, with `jose`: the signature against the provider's published keys (fetched once and
 * cached, refetched when a token names a key that is not in the cache), `RS256` only (so an
 * unsigned token, `alg: none` or a token signed with a symmetric key is refused), the issuer,
 * the audience (this environment's client id), the expiry, and the `nonce` the attempt put into
 * the authorization request. The nonce is what ties a token to the attempt it is presented for:
 * a token minted for another sign-in, even a genuine one for the same app, is refused.
 *
 * The key set is fetched through the global `fetch` looked up at call time, so tests can stub
 * it and stay offline.
 *
 * A key set that does not arrive within the timeout is `unavailable`, not `invalid_token`.
 * For a token a client handed over (`expected.handedOver`) so is every other way the keys
 * could not be had ({@link keysForHandedOverToken}).
 *
 * @param rules - The provider's issuer and key location.
 * @param options - The timeout of the key-set fetch.
 * @returns The verifier.
 */
export function createIdTokenVerifier(
  rules: IdTokenRules,
  options: ProviderOptions = {}
): IdTokenVerifier {
  const timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS
  const keys = remoteKeySet(rules.jwksUrl, timeoutMs)
  return async (idToken, expected) =>
    (await verifyIdToken(keys, idToken, { ...expected, issuers: rules.issuers }, timeoutMs)).payload
}

/**
 * Turn whatever a code exchange through `arctic` threw into the port's error, keeping nothing
 * of the provider's response.
 *
 * @param error - What was thrown.
 * @returns The error to throw instead.
 */
export function exchangeFailure(error: unknown): OAuthProviderError {
  if (error instanceof OAuthProviderError) {
    return error
  }
  if (error instanceof OAuth2RequestError) {
    // The provider answered with an OAuth error (`invalid_grant`, `invalid_client`, …).
    return new OAuthProviderError('invalid_grant')
  }
  if (
    error instanceof ArcticFetchError ||
    error instanceof UnexpectedResponseError ||
    error instanceof UnexpectedErrorResponseBodyError
  ) {
    return new OAuthProviderError('unavailable')
  }
  return new OAuthProviderError('unavailable')
}

/**
 * Read the ID token out of a token response.
 *
 * @param tokens - What the code exchange returned.
 * @returns The ID token.
 * @throws OAuthProviderError `invalid_token` when the response has none.
 */
export function idTokenOf(tokens: OAuth2Tokens): string {
  try {
    return tokens.idToken()
  } catch {
    throw new OAuthProviderError('invalid_token')
  }
}

/**
 * A display name from a provider, made safe to keep: a string, trimmed, without control
 * characters, of bounded length. Anything else is no name.
 *
 * @param value - What the provider sent.
 * @returns The name, or `undefined`.
 */
export function displayName(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const name = value
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH)
  return name === '' ? undefined : name
}

/**
 * The email claims of an ID token. `email_verified` is a boolean in the OIDC specification, but
 * Apple sends the string `"true"`.
 *
 * @param payload - A verified ID token's claims.
 * @returns The address (or `null`) and whether the provider asserts it verified.
 */
export function emailClaims(payload: JWTPayload): { email: string | null; emailVerified: boolean } {
  const email = typeof payload.email === 'string' && payload.email !== '' ? payload.email : null
  const verified = payload.email_verified
  return { email, emailVerified: email !== null && (verified === true || verified === 'true') }
}
