import { type Environment, runtimeEnvironment } from './environment'
import type { Messages } from './errors'
import {
  type PasswordResetFlow,
  passwordResetFlow,
  type SignInFlow,
  type SignUpFlow,
  signInFlow,
  signUpFlow,
} from './flows'
import {
  createSessionManager,
  LOCK_WAIT_MARGIN_MS,
  REFRESH_TIMEOUT_MS,
  refreshBudgetMs,
} from './session'
import { memoryStorage, type TokenStorage } from './storage'
import { createTransport } from './transport'
import type { AuthState, ClientConfig, ClientKind, FetchLike, Session, User } from './types'

/**
 * How long one request may take before it fails with `network.timeout`, unless the client is
 * created with its own `timeoutMs`.
 *
 * @example
 * ```ts
 * createTulaClient({ publishableKey, baseUrl, timeoutMs: DEFAULT_TIMEOUT_MS * 2 })
 * ```
 */
export const DEFAULT_TIMEOUT_MS = 15_000

// The contract's `PUBLISHABLE_KEY_PREFIX` and `SECRET_KEY_PREFIX`. They are repeated here
// because the contract module that defines them also defines Zod schemas, which this package
// keeps out of an application's bundle; a test holds the two pairs equal.
const PUBLISHABLE_KEY_PREFIX = 'tula_pk_'
const SECRET_KEY_PREFIX = 'tula_sk_'

/**
 * Options of {@link createTulaClient}.
 *
 * @example
 * ```ts
 * const options: TulaClientOptions = {
 *   publishableKey: 'tula_pk_dev_…',
 *   baseUrl: 'https://auth.example.com',
 * }
 * ```
 */
export interface TulaClientOptions {
  /** The environment's publishable key (`tula_pk_<env>_…`). Safe to embed in an app. */
  publishableKey: string
  /** Where the Tula API is served, e.g. `https://auth.example.com`. */
  baseUrl: string
  /**
   * The kind of client, which decides where the refresh token lives. `web` (the default in a
   * browser): an httpOnly cookie set by the API, which this SDK never sees. `ios`, `android`,
   * `server` (the default elsewhere): the `storage` adapter.
   */
  client?: ClientKind
  /**
   * Where a non-`web` client keeps its refresh token. Defaults to {@link memoryStorage}. Not
   * allowed for `web`, whose refresh token is not available to JavaScript at all.
   */
  storage?: TokenStorage
  /** The `fetch` to use. Defaults to the global one. */
  fetch?: FetchLike
  /** Called after every change of {@link AuthState}; the same as a first `onChange` listener. */
  onSessionChange?: (state: AuthState) => void
  /** Messages by error code, for a language other than English. See {@link Messages}. */
  messages?: Messages
  /**
   * How long one request may take, in milliseconds. Defaults to {@link DEFAULT_TIMEOUT_MS}.
   * A refresh never waits longer than `REFRESH_TIMEOUT_MS` (8 seconds), whatever this says: it
   * has to give up while a retry is still inside the server's reuse grace period.
   */
  timeoutMs?: number
}

/**
 * The headless Tula client. See {@link createTulaClient}.
 *
 * @example
 * ```ts
 * const tula: TulaClient = createTulaClient({ publishableKey, baseUrl })
 * ```
 */
