import type { ChannelLike, Environment } from './environment'
import { clientError, formatMessage, isTulaError, type Messages, TulaError } from './errors'
import type { Operations, Schemas } from './generated/api.gen'
import type { TokenStorage } from './storage'
import type { CallInput, OperationId, Transport } from './transport'
import type { AuthState, ClientKind, User } from './types'

/**
 * How long before an access token expires the client stops using it and refreshes instead.
 *
 * A token has to outlive the request that carries it: the time to reach the API plus any
 * difference between clocks. Access tokens last about 60 seconds, so ten seconds leaves five
 * sixths of each token's life in use while a request sent at the last moment still arrives
 * with seconds to spare. For a shorter-lived token the skew is capped at half its lifetime, so
 * a token is never refreshed the moment it is issued.
 *
 * @example
 * ```ts
 * // A token issued for 60s is used for 50s; `getToken()` then refreshes before returning.
 * ACCESS_TOKEN_EXPIRY_SKEW_MS // 10_000
 * ```
 */
export const ACCESS_TOKEN_EXPIRY_SKEW_MS = 10_000

/**
 * How long a refresh request may take before it fails with `network.timeout`, unless the client
 * was created with a smaller `timeoutMs`.
 *
 * It is deliberately shorter than the server's refresh reuse grace period (10 seconds by
 * default, `refresh.reuseGracePeriod` in the session profile). A refresh whose response is lost
 * may already have rotated the token on the server; presenting the same token again is forgiven
 * only inside the grace period, and treated as theft (the whole session is revoked) after it.
 * Giving up after 8 seconds leaves the application time to ask again while a retry is still
 * safe. With the general 15-second timeout, every lost response would have ended the session.
 *
 * @example
 * ```ts
 * // A refresh that gets no answer fails after 8s; a getToken() made right away retries safely.
 * REFRESH_TIMEOUT_MS // 8_000
 * ```
 */
export const REFRESH_TIMEOUT_MS = 8_000

/**
 * How long, from the start of a refresh, its one automatic retry may still be running: the
 * server's default refresh reuse grace period.
 *
 * A refresh that gets no answer (a timeout or a network failure, never an HTTP answer) is sent
 * once more, at once. It is the only request the client repeats by itself, and it is safe by
 * design: if the server did rotate the token, it answers the same token re-presented inside the
 * grace period with the same next token. Leaving the retry to the application would mean a
 * slow network signs users out on every device. The retry is given what is left of this window
 * (at least one second), so the two tries together do not run far
 * past the point where a retry stops being safe.
 *
 * @example
 * ```ts
 * // First try gives up after 8s (REFRESH_TIMEOUT_MS); the retry then has the remaining 2s.
 * REFRESH_RETRY_WINDOW_MS // 10_000
 * ```
 */
export const REFRESH_RETRY_WINDOW_MS = 10_000

/** The least time the retry of a refresh is given, however long the first try took. */
const MIN_REFRESH_RETRY_TIMEOUT_MS = 1_000

/**
 * The longest a `Retry-After` on a failed refresh makes `getToken()` fail fast without asking
 * again. A proxy that answers `Retry-After: 86400` must not lock a signed-in user out of their
 * session for a day. An explicit `session.refresh()` always asks.
 *
 * @example
 * ```ts
 * MAX_REFRESH_BACKOFF_MS // 300_000 (five minutes)
 * ```
 */
export const MAX_REFRESH_BACKOFF_MS = 5 * 60_000

/**
 * The longest a refresh can run: its first try, plus the one retry a try with no answer gets.
 *
 * The retry is given what is left of {@link REFRESH_RETRY_WINDOW_MS} (at least
 * `MIN_REFRESH_RETRY_TIMEOUT_MS`, at most the refresh timeout), so the two tries together end
 * within the window when the timeout is long, and within twice the timeout when it is short.
 *
 * @param refreshTimeoutMs - The refresh request's own timeout.
 * @returns The budget in milliseconds.
 */
