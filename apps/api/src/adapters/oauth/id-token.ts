import {
  ArcticFetchError,
  OAuth2RequestError,
  type OAuth2Tokens,
  UnexpectedErrorResponseBodyError,
  UnexpectedResponseError,
} from 'arctic'
import { createRemoteJWKSet, customFetch, errors, type JWTPayload, jwtVerify } from 'jose'
import { timingSafeEqual } from '~/lib/crypto'
import { OAuthProviderError } from '~/ports/oauth-provider'

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

/** Verifies the ID tokens of one OIDC provider. */
export type IdTokenVerifier = (
  idToken: string,
  expected: { audience: string; nonce: string }
) => Promise<JWTPayload>

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
  const keys = createRemoteJWKSet(new URL(rules.jwksUrl), {
    // `jose` aborts the key-set request with this (it hands the signal to the fetch below).
    timeoutDuration: timeoutMs,
    [customFetch]: (url, init) => globalThis.fetch(url, init),
  })
  return async (idToken, expected) => {
    let payload: JWTPayload
    try {
      // The only network call in here is the key-set fetch. The deadline is a second guard
      // around it, for a `fetch` that does not honour the abort signal.
      const verified = await withDeadline(
        jwtVerify(idToken, keys, {
          issuer: rules.issuers,
          audience: expected.audience,
          algorithms: ['RS256'],
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
          requiredClaims: ['sub', 'exp', 'iat'],
        }),
        timeoutMs
      )
      payload = verified.payload
    } catch (error) {
      if (error instanceof OAuthProviderError) {
        throw error
      }
      // A key set that did not arrive in time says nothing about the token.
      throw new OAuthProviderError(
        error instanceof errors.JWKSTimeout ? 'unavailable' : 'invalid_token'
      )
    }
    if (typeof payload.nonce !== 'string' || !timingSafeEqual(payload.nonce, expected.nonce)) {
      throw new OAuthProviderError('invalid_token')
    }
    if (typeof payload.sub !== 'string' || payload.sub === '') {
      throw new OAuthProviderError('invalid_profile')
    }
    return payload
  }
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
