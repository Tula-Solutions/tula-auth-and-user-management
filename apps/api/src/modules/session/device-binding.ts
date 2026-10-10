import type { SessionClient } from '@tula/contract'
import type { Deps, Tenant } from '~/dependencies'
import { AuthError, NonceRequiredError, RateLimitError } from '~/exceptions'
import { type Origin, systemActor } from '~/lib/actor'
import { sha256Hex, timingSafeEqual } from '~/lib/crypto'
import { canBeNamed, type ProofFailure, verifyProof } from '~/lib/dpop'
import * as logger from '~/lib/logger'
import * as Audit from '~/modules/audit/service'
import type { SessionRecord } from '~/ports/session-store'

// Device binding (ADR 0043): a session bound at sign-in to a public key, refreshed only with a
// proof signed by that key. This module is the two places a proof is asked for (the start of
// an attempt, a refresh), the server's nonce, the memory of used proofs and the record of
// refused ones. What a proof is, is `~/lib/dpop`.

/**
 * How long one nonce is handed out for: five minutes. A proof is accepted with the nonce of
 * the period under way **or of the one before**, so a nonce works for five to ten minutes
 * after a client was given it, and a client that refreshes more often than that never needs
 * a second request.
 */
export const DPOP_NONCE_PERIOD_MS = 5 * 60_000

/**
 * Refused proofs per minute for one session. Past it the answer is `rate_limited`, nothing
 * more is logged, and the session is as alive as before. Only refusals are counted: a refresh
 * that brings a valid proof is never held up by someone else's refused ones.
 */
export const PROOF_REFUSALS_PER_MINUTE = 10

/**
 * The period one audit entry stands for: the first refused proof of a minute is recorded,
 * with how many of the minute before were not. The log is append-only and anyone who holds a
 * copied refresh token can be refused as often as the limits allow, so one entry per refusal
 * would let them grow the table.
 */
export const PROOF_REFUSAL_RECORD_WINDOW_MS = 60_000

/** Keyed-hash purpose the nonces are derived under: a key of their own. */
export const NONCE_KEYED_HASH_PURPOSE = 'dpop-nonces'

/** Far above the limit: the limiter is used to count, the limit is judged here. */
const TALLY_CEILING = 1_000_000

/** What the audit entry says of a refusal: the event's closed set. */
type RefusalReason = 'missing' | 'invalid' | 'wrong_key' | 'replayed'

type Scope = Pick<Tenant, 'projectId' | 'environmentId'>

/** The request a proof came with. */
export interface ProofRequest {
  /** The `DPoP` header's value, if the request had one. */
  proof: string | undefined
  /** The request's method. */
  method: string
  /** The route's path, e.g. `/v1/client/sessions/refresh`. */
  path: string
}

type NonceDeps = Pick<Deps, 'keyedHash' | 'clock'>
type ProofDeps = NonceDeps & Pick<Deps, 'config' | 'proofReplay'>

async function nonceOf(
  deps: Pick<Deps, 'keyedHash'>,
  scope: Pick<Tenant, 'environmentId'>,
  period: number
): Promise<string> {
  return deps.keyedHash.hmac(NONCE_KEYED_HASH_PURPOSE, `${scope.environmentId}:${period}`)
}

/**
 * The server's nonce for an environment now: what a client puts in its next proof.
 *
 * Stateless. It is `HMAC(key, environment id + the number of the five-minute period)`, with a
 * key derived from `TULA_MASTER_KEY` for this purpose alone: every instance computes the same
 * value with no table and no shared store, and nobody without the key can compute the next.
 *
 * @param deps - Keyed hash and clock.
 * @param scope - The environment.
 * @returns 64 hex characters.
 */
export function nonce(deps: NonceDeps, scope: Pick<Tenant, 'environmentId'>): Promise<string> {
  return nonceOf(deps, scope, Math.floor(deps.clock.now().getTime() / DPOP_NONCE_PERIOD_MS))
}

/**
 * When a proof carrying `presented` stops being accepted: the end of the period after the one
 * its nonce was made in. `null` when the nonce is neither this period's nor the last one's.
 * Both candidates are computed and compared whichever matches.
 */