export function refreshBudgetMs(refreshTimeoutMs: number): number {
  return Math.min(
    2 * refreshTimeoutMs,
    Math.max(REFRESH_RETRY_WINDOW_MS, refreshTimeoutMs + MIN_REFRESH_RETRY_TIMEOUT_MS)
  )
}

/**
 * How much longer than the lock holder can need a tab waits for the cross-tab lock before it
 * goes on without it. The holder makes a refresh (up to {@link refreshBudgetMs}, since a
 * refresh may be tried twice) or one sign-out request, so it frees the lock within that time
 * unless it has stalled; waiting for ever would let one stuck tab block the rest.
 */
export const LOCK_WAIT_MARGIN_MS = 2_000

/** How many ended session ids a client remembers. Far more than a page ever signs out of. */
const MAX_ENDED_SESSIONS = 32

/** Version of the messages tabs exchange. A tab ignores a message of a version it does not know. */
const CHANNEL_VERSION = 1

type SessionTokens = Schemas['SessionTokens']

/** The access token in memory, with its expiry on this device's clock. */
interface Tokens {
  readonly accessToken: string
  readonly sessionId: string
  /** When the token expires. */
  readonly expiresAt: number
  /** When the client stops handing it out: `expiresAt` minus the skew. */
  readonly refreshAt: number
}

/** What a refresh under the lock produced. */
interface Exchange {
  /** The access token to return; `null` when nobody is signed in. */
  token: string | null
  /** Set when this refresh installed new tokens: the generation whose state is to be settled. */
  installed?: number
  /** The refresh worked but the new refresh token could not be stored. */
  failure?: TulaError
}

/** What the session manager is built from. */
export interface SessionOptions {
  /** The client kind: `web` keeps the refresh token in a cookie, the others in `storage`. */
  client: ClientKind
  /** Sends requests. */
  transport: Transport
  /** Holds the refresh token for non-`web` kinds. */
  storage: TokenStorage
  /** Clock, locks and channel. */
  environment: Environment
  /**
   * How long a tab waits for the cross-tab lock before going on without it: the longest the
   * holder can need (a request's timeout, or {@link refreshBudgetMs} if that is longer) plus
   * {@link LOCK_WAIT_MARGIN_MS}.
   */
  lockWaitMs: number
  /** The refresh request's own timeout: {@link REFRESH_TIMEOUT_MS}, or the client's if smaller. */
  refreshTimeoutMs: number
  /** Names this client's lock, channel and storage entry: one per API and environment. */
  scope: string
  /** The current locale table. */
  messages: () => Messages
}

