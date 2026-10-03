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
 * How much longer than one request's timeout a tab waits for the cross-tab lock before it goes
 * on without it. The tab holding the lock makes one request, so it frees the lock within the
 * timeout unless it has stalled; waiting for ever would let one stuck tab block the rest.
 */
export const LOCK_WAIT_MARGIN_MS = 2_000

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
   * How long a tab waits for the cross-tab lock before going on without it: one request's
   * timeout plus {@link LOCK_WAIT_MARGIN_MS}.
   */
  lockWaitMs: number
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

/**
 * How long an access token is valid, measured by the server: `exp - iat` from the token itself.
 *
 * The lifetime, not the absolute expiry, is what the client keeps, because the device's clock
 * can be minutes off. With a 60-second token, a clock two minutes fast would see every token as
 * already expired, and a slow one would keep using dead tokens.
 */
function accessTokenLifetimeMs(issued: SessionTokens, now: number): number {
  try {
    const payload = issued.accessToken.split('.')[1] ?? ''
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
    // Not a JWT this client can read: fall back to the expiry the server sent alongside it.
  }
  const untilExpiry = Date.parse(issued.accessTokenExpiresAt) - now
  return Number.isNaN(untilExpiry) ? 0 : Math.max(0, untilExpiry)
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
 * - Whatever finishes after a sign-out or a new sign-in is discarded: every change of session
 *   bumps a generation, and a result from an older generation is never installed.
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
    let issued: SessionTokens
    try {
      issued = await transport.call('refreshSession', {
        body: presented ? { refreshToken: presented } : {},
      })
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
        backoff = { until: environment.now() + error.retryAfterMs, error }
      }
      throw error
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

  async function runRefresh(): Promise<string | null> {
    if (backoff && environment.now() < backoff.until) {
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

  function refresh(): Promise<string | null> {
    if (!refreshing) {
      const run = runRefresh()
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
    openChannel()
    const installed = commit(issued)
    const failure = await persist(issued)
    await settle(installed)
    if (failure) {
      throw failure
    }
  }

  async function signOut(): Promise<void> {
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

  async function authorized<Id extends OperationId>(
    id: Id,
    input: CallInput<Id>
  ): Promise<Operations[Id]['response']> {
    const accessToken = await getToken()
    if (!accessToken) {
      throw unauthenticated()
    }
    try {
      return await transport.call(id, { ...input, accessToken })
    } catch (error) {
      if (!tokenWasRefused(error)) {
        throw error
      }
      // The API refused a token this client thought was good (it expired on the way, or the
      // session was revoked). One refresh, one retry; a second refusal goes to the caller.
      const replaced = tokens && tokens.accessToken !== accessToken ? tokens.accessToken : null
      const next = replaced ?? (await refresh())
      if (!next) {
        throw error
      }
      return transport.call(id, { ...input, accessToken: next })
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
    refresh,
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
  }
}