async function nonceExpiry(
  deps: NonceDeps,
  scope: Pick<Tenant, 'environmentId'>,
  presented: string | null
): Promise<Date | null> {
  const period = Math.floor(deps.clock.now().getTime() / DPOP_NONCE_PERIOD_MS)
  const [current, previous] = await Promise.all([
    nonceOf(deps, scope, period),
    nonceOf(deps, scope, period - 1),
  ])
  const isCurrent = timingSafeEqual(presented ?? '', current)
  const isPrevious = timingSafeEqual(presented ?? '', previous)
  if (!isCurrent && !isPrevious) {
    return null
  }
  return new Date((period + (isCurrent ? 2 : 1)) * DPOP_NONCE_PERIOD_MS)
}

/** Why a proof was refused: the audit entry's word, and the finer one for the log. */
interface Refusal {
  reason: RefusalReason
  detail: ProofFailure | RefusalReason
}

/**
 * Judge a proof that was presented, in a fixed order:
 *
 * 1. it is a proof for this request, signed by the key it carries (`verifyProof`);
 * 2. that key is the one `mustBe` names, where a key is already fixed (a refresh);
 * 3. its nonce is the server's, of this period or the last: otherwise the answer is the
 *    nonce challenge, **which only a proof that passed 1 and 2 ever gets**;
 * 4. its id was not used before, asked of the shared store last, so that only a proof that
 *    is otherwise good is ever remembered.
 *
 * @returns The key's thumbprint, or why the proof is refused.
 * @throws NonceRequiredError for step 3.
 * @throws ServiceUnavailableError when the store of used ids cannot answer: a proof is never
 *   accepted on a guess.
 */
async function judge(
  deps: ProofDeps,
  scope: Pick<Tenant, 'environmentId'>,
  request: ProofRequest & { proof: string },
  mustBe: string | null
): Promise<{ thumbprint: string } | Refusal> {
  const verdict = await verifyProof(request.proof, {
    method: request.method,
    url: `${deps.config.publicUrl.replace(/\/+$/, '')}${request.path}`,
    now: deps.clock.now(),
  })
  if (!verdict.ok) {
    return { reason: 'invalid', detail: verdict.reason }
  }
  const { thumbprint, jti } = verdict.proof
  if (mustBe !== null && !timingSafeEqual(thumbprint, mustBe)) {
    return { reason: 'wrong_key', detail: 'wrong_key' }
  }
  const until = await nonceExpiry(deps, scope, verdict.proof.nonce)
  if (until === null) {
    throw new NonceRequiredError(await nonce(deps, scope))
  }
  // A hash of the three, never the client's own string: the store's keys hold ids and hashes.
  const id = sha256Hex(`${scope.environmentId}:${thumbprint}:${jti}`)
  if (!(await deps.proofReplay.remember(id, until))) {
    return { reason: 'replayed', detail: 'replayed' }
  }
  return { thumbprint }
}

/**
 * Bind the session an attempt will end in, when the request that starts the attempt brings a
 * proof. Called by the routes that start an attempt, and by nothing later: the key is fixed
 * at the start, as the client kind is, and no step of the attempt adds, changes or removes it.
 *
 * - No proof: the session will not be bound (`null`). Binding is the client's choice.
 * - A proof from a browser (`web`): refused. A browser has no place to keep a key that
 *   outlives what steals its tokens, and its session may be a cookie (ADR 0043).
 * - A proof that is not valid for this request: **refused**, never read as "not bound". A
 *   client that asked for a bound session must not be given an unbound one.
 * - A valid proof without the server's nonce: the nonce challenge; the client repeats the
 *   start with it (RFC 9449 §8).
 *
 * Nothing is recorded here: there is no session yet, and the route's own per-address limit
 * bounds the calls.
 *
 * @param deps - Config, keyed hash, clock and the store of used proof ids.
 * @param scope - The environment.
 * @param request - The proof, the request it came with and the client kind.
 * @returns The key's thumbprint and a nonce for the client's next proof, or `null`.
 * @throws AuthError `device.binding_not_supported` or `device.proof_invalid`.
 * @throws NonceRequiredError `device.nonce_required`, carrying a fresh nonce.
 * @throws ServiceUnavailableError when the store of used ids cannot answer.
 */