/** Token state, refresh and sign-out: everything the client knows about the session. */
export interface SessionManager {
  /** @returns The current state. The same object until the state changes. */
  state(): AuthState
  /**
   * @param listener - Called with the new state after every change.
   * @returns A function that removes the listener.
   */
  subscribe(listener: (state: AuthState) => void): () => void
  /** @returns The state, once it is no longer `loading`. */
  load(): Promise<AuthState>
  /** @returns A usable access token, or `null` when nobody is signed in. */
  getToken(): Promise<string | null>
  /** @returns A new access token, or `null` when nobody is signed in. */
  refresh(): Promise<string | null>
  /** Ends the session here, in other tabs and on the server. */
  signOut(): Promise<void>
  /** @param issued - Tokens a completed flow returned. */
  adopt(issued: SessionTokens): Promise<void>
  /** Resolves when no refresh is in flight. */
  idle(): Promise<void>
  /** @param sessionId - A session that was just revoked; ends local state if it is this one. */
  ended(sessionId: string): Promise<void>
  /** @param user - The freshly fetched user, to show in the state. */
  setUser(user: User): void
  /**
   * Proves a factor again for the current session and installs the access token the API
   * answers with. The refresh token (or cookie) is left as it is.
   *
   * @param proof - The method and its proof.
   * @throws TulaError whatever the API refuses with, `response.invalid` for an answer that is
   *   not session tokens, `auth.unauthenticated` when the session ended meanwhile.
   */
  stepUp(proof: Schemas['StepUpRequest']): Promise<void>
  /**
   * Stops handing out the access token in memory without a refresh first: the next
   * `getToken()` asks for a new one (and falls back to this one while it is valid if that
   * cannot be made). For after a change on the server that only a new token reflects.
   */
  expire(): void
  /**
   * Calls an operation that needs the user's access token, refreshing once if the API refuses
   * the token.
   */
  authorized<Id extends OperationId>(
    id: Id,
    input: CallInput<Id>
  ): Promise<Operations[Id]['response']>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** `exp - iat` of a JWT in milliseconds, or `undefined` when the token is not a readable JWT. */
function jwtLifetimeMs(token: string): number | undefined {
  try {
    const payload = token.split('.')[1] ?? ''
    const claims: unknown = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
    if (
      isRecord(claims) &&
      typeof claims.iat === 'number' &&
      typeof claims.exp === 'number' &&
      claims.exp > claims.iat
    ) {
      return (claims.exp - claims.iat) * 1000
    }
  } catch {
    // Not a JWT this client can read: the caller falls back to the expiry sent alongside it.
  }
  return undefined
}

/**
 * How long an access token is valid, measured by the server: `exp - iat` from the token itself.
 *
 * The lifetime, not the absolute expiry, is what the client keeps, because the device's clock
 * can be minutes off. With a 60-second token, a clock two minutes fast would see every token as
 * already expired, and a slow one would keep using dead tokens.
 */
function accessTokenLifetimeMs(issued: SessionTokens, now: number): number {
  return (
    jwtLifetimeMs(issued.accessToken) ?? Math.max(0, Date.parse(issued.accessTokenExpiresAt) - now)
  )
}

/**
 * Whether a value has what the client needs from session tokens: an access token, the session
 * id and an expiry it can read. A successful answer is checked before it is installed, because
 * a 200 is not proof of talking to the API: a wrong `baseUrl` or a proxy's page answers 200 too.
 *
 * @param value - The parsed body of a refresh, or a completed flow's `session`.
 * @returns `true` when the tokens can be installed.
 */
export function isSessionTokens(value: unknown): value is SessionTokens {
  return (
    isRecord(value) &&
    typeof value.accessToken === 'string' &&
    value.accessToken !== '' &&
    typeof value.sessionId === 'string' &&
    value.sessionId !== '' &&
    (value.refreshToken === undefined || typeof value.refreshToken === 'string') &&
    (jwtLifetimeMs(value.accessToken) !== undefined ||
      (typeof value.accessTokenExpiresAt === 'string' &&
        !Number.isNaN(Date.parse(value.accessTokenExpiresAt))))
  )
}

/**
 * Whether a refused refresh means the session is over (as opposed to a problem that may pass).
 * A banned user's refresh is refused with a 403; every other ending is a `session.*` code or
 * `auth.unauthenticated` (no cookie, or no token).
 */
function sessionIsGone(error: TulaError): boolean {
  return (
    error.code.startsWith('session.') ||
    error.code === 'auth.unauthenticated' ||
    error.code === 'auth.user_banned'
  )
}

/** Whether a request ended without any answer from the API: it timed out or never connected. */
function gotNoAnswer(error: unknown): boolean {
  return isTulaError(error) && (error.code === 'network.timeout' || error.code === 'network.failed')
}

/** Whether the API refused the access token itself, which a refresh may cure. */
function tokenWasRefused(error: unknown): error is TulaError {
  return (
    isTulaError(error) &&
    error.status === 401 &&
    (error.code.startsWith('session.') || error.code === 'auth.unauthenticated')
  )
}

function ignore(): void {
  // Deliberately nothing: the caller has already handled, or does not depend on, the outcome.
}

/**
 * Build the session manager.
 *
 * The security-critical rules, all enforced here:
 * - The access token lives in memory only. For the `web` kind the refresh token is never seen:
 *   it is an httpOnly cookie. For other kinds it is held in memory and in `storage`.
 * - One refresh at a time. Calls in this client share one request; tabs take turns through a
 *   Web Lock and share the result over a `BroadcastChannel`.
 * - A refused refresh ends the session once: state becomes `signed-out`, listeners hear of it
 *   once, nothing is retried.
 * - A refresh that gets no answer at all is sent once more, at once, inside the same single
 *   flight: the only automatic retry in the client, safe because of the server's grace period.
 * - Whatever finishes after a sign-out or a new sign-in is discarded: every change of session
 *   bumps a generation, and a result from an older generation is never installed.
 * - A step-up installs its access token only when nothing else touched the session while it
 *   was in flight and no refresh is running. Otherwise the token is dropped and one refresh,
 *   made after the proof was accepted, fetches a token that reflects it.
 *
 * @param options - Transport, storage, environment and names.
 * @returns The manager.
 */
export function createSessionManager(options: SessionOptions): SessionManager {
  const { transport, storage, environment } = options
  const web = options.client === 'web'
  const storageKey = `tula.refresh.${options.scope}`
  const listeners = new Set<(state: AuthState) => void>()

  let state: AuthState = Object.freeze({ status: 'loading' })
  let tokens: Tokens | null = null
  /** Non-`web` kinds only: the refresh token, mirrored from `storage`. */
  let refreshToken: string | null = null
  /** Whether `refreshToken` reflects `storage` (read once, then kept in step). */
  let storageRead = false
  /** Bumped whenever the session changes hands: sign-in, refresh, sign-out, another tab. */
  let generation = 0
  let refreshing: Promise<string | null> | null = null
  /** After a 429 or 503 with `Retry-After`: fail fast until then instead of asking again. */
  let backoff: { until: number; error: TulaError } | null = null
  /** A refresh token issued to a refresh that lost to a sign-out, kept so sign-out can revoke it. */
  let orphan: string | null = null
  let channel: ChannelLike | undefined
  let channelOpened = false
  /**
   * Sessions this client has ended. Another tab's `session` message for one of them is stale
   * (posted by a refresh that was in flight when the session ended) and must not sign this
   * client back in. Only this client's own refresh can bring such a session back.
   */
  const endedSessions = new Set<string>()
  /** Sign-outs whose request to the server has not finished. */
  let signingOut = 0

  function setState(next: AuthState): void {
    const same =
      next.status === state.status &&
      (next.status !== 'signed-in' ||
        (state.status === 'signed-in' &&
          next.sessionId === state.sessionId &&
          next.user === state.user))
    if (same) {
      return
    }
    state = Object.freeze(next)
    for (const listener of [...listeners]) {
      try {
        listener(state)
      } catch (error) {
        // A listener's bug must not break a refresh half-way or silence the other listeners.
        // It is reported the way an uncaught error is, where the runtime can.
        const report = (globalThis as { reportError?: (error: unknown) => void }).reportError
        report?.(error)
      }
    }
  }

  function post(message: Record<string, unknown>): void {
    try {
      channel?.postMessage({ v: CHANNEL_VERSION, ...message })
    } catch {
      // Best effort: a tab that misses the message finds out on its next refresh.
    }
  }

  /** Forget the session in this client. `announce` tells the other tabs to do the same. */
  function endLocal(announce: boolean): void {
    const sessionId = tokens?.sessionId
    if (sessionId) {
      endedSessions.add(sessionId)
      if (endedSessions.size > MAX_ENDED_SESSIONS) {
        // A Set iterates in insertion order: the first entry is the oldest.
        for (const oldest of endedSessions) {
          endedSessions.delete(oldest)
          break
        }
      }
    }
    generation += 1
    tokens = null
    refreshToken = null
    storageRead = true
    backoff = null
    setState({ status: 'signed-out' })
    if (announce) {
      post({ type: 'signed-out' })
    }
  }

  async function fetchUser(accessToken: string): Promise<User | null> {
    try {
      return await transport.call('getMe', { accessToken })
    } catch {
      // The session itself is fine; the profile is fetched again by `user.get()` or by the
      // next refresh, and until then the state says `user: null`.
      return null
    }
  }

  /** Publish the state for the tokens installed at `mine`, unless the session has moved on. */
  async function settle(mine: number): Promise<void> {
    const current = tokens
    if (!current || generation !== mine) {
      return
    }
    const known =
      state.status === 'signed-in' && state.sessionId === current.sessionId ? state.user : null
    const user = known ?? (await fetchUser(current.accessToken))
    if (generation !== mine) {
      return
    }
    setState({ status: 'signed-in', sessionId: current.sessionId, user })
  }

  /** Install freshly issued tokens in memory and share the access token with other tabs. */
  function commit(issued: SessionTokens): number {
    generation += 1
    endedSessions.delete(issued.sessionId)
    const now = environment.now()
    const lifetime = accessTokenLifetimeMs(issued, now)
    tokens = {
      accessToken: issued.accessToken,
      sessionId: issued.sessionId,
      expiresAt: now + lifetime,
      refreshAt: now + lifetime - Math.min(ACCESS_TOKEN_EXPIRY_SKEW_MS, lifetime / 2),
    }
    backoff = null
    if (!web && issued.refreshToken) {
      refreshToken = issued.refreshToken
      storageRead = true
    }
    // Same origin, same device clock: the other tabs can use the token as it is and skip
    // their own refresh. The refresh token is never in this message (a `web` client has none).
    post({ type: 'session', ...tokens })
    return generation
  }

  async function persist(issued: SessionTokens): Promise<TulaError | undefined> {
    if (web || !issued.refreshToken) {
      return undefined
    }
    try {
      await storage.set(storageKey, issued.refreshToken)
      return undefined
    } catch (cause) {
      return clientError('storage.failed', options.messages(), cause)
    }
  }

  async function storedRefreshToken(): Promise<string | null> {
    if (!storageRead) {
      let value: string | null
      try {
        value = await storage.get(storageKey)
      } catch (cause) {
        throw clientError('storage.failed', options.messages(), cause)
      }
      // A sign-in may have finished while the store was being read; its token is newer.
      if (!storageRead) {
        refreshToken = value
        storageRead = true
      }
    }
    return refreshToken
  }

  function receive(data: unknown): void {
    if (!isRecord(data) || data.v !== CHANNEL_VERSION) {
      return
    }
    if (data.type === 'signed-out') {
      if (state.status !== 'signed-out') {
        endLocal(false)
      }
      return
    }
    if (
      data.type === 'session' &&
      typeof data.accessToken === 'string' &&
      typeof data.sessionId === 'string' &&
      typeof data.expiresAt === 'number' &&
      typeof data.refreshAt === 'number'
    ) {
      // A message for a session this client ended is the echo of a refresh that was in flight
      // elsewhere when it ended. And while a sign-out is still on its way to the server, no
      // message is believed: the session it names may be the one being revoked (a client that
      // never loaded does not know which session its cookie holds).
      if (signingOut > 0 || endedSessions.has(data.sessionId)) {
        return
      }
      // Tabs share one device clock, so of two tokens for one session the one that expires
      // later was received later. An older one, announced late, must not replace it: it could
      // undo a step-up, whose token says more than a refresh issued before the proof.
      if (tokens?.sessionId === data.sessionId && data.expiresAt < tokens.expiresAt) {
        return
      }
      generation += 1
      tokens = {
        accessToken: data.accessToken,
        sessionId: data.sessionId,
        expiresAt: data.expiresAt,
        refreshAt: data.refreshAt,
      }
      backoff = null
      void settle(generation)
    }
  }

  /** Open the channel to other tabs on first use, so that creating a client has no side effects. */
  function openChannel(): void {
    if (channelOpened || !web) {
      return
    }
    channelOpened = true
    try {
      channel = environment.createChannel?.(`tula:${options.scope}`)
    } catch {
      // No channel (a sandboxed frame, for one): the client works without it.
      channel = undefined
    }
    if (channel) {
      channel.onmessage = (event) => receive(event.data)
    }
  }

  /**
   * Run `task` while holding the lock every tab of this origin shares, so that two tabs never
   * present the same refresh cookie at once. Without Web Locks, or if the lock cannot be had in
   * time, the task runs anyway: the server's reuse grace period forgives two tabs presenting
   * the same token within a few seconds.
   */
  async function withLock<T>(task: () => Promise<T>): Promise<T> {
    const locks = web ? environment.locks : undefined
    if (!locks) {
      return task()
    }
    const waiting = new AbortController()
    const timer = setTimeout(() => waiting.abort(), options.lockWaitMs)
    let entered = false
    try {
      return await locks.request(`tula:${options.scope}`, { signal: waiting.signal }, () => {
        entered = true
        clearTimeout(timer)
        return task()
      })
    } catch (error) {
      if (entered) {
        throw error
      }
      return task()
    } finally {
      clearTimeout(timer)
    }
  }

  async function exchange(started: number): Promise<Exchange> {
    const current = (): Exchange => ({ token: tokens?.accessToken ?? null })
    // While this tab waited for the lock, another tab may have refreshed and shared the
    // result, or the user may have signed out or in. Whatever is current now is the answer.
    if (generation !== started) {
      return current()
    }
    let presented: string | null = null
    if (!web) {
      presented = await storedRefreshToken()
      if (generation !== started) {
        return current()
      }
      if (!presented) {
        endLocal(false)
        return { token: null }
      }
    }
    const body = presented ? { refreshToken: presented } : {}
    const sentAt = environment.now()
    let issued: SessionTokens
    try {
      try {
        issued = await transport.call('refreshSession', {
          body,
          timeoutMs: options.refreshTimeoutMs,
        })
      } catch (error) {
        if (!gotNoAnswer(error) || generation !== started) {
          throw error
        }
        // The one automatic retry (see REFRESH_RETRY_WINDOW_MS): no answer came, so the server
        // may or may not have rotated the token. Presenting the same token again at once is
        // answered with the same next token if it did, and is an ordinary refresh if it did not.
        const left = REFRESH_RETRY_WINDOW_MS - (environment.now() - sentAt)
        issued = await transport.call('refreshSession', {
          body,
          timeoutMs: Math.min(
            options.refreshTimeoutMs,
            Math.max(MIN_REFRESH_RETRY_TIMEOUT_MS, left)
          ),
        })
      }
    } catch (error) {
      if (generation !== started) {
        return current()
      }
      if (isTulaError(error) && sessionIsGone(error)) {
        // Not announced to other tabs: a tab with no cookie yet can get this answer while
        // another tab is completing a sign-in, and must not sign that tab out. Each tab finds
        // out from its own refresh.
        endLocal(false)
        if (!web) {
          await storage.remove(storageKey).catch(ignore)
        }
        return { token: null }
      }
      if (isTulaError(error) && error.retryAfterMs !== undefined) {
        const wait = Math.min(error.retryAfterMs, MAX_REFRESH_BACKOFF_MS)
        backoff = { until: environment.now() + wait, error }
      }
      throw error
    }
    if (!isSessionTokens(issued)) {
      // A 200 that is not session tokens (a wrong base URL, a proxy's page). Nothing is
      // installed, stored or announced, and the session this client has is left alone.
      throw clientError('response.invalid', options.messages())
    }
    if (generation !== started) {
      // Signed out (or signed in as someone else) while the request was in flight. The tokens
      // are not installed; the refresh token is kept only so that sign-out can revoke it.
      if (!web && issued.refreshToken) {
        orphan = issued.refreshToken
      }
      return current()
    }
    const installed = commit(issued)
    return { token: issued.accessToken, installed, failure: await persist(issued) }
  }

  async function runRefresh(explicit: boolean): Promise<string | null> {
    // An explicit `refresh()` is the application (or the user) asking now: it always asks,
    // and gets the fresh answer. Only the implicit refreshes wait out a `Retry-After`.
    if (!explicit && backoff && environment.now() < backoff.until) {
      throw backoff.error
    }
    openChannel()
    const started = generation
    const result = await withLock(() => exchange(started))
    if (result.installed !== undefined) {
      await settle(result.installed)
    }
    if (result.failure) {
      throw result.failure
    }
    return result.token
  }

  function refresh(explicit = false): Promise<string | null> {
    if (!refreshing) {
      const run = runRefresh(explicit)
      refreshing = run
      const clear = () => {
        if (refreshing === run) {
          refreshing = null
        }
      }
      run.then(clear, clear)
    }
    return refreshing
  }

  async function getToken(): Promise<string | null> {
    if (state.status === 'signed-out') {
      return null
    }
    if (tokens && environment.now() < tokens.refreshAt) {
      return tokens.accessToken
    }
    try {
      return await refresh()
    } catch (error) {
      // The refresh could not be made (offline, rate limited). A token inside its skew is
      // still valid for a few seconds: better to use it than to fail a request that would work.
      if (tokens && environment.now() < tokens.expiresAt) {
        return tokens.accessToken
      }
      throw error
    }
  }

  async function load(): Promise<AuthState> {
    if (state.status === 'loading') {
      await refresh()
    }
    return state
  }

  async function adopt(issued: SessionTokens): Promise<void> {
    if (!isSessionTokens(issued)) {
      throw clientError('response.invalid', options.messages())
    }
    openChannel()
    const installed = commit(issued)
    const failure = await persist(issued)
    await settle(installed)
    if (failure) {
      throw failure
    }
  }

  async function signOut(): Promise<void> {
    signingOut += 1
    try {
      await endEverywhere()
    } finally {
      signingOut -= 1
    }
  }

  async function endEverywhere(): Promise<void> {
    openChannel()
    const pending = refreshing
    const unread = !web && !storageRead
    let presented = refreshToken
    let failure: unknown
    orphan = null
    // Local state first, so the app is signed out whatever the network does next.
    endLocal(true)
    const mine = generation
    // A refresh already in flight may be rotating the token (or the cookie) right now. Wait
    // for it, then end the session with whatever is newest, so nothing outlives the sign-out.
    await pending?.catch(ignore)
    if (!web) {
      try {
        if (unread) {
          presented = await storage.get(storageKey)
        }
        // After the refresh has settled, so a token it was storing does not reappear. A
        // sign-in that finished meanwhile has stored its own token; that one stays.
        if (generation === mine) {
          await storage.remove(storageKey)
        }
      } catch (cause) {
        failure = clientError('storage.failed', options.messages(), cause)
      }
    }
    const newest = orphan ?? presented
    orphan = null
    if (web || newest) {
      try {
        await withLock(() =>
          transport.call('signOut', { body: newest ? { refreshToken: newest } : {} })
        )
      } catch (error) {
        // The server may still hold the session (and a browser its cookie): the caller must
        // know, even though this client is signed out.
        failure = error
      }
    }
    if (failure) {
      throw failure
    }
  }

  async function ended(sessionId: string): Promise<void> {
    if (tokens?.sessionId !== sessionId) {
      return
    }
    endLocal(true)
    if (!web) {
      await storage.remove(storageKey).catch(ignore)
    }
  }

  function unauthenticated(): TulaError {
    return new TulaError({
      code: 'auth.unauthenticated',
      message: formatMessage('auth.unauthenticated', { messages: options.messages() }),
      status: 401,
    })
  }

  /**
   * Send an operation with the user's access token, refreshing once if the API refuses the
   * token. `sent` is the session generation the answered request was sent under, for a caller
   * that installs something from the answer.
   */
  async function send<Id extends OperationId>(
    id: Id,
    input: CallInput<Id>
  ): Promise<{ answer: Operations[Id]['response']; sent: number }> {
    const accessToken = await getToken()
    if (!accessToken) {
      throw unauthenticated()
    }
    let sent = generation
    try {
      return { answer: await transport.call(id, { ...input, accessToken }), sent }
    } catch (error) {
      if (!tokenWasRefused(error)) {
        throw error
      }
      // The API refused a token this client thought was good (it expired on the way, or the
      // session was revoked). One refresh, one retry; a second refusal goes to the caller.
      // Unless the client was signed out while the call was in flight: then the refusal is
      // simply true, and refreshing (a browser would send its cookie) could sign it back in.
      if (state.status === 'signed-out') {
        throw error
      }
      const replaced = tokens && tokens.accessToken !== accessToken ? tokens.accessToken : null
      const next = replaced ?? (await refresh())
      if (!next) {
        throw error
      }
      sent = generation
      return { answer: await transport.call(id, { ...input, accessToken: next }), sent }
    }
  }

  async function authorized<Id extends OperationId>(
    id: Id,
    input: CallInput<Id>
  ): Promise<Operations[Id]['response']> {
    return (await send(id, input)).answer
  }

  async function stepUp(proof: Schemas['StepUpRequest']): Promise<void> {
    openChannel()
    // A refresh already in flight would otherwise hand the proof a token about to be replaced.
    await refreshing?.catch(ignore)
    const { answer, sent } = await send('stepUpSession', { body: proof })
    if (!isSessionTokens(answer)) {
      throw clientError('response.invalid', options.messages())
    }
    // Signed out, or signed in as someone else, while the proof was in flight: the answer is
    // about a session this client no longer has. A step-up never changes whose session it is.
    if (state.status === 'signed-out' || tokens?.sessionId !== answer.sessionId) {
      throw unauthenticated()
    }
    if (generation === sent && !refreshing) {
      // Only the access token: a step-up does not rotate the refresh token, and one that a
      // misbehaving server put in the answer must not replace the real one.
      await settle(
        commit({
          sessionId: answer.sessionId,
          accessToken: answer.accessToken,
          accessTokenExpiresAt: answer.accessTokenExpiresAt,
        })
      )
      return
    }
    // The session's token was replaced while the proof was in flight (a refresh here or in
    // another tab), or a refresh is running now. That token may have been issued before the
    // proof was accepted, and installing this one over it would be installing a result for an
    // older generation (and, with a refresh in flight, would make that refresh discard the
    // refresh token it is about to receive). So neither is trusted: one refresh, started now,
    // is certainly issued after the proof and carries it.
    await refreshing?.catch(ignore)
    // Asked again after the wait: a client that was signed out meanwhile must not refresh (a
    // browser would send its cookie, and could sign itself back in).
    if (tokens?.sessionId !== answer.sessionId || !(await refresh(true))) {
      throw unauthenticated()
    }
  }

  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    load,
    getToken,
    refresh: () => refresh(true),
    signOut,
    adopt,
    async idle() {
      await refreshing?.catch(ignore)
    },
    ended,
    setUser(user) {
      if (state.status === 'signed-in') {
        setState({ ...state, user })
      }
    },
    authorized,
    stepUp,
    expire() {
      if (tokens) {
        tokens = { ...tokens, refreshAt: 0 }
      }
    },
  }
}