export interface TulaClient {
  /**
   * The current authentication state. The same object until the state changes, so it works as
   * a snapshot for `useSyncExternalStore` and the like.
   */
  readonly state: AuthState
  /**
   * Listen for changes of {@link AuthState}. A token refresh alone is not a change.
   *
   * @param listener - Called with the new state.
   * @returns A function that removes the listener.
   */
  onChange(listener: (state: AuthState) => void): () => void
  /**
   * Find out whether someone is signed in: restores the session from the browser's cookie (or
   * the storage adapter) and fetches the user. Creating a client does nothing on its own, so
   * call this once when the app starts.
   *
   * @returns The state, `signed-in` or `signed-out`.
   * @throws TulaError when the API cannot be reached; the state stays `loading`.
   */
  load(): Promise<AuthState>
  /**
   * Switch the language of error messages.
   *
   * @param messages - Messages by error code; codes left out stay English.
   */
  setMessages(messages: Messages): void
  /** Sign-up with email and password. */
  readonly signUp: {
    /**
     * Start a sign-up: checks the email and password and emails a 6-digit code. The answer is
     * the same whether or not the address already has an account.
     *
     * @param input - The new account's email, password and optional name.
     * @returns The flow, waiting on `needs_email_verification`.
     * @throws TulaError with the code of the first problem (`email.invalid`,
     *   `password.too_short`, …) and one field error per problem in `errors`.
     */
    start(input: {
      email: string
      password: string
      firstName?: string
      lastName?: string
    }): Promise<SignUpFlow>
  }
  /** Sign-in. */
  readonly signIn: {
    /**
     * Start a sign-in. The answer depends only on the environment's settings, never on the
     * identifier: `needs_password`, or `needs_first_factor` with the enabled strategies.
     *
     * @param input - The user's email address.
     * @returns The flow.
     */
    start(input: { identifier: string }): Promise<SignInFlow>
  }
  /** Forgotten password. */
  readonly resetPassword: {
    /**
     * Start a password reset: emails a 6-digit code. The answer is the same whether or not the
     * address has an account.
     *
     * @param input - The account's email address.
     * @returns The flow, waiting on `needs_new_password`.
     */
    start(input: { email: string }): Promise<PasswordResetFlow>
  }
  /** The current session and the user's other devices. */
  readonly session: {
    /**
     * An access token to send to your own backend, refreshed first when it is missing or about
     * to expire. Any number of concurrent calls share one refresh.
     *
     * @returns The token, or `null` when nobody is signed in.
     * @throws TulaError when a needed refresh could not be made (offline, rate limited). The
     *   session is kept; call again later.
     */
    getToken(): Promise<string | null>
    /**
     * Refresh now, whatever the current token's age, and even when an earlier refresh was told
     * to wait (`Retry-After`): an explicit call always asks.
     *
     * @returns The new access token, or `null` when nobody is signed in.
     * @throws TulaError when the refresh could not be made, or `response.invalid` when the
     *   answer was not session tokens (the session is left as it was).
     */
    refresh(): Promise<string | null>
    /**
     * Sign out: forgets the session in this client and tells the app's other tabs at once,
     * then ends it on the server.
     *
     * @throws TulaError when the server could not be told (the client is signed out all the
     *   same, but the session may live on until it is revoked or expires).
     */
    signOut(): Promise<void>
    /** @returns The user's active sessions, most recently active first. */
    list(): Promise<Session[]>
    /**
     * Sign out one of the user's devices. Revoking the current session signs this client out.
     *
     * @param sessionId - The session to end.
     * @throws TulaError `resource.not_found` for a session that is not the user's.
     */
    revoke(sessionId: string): Promise<void>
    /** @returns How many other sessions were ended. This one stays signed in. */
    revokeOthers(): Promise<number>
  }
  /** The signed-in user. */
  readonly user: {
    /**
     * Fetch the signed-in user and update the state with it.
     *
     * @returns The user.
     * @throws TulaError `auth.unauthenticated` when nobody is signed in.
     */
    get(): Promise<User>
    /**
     * Change the user's password. Ends their other sessions; this one stays signed in.
     *
     * @param input - The current and the new password.
     * @throws TulaError `auth.invalid_credentials` for a wrong current password, a `password.*`
     *   code with field errors for a new one the policy rejects, `password.not_set` for an
     *   account without a password.
     */
    changePassword(input: { currentPassword: string; newPassword: string }): Promise<void>
  }
  /** The environment's public configuration. */
  readonly config: {
    /**
     * The app's name, the enabled sign-in methods and the password policy. Fetched once and
     * kept; pass `force` to fetch it again.
     *
     * @param options - `force`: ignore the cached answer.
     * @returns The configuration.
     */
    get(options?: { force?: boolean }): Promise<ClientConfig>
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new TypeError('createTulaClient: `baseUrl` must be an absolute URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError('createTulaClient: `baseUrl` must be an http(s) URL')
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

function defaultClientKind(): ClientKind {
  return (globalThis as { document?: unknown }).document === undefined ? 'server' : 'web'
}

/**
 * Build a client with an explicit environment (clock, locks, channel). Tests use this to pass
 * fakes; applications use {@link createTulaClient}.
 *
 * @param options - The client's options.
 * @param environment - What the client takes from the runtime.
 * @returns The client.
 * @throws TypeError for options that can never work.
 */
export function createClient(options: TulaClientOptions, environment: Environment): TulaClient {
  const { publishableKey } = options
  if (typeof publishableKey !== 'string' || !publishableKey.startsWith(PUBLISHABLE_KEY_PREFIX)) {
    throw new TypeError(
      typeof publishableKey === 'string' && publishableKey.startsWith(SECRET_KEY_PREFIX)
        ? 'createTulaClient: this is a secret key. Never put one in a client; use the publishable key'
        : 'createTulaClient: `publishableKey` must be a publishable key (tula_pk_…)'
    )
  }
  const baseUrl = normalizeBaseUrl(options.baseUrl)
  const client = options.client ?? defaultClientKind()
  if (client === 'web' && options.storage) {
    throw new TypeError(
      'createTulaClient: a `web` client keeps its refresh token in an httpOnly cookie and takes no `storage`'
    )
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('createTulaClient: `timeoutMs` must be a positive number')
  }
  const refreshTimeoutMs = Math.min(timeoutMs, REFRESH_TIMEOUT_MS)
  const send = options.fetch ?? ((request: Request) => globalThis.fetch(request))

  let messages: Messages = options.messages ?? {}
  const currentMessages = () => messages

  const transport = createTransport({
    baseUrl,
    publishableKey,
    client,
    fetch: send,
    timeoutMs,
    messages: currentMessages,
  })
  const session = createSessionManager({
    client,
    transport,
    storage: options.storage ?? memoryStorage(),
    environment,
    // The lock is held for a refresh (which may be tried twice) or for one sign-out request.
    // A waiter that gave up sooner than the holder can take would refresh alongside it.
    lockWaitMs: Math.max(timeoutMs, refreshBudgetMs(refreshTimeoutMs)) + LOCK_WAIT_MARGIN_MS,
    refreshTimeoutMs,
    // One lock, channel and storage entry per API and environment, so two apps (or two
    // environments) on one origin do not share a session.
    scope: `${baseUrl}|${publishableKey}`,
    messages: currentMessages,
  })
  if (options.onSessionChange) {
    session.subscribe(options.onSessionChange)
  }
  const flows = { transport, session, messages: currentMessages }
  let config: Promise<ClientConfig> | null = null

  return {
    get state() {
      return session.state()
    },
    onChange: (listener) => session.subscribe(listener),
    load: () => session.load(),
    setMessages(next) {
      messages = next
    },
    signUp: {
      start: async (input) =>
        signUpFlow(flows, await transport.call('startSignUp', { body: input })),
    },
    signIn: {
      start: async (input) =>
        signInFlow(flows, await transport.call('startSignIn', { body: input })),
    },
    resetPassword: {
      start: async (input) =>
        passwordResetFlow(flows, await transport.call('startPasswordReset', { body: input })),
    },
    session: {
      getToken: () => session.getToken(),
      refresh: () => session.refresh(),
      signOut: () => session.signOut(),
      list: async () => (await session.authorized('listSessions', {})).data,
      async revoke(sessionId) {
        await session.authorized('revokeSession', { params: { sessionId } })
        await session.ended(sessionId)
      },
      revokeOthers: async () => (await session.authorized('revokeOtherSessions', {})).revoked,
    },
    user: {
      async get() {
        const user = await session.authorized('getMe', {})
        session.setUser(user)
        return user
      },
      async changePassword(input) {
        await session.authorized('changeMyPassword', { body: input })
      },
    },
    config: {
      get(request = {}) {
        if (!config || request.force) {
          const pending = transport.call('getClientConfig', {})
          config = pending
          // A failed fetch is not kept: the next call asks again.
          pending.catch(() => {
            if (config === pending) {
              config = null
            }
          })
        }
        return config
      },
    },
  }
}

/**
 * Create the headless Tula client: flows, the session and its tokens, for browsers, Node, Bun
 * and edge runtimes.
 *
 * Creating a client sends nothing. Call `load()` once when the app starts to restore the
 * session; drive sign-up, sign-in and password reset through the flow objects, drawing one
 * screen per `step.status`; and call `session.getToken()` whenever your own backend needs an
 * access token.
 *
 * @param options - The publishable key, the API's URL, and optionally the client kind, a
 *   storage adapter, a `fetch`, a listener, a locale table and a timeout.
 * @returns The client.
 * @throws TypeError for options that can never work (a secret key, a relative URL, `storage`
 *   with the `web` kind).
 *
 * @example
 * ```ts
 * import { createTulaClient, isTulaError } from '@tula/core'
 *
 * const tula = createTulaClient({
 *   publishableKey: 'tula_pk_dev_…',
 *   baseUrl: 'https://auth.example.com',
 *   onSessionChange: (state) => render(state),
 * })
 * await tula.load()
 *
 * const flow = await tula.signIn.start({ identifier: 'maya@northline.app' })
 * try {
 *   const step = await flow.submitPassword({ password })
 *   if (step.status === 'complete') {
 *     const token = await tula.session.getToken()
 *   }
 * } catch (error) {
 *   if (isTulaError(error)) {
 *     show(error.code, error.message)
 *   }
 * }
 * ```
 */
export function createTulaClient(options: TulaClientOptions): TulaClient {
  return createClient(options, runtimeEnvironment())
}