export async function atStart(
  deps: ProofDeps,
  scope: Pick<Tenant, 'environmentId'>,
  request: ProofRequest & { client: SessionClient }
): Promise<{ thumbprint: string; nonce: string } | null> {
  const { proof } = request
  if (proof === undefined) {
    return null
  }
  if (request.client === 'web') {
    throw new AuthError('device.binding_not_supported')
  }
  if (!available(deps.config)) {
    // Not `device.proof_invalid`: nothing this client could sign would be accepted. And not
    // an unbound session: it asked for a bound one.
    throw new AuthError('device.binding_not_supported', undefined, {
      internalMessage: 'a proof at a start, where PUBLIC_URL cannot be named by one',
    })
  }
  const judged = await judge(deps, scope, { ...request, proof }, null)
  if ('reason' in judged) {
    throw new AuthError('device.proof_invalid', undefined, {
      internalMessage: `proof refused at the start of an attempt: ${judged.detail}`,
    })
  }
  return { thumbprint: judged.thumbprint, nonce: await nonce(deps, scope) }
}

/** The last `PUBLIC_URL` asked about and the answer: a deployment has one. */
let decided: { publicUrl: string; available: boolean } | undefined

/**
 * Whether this deployment can bind a session to a device key at all: whether a proof can
 * name `PUBLIC_URL` + a route's path (ADR 0043, "A `PUBLIC_URL` no proof can name").
 *
 * Decided once for a `PUBLIC_URL` and kept. The routes' own paths are plain ASCII, so what
 * holds for the refresh route's address holds for every start's. Where it is `false` a
 * start that brings a proof is `device.binding_not_supported` and no session is ever bound.
 *
 * @param config - The deployment's public URL.
 * @returns Whether a start may bind.
 */
export function available(config: Pick<Deps['config'], 'publicUrl'>): boolean {
  if (decided?.publicUrl !== config.publicUrl) {
    decided = {
      publicUrl: config.publicUrl,
      available: canBeNamed(`${config.publicUrl.replace(/\/+$/, '')}/v1/client/sessions/refresh`),
    }
  }
  return decided.available
}

/**
 * Say at boot, once, that device binding is unavailable on this deployment. Fixed words
 * that name the variable and never its value.
 *
 * It is a warning and not a refusal to start: a deployment that binds nothing loses nothing.
 *
 * @param config - The deployment's public URL.
 */
export function warnIfUnavailable(config: Pick<Deps['config'], 'publicUrl'>): void {
  if (!available(config)) {
    logger.warn(
      'PUBLIC_URL cannot be named by a device-binding proof (its path holds a character a proof may not carry): device binding is unavailable on this deployment, and a start that brings a proof is refused.'
    )
  }
}

type RefusalDeps = Pick<Deps, 'rateLimiter' | 'sessions' | 'ids' | 'clock'>

/** Count one more refusal of a session in a minute, and answer the count. */
async function tally(
  deps: Pick<Deps, 'rateLimiter'>,
  scope: Pick<Tenant, 'environmentId'>,
  sessionId: string,
  minute: number
): Promise<number> {
  // Kept for two windows, so that the next minute's first refusal can still read it.
  const decision = await deps.rateLimiter.hit(
    `refresh_proof_refused:${scope.environmentId}:${sessionId}:${minute}`,
    TALLY_CEILING,
    2 * PROOF_REFUSAL_RECORD_WINDOW_MS
  )
  return TALLY_CEILING - decision.remaining
}

/**
 * Refuse a refresh for its proof: count it, put it on record, and throw.
 *
 * **Counted per session** in the shared limiter. Past {@link PROOF_REFUSALS_PER_MINUTE} the
 * answer is `rate_limited` and nothing further is logged or recorded. A limiter that cannot
 * count answers `service.unavailable`: the refresh is refused either way, and an entry per
 * refusal with nothing counting them is the write amplifier the count exists to prevent.
 *
 * **Recorded at most once a minute per session**: the first refusal of a minute writes
 * `session.refresh_proof_refused` with its reason and how many refusals of the minute before
 * went unwritten. As for failed dashboard sign-ins (ADR 0032), that number is "at least this
 * many", reported only by a refusal in the minute right after.
 *
 * Nothing about the session changes: it is not ended, and no token of it is rotated or marked.
 */
async function refuse(
  deps: RefusalDeps,
  scope: Scope,
  session: Pick<SessionRecord, 'id' | 'userId'>,
  refusal: Refusal,
  origin: Partial<Origin>
): Promise<never> {
  const now = deps.clock.now().getTime()
  const minute = Math.floor(now / PROOF_REFUSAL_RECORD_WINDOW_MS)
  const count = await tally(deps, scope, session.id, minute)
  if (count > PROOF_REFUSALS_PER_MINUTE) {
    throw new RateLimitError((minute + 1) * PROOF_REFUSAL_RECORD_WINDOW_MS - now)
  }
  // Ids and a fixed word: nothing of the proof, the key or the token.
  logger.warn('refresh of a device-bound session refused: no valid proof of its key', {
    environmentId: scope.environmentId,
    sessionId: session.id,
    userId: session.userId,
    reason: refusal.detail,
  })
  if (count === 1) {
    // The limiter has no read: counting once more in the minute that is over answers its
    // total plus one. One of that minute's refusals was written, hence the two.
    const suppressedInPreviousMinute = Math.max(
      0,
      (await tally(deps, scope, session.id, minute - 1)) - 2
    )
    try {
      await deps.sessions.reportRefusedProof(
        scope.environmentId,
        session.id,
        Audit.entry(deps, scope, {
          type: 'session.refresh_proof_refused',
          // The system: whoever sent the request is unknown, and may not be the user. The
          // request's origin is kept, as it may be the thief's.
          actor: systemActor(origin),
          target: { type: 'session', id: session.id },
          data: { userId: session.userId, reason: refusal.reason, suppressedInPreviousMinute },
        })
      )
    } catch (cause) {
      // A refusal whose record could not be written is still a refusal: answering 5xx here
      // would tell whoever holds a copied token that the store is down, and a client that
      // it may simply try again. The tally has moved, so this minute has no entry; this
      // line is its trace. The error's name only: a store's own text can quote anything.
      logger.error(
        'refused refresh of a device-bound session could not be recorded: no audit entry for this minute',
        {
          environmentId: scope.environmentId,
          sessionId: session.id,
          error: cause instanceof Error ? cause.name : 'unknown',
        }
      )
    }
  }
  throw new AuthError('device.proof_invalid')
}

/**
 * Require, for the refresh of a session that is bound to a key, a valid proof signed by that
 * key. Called by `Sessions.refresh` and nothing else, **before anything is rotated and before
 * reuse is judged**: when this throws, the presented refresh token is as it was (not used,
 * not replaced), the session is alive, and a token that had already been rotated has revoked
 * nothing.
 *
 * @param deps - Config, keyed hash, clock, the store of used proof ids, the limiter, the
 *   session store and ids.
 * @param scope - The project and environment.
 * @param session - The bound session and the thumbprint of its key.
 * @param request - The proof and the request it came with; `undefined` for a caller that
 *   passes none, which is a missing proof.
 * @param origin - Where the request came from, recorded with a refusal.
 * @throws AuthError `device.proof_invalid`: no proof, not a valid one for this request, one
 *   signed by another key, or one that was used before.
 * @throws NonceRequiredError `device.nonce_required`: a valid proof by the right key whose
 *   nonce is missing or too old. Not counted and not recorded: it is the protocol's own step.
 * @throws RateLimitError once the session's refused proofs are over their limit.
 * @throws ServiceUnavailableError when the store of used ids, or the limiter, cannot answer.
 */
export async function atRefresh(
  deps: ProofDeps & RefusalDeps,
  scope: Scope,
  session: Pick<SessionRecord, 'id' | 'userId'> & { deviceThumbprint: string },
  request: ProofRequest | undefined,
  origin: Partial<Origin>
): Promise<void> {
  const proof = request?.proof
  if (request === undefined || proof === undefined) {
    return refuse(deps, scope, session, { reason: 'missing', detail: 'missing' }, origin)
  }
  const judged = await judge(deps, scope, { ...request, proof }, session.deviceThumbprint)
  if ('reason' in judged) {
    return refuse(deps, scope, session, judged, origin)
  }
}
