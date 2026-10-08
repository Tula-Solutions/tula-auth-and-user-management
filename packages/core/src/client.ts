import { createLinkStore, type EmailLinkOutcome, handleEmailLink } from './email-link'
import { type Environment, runtimeEnvironment } from './environment'
import { clientError, type Messages } from './errors'
import {
  type PasswordResetFlow,
  passkeySignIn,
  passwordResetFlow,
  type SignInFlow,
  type SignUpFlow,
  signInFlow,
  signUpFlow,
} from './flows'
import { isBackupCodes, isFactors, isPhoneCodeSent, isStepUpPrepared, isTotpEnrolment } from './mfa'
import {
  createOAuthStore,
  createOAuthTicketHolder,
  discardOAuthCallback,
  handleOAuthCallback,
  type Identity,
  isIdentityList,
  type OAuthCallbackOutcome,
  type OAuthProvider,
  startOAuth,
} from './oauth'
import {
  browserAuthenticator,
  isCreationOptions,
  isPasskeyAnswer,
  isPasskeyList,
  isRequestOptions,
  type PasskeyAuthenticator,
  type PasskeyRequest,
  toPasskey,
} from './passkey'
import {
  createSessionManager,
  LOCK_WAIT_MARGIN_MS,
  REFRESH_TIMEOUT_MS,
  refreshBudgetMs,
} from './session'
import { memoryStorage, type TokenStorage } from './storage'
import { createTransport } from './transport'
import type {
  AuthState,
  BackupCodes,
  ClientConfig,
  ClientKind,
  Factors,
  FetchLike,
  Passkey,
  PhoneCodeSent,
  Session,
  StepUpPrepared,
  StepUpProof,
  TotpEnrolment,
  User,
} from './types'

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
  /**
   * The session profile to ask for, by name (ADR 0028). The session gets it only where the
   * environment marks that profile `clientSelectable`; any other name is ignored by the API
   * and the session gets the profile of its client kind (`web`, or `mobile` for the others).
   * Leave it out to take that default. A name is lowercase letters, digits and single hyphens,
   * at most 32 characters.
   *
   * @example
   * ```ts
   * const admin = createTulaClient({ publishableKey, baseUrl, sessionProfile: 'back-office' })
   * ```
   */
  sessionProfile?: string
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

// The shape of a session profile's name (`SessionProfileNameSchema` in the contract, which this
// package cannot import: it is a Zod schema).
const SESSION_PROFILE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

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
   * What a server rendered for this client, when a framework integration knows it
   * (`@tula/nextjs` sets it from the request's session). `@tula/react` uses it as the state
   * during server rendering and hydration instead of `loading`. `createTulaClient` never sets
   * it.
   */
  readonly serverState?: AuthState
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
  /** Sign-up with email and, unless the environment makes it optional, a password. */
  readonly signUp: {
    /**
     * Start a sign-up: checks the email and password and emails a 6-digit code. The answer is
     * the same whether or not the address already has an account.
     *
     * `password` may be left out only where the environment's configuration says
     * `signUp.password: 'optional'` (see `config.get()`): the account then has no password and
     * signs in with an emailed code or link.
     *
     * @param input - The new account's email, password and optional name.
     * @returns The flow, waiting on `needs_email_verification`.
     * @throws TulaError with the code of the first problem (`email.invalid`,
     *   `password.too_short`, …) and one field error per problem in `errors`.
     */
    start(input: {
      email: string
      password?: string
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
    /**
     * Whether an emailed sign-in link can be used in this browser: it needs storage shared by
     * the browser's tabs (`localStorage`). Where it cannot, offer the emailed code only.
     *
     * @returns `false` outside a browser, and where storage is missing or refuses writes.
     */
    canUseEmailLink(): boolean
    /**
     * Handle the emailed sign-in link in the page's address, if there is one. Call it once on
     * the page your links lead to (the `redirectUrl` given to `prepareFirstFactor`).
     *
     * The link's token is read from the URL fragment and removed from the address bar before
     * anything is sent. Opening a link never signs this tab in by itself: the tab that started
     * the sign-in finishes it, and this tab then shares its session. A link opened in another
     * browser or on another device is refused without being used up.
     *
     * Calls made while one is in flight share its result, so calling it from an effect that
     * runs twice is safe.
     *
     * @param options - `waitMs`: how long to wait for the session after the link was accepted
     *   (default `EMAIL_LINK_SESSION_WAIT_MS`).
     * @returns What became of the link; `{ status: 'none' }` when the address carries none.
     * @throws TulaError when the API could not be reached or refused for another reason.
     */
    handleEmailLink(options?: { waitMs?: number }): Promise<EmailLinkOutcome>
    /**
     * Whether "continue with a provider" can be started here: the tab can keep the round
     * trip's binding (`sessionStorage`). `false` on a server, in a native shell and in some
     * sandboxed frames.
     *
     * @example
     * ```ts
     * if (tula.signIn.canUseOAuth()) showProviderButtons()
     * ```
     */
    canUseOAuth(): boolean
    /**
     * Whether this runtime can ask for a passkey at all (`navigator.credentials` and
     * `PublicKeyCredential` exist). `false` on a server and in a browser without WebAuthn.
     *
     * @example
     * ```ts
     * passkeyButton.hidden = !tula.signIn.canUsePasskey()
     * ```
     */
    canUsePasskey(): boolean
    /**
     * Whether the browser can offer passkeys in a field's autofill (conditional mediation).
     *
     * @example
     * ```ts
     * if (await tula.signIn.canAutofillPasskey()) {
     *   void tula.signIn.withPasskey({ autofill: true, signal })
     * }
     * ```
     */
    canAutofillPasskey(): Promise<boolean>
    /**
     * Sign in with a passkey: no identifier is needed. Starts an attempt of its own, runs the
     * browser's passkey dialog and submits what it returns. A passkey satisfies two-step
     * verification, so the flow comes back `complete` (or, for an account whose address was
     * never verified, on `needs_email_verification`).
     *
     * With `autofill: true` there is no dialog: the request waits, for as long as `signal`
     * allows, until the user picks a passkey the browser offers on a field with
     * `autocomplete="username webauthn"`. Give it a signal and abort it when the page goes
     * away or another way of signing in is used.
     *
     * @param request - A signal that ends the request, and whether to ask through autofill.
     * @returns The sign-in flow, past its first factor.
     * @throws TulaError `passkey.unsupported`, `passkey.cancelled` or `passkey.failed` from
     *   the browser; `auth.invalid_credentials` for a passkey the API does not accept (every
     *   reason is the same), `auth.method_disabled` where passkeys are off,
     *   `request.origin_not_allowed` for a page outside the environment's relying party.
     *
     * @example
     * ```ts
     * const flow = await tula.signIn.withPasskey()
     * if (flow.step.status === 'complete') {
     *   showApp()
     * }
     * ```
     */
    withPasskey(request?: PasskeyRequest): Promise<SignInFlow>
    /**
     * "Continue with Google, GitHub or Apple": a sign-in that creates the account when the
     * provider's verified address has none.
     *
     * Asks the API for the provider's URL, keeps the round trip's binding for this tab
     * (`sessionStorage`; it is not a token), and **navigates the page there**. Pass
     * `navigate: false` to get the URL and navigate yourself. The provider returns to the API,
     * which redirects to `redirectUrl`; call `signIn.handleOAuthCallback()` on that page.
     * `redirectUrl` must be one of the environment's allowed redirect URLs and on the same
     * origin as this page.
     *
     * @throws TulaError `auth.method_disabled` (the provider is not enabled),
     *   `request.redirect_not_allowed`, `link.cross_origin`, `storage.failed`.
     *
     * @example
     * ```ts
     * await tula.signIn.withOAuth({
     *   provider: 'google',
     *   redirectUrl: `${location.origin}/oauth/callback`,
     * })
     * ```
     */
    withOAuth(input: {
      provider: OAuthProvider
      redirectUrl: string
      navigate?: boolean
    }): Promise<{ url: string }>
    /**
     * Finish an OAuth round trip, on the page the API redirected to.
     *
     * Reads the ticket from the URL fragment, removes it from the address before anything is
     * sent, and exchanges it together with the binding this tab kept. Serves sign-ins and
     * links started from a profile alike. Safe to call on every load of the page, and twice in
     * a row: without an OAuth answer in the address it answers `none`.
     *
     * When the exchange gets no answer (`network.failed`, `network.timeout`) or a `rate_limited`,
     * the error is thrown and the round trip is kept for a minute: **call this again to retry**.
     * The ticket is held in memory only, never in storage or the address. Any answer from the
     * API, success or refusal, ends the round trip.
     *
     * @returns `complete` or `needs_step` with a flow positioned on the step (so
     *   `flow.submitSecondFactor` works), `linked`, `different_browser`, `error` with a contract
     *   code (`oauth.account_exists`, `oauth.access_denied`, …), or `none`.
     *
     * @example
     * ```ts
     * const outcome = await tula.signIn.handleOAuthCallback()
     * if (outcome.status === 'complete') location.assign('/')
     * ```
     */
    handleOAuthCallback(): Promise<OAuthCallbackOutcome>
    /**
     * Give up on an OAuth round trip whose exchange failed without an answer and has not been
     * retried: forgets the ticket held in memory and the binding kept for it. Signing out and
     * starting another round trip do the same. Does nothing when there is none.
     *
     * @example
     * ```ts
     * try {
     *   await tula.signIn.handleOAuthCallback()
     * } catch {
     *   // Offer "try again" (call it again) or "start over":
     *   tula.signIn.discardOAuthCallback()
     * }
     * ```
     */
    discardOAuthCallback(): void
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
     * **`null` while signed in on a `stateful` session profile** (ADR 0028). Such a session is
     * an httpOnly cookie the browser holds and this client never sees: there is no token, so
     * there is nothing to return and nothing is asked of the API. Use `state.status` to know
     * whether the user is signed in; a backend on the API's own host receives the cookie and
     * checks it with `POST /v1/admin/sessions/verify`.
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
     *   same, but the session may live on until it is revoked or expires). Calling `signOut()`
     *   again then tells the server: a browser sends its cookie again, and any other client
     *   the refresh token it kept in memory for exactly this.
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
    /**
     * Prove who the user is again, for this session, after a sensitive call answered
     * `auth.step_up_required` (see `isStepUpRequired` and `stepUpMethods`). The client never
     * calls this by itself: ask the user, call it, then repeat the action.
     *
     * A user with two-step verification proves it with `totp` or `backup_code` (their password
     * alone is refused); a user without it with `password`, or with an `email_code` asked for
     * with `prepareStepUp`. The proof holds for ten minutes.
     * Only the access token changes: the refresh token (or cookie) is untouched, and the
     * state does not change.
     *
     * @param proof - The method and its proof.
     * @throws TulaError `auth.invalid_credentials` (wrong password), `mfa.invalid_code` (wrong
     *   or already used code), `verification.invalid_code`, `verification.expired` or
     *   `verification.too_many_attempts` (an emailed code that is wrong, used or too old, or
     *   guessed at too often), `auth.step_up_required` (a method this user may not use),
     *   `rate_limited` after repeated wrong proofs, `auth.unauthenticated` when nobody is
     *   signed in or the session ended meanwhile.
     *
     * @example
     * ```ts
     * try {
     *   await tula.mfa.regenerateBackupCodes()
     * } catch (error) {
     *   if (isStepUpRequired(error) && stepUpMethods(error).includes('totp')) {
     *     await tula.session.stepUp({ method: 'totp', code: await askForCode() })
     *     await tula.mfa.regenerateBackupCodes()
     *   }
     * }
     * ```
     */
    stepUp(proof: StepUpProof): Promise<void>
    /**
     * Step up with a passkey, when `stepUpMethods` lists `passkey`: asks the API for the
     * options, runs the browser's passkey dialog and proves what it returns. Like `stepUp`,
     * it replaces the access token with one that carries the proof.
     *
     * @param request - A signal that ends the dialog.
     * @throws TulaError `passkey.unsupported`, `passkey.cancelled` or `passkey.failed` from
     *   the browser (nothing was sent to be judged), `auth.invalid_credentials` for an
     *   assertion the API refuses, `auth.step_up_required` for a user with no passkey.
     *
     * @example
     * ```ts
     * if (stepUpMethods(error).includes('passkey')) {
     *   await tula.session.stepUpWithPasskey()
     * }
     * ```
     */
    stepUpWithPasskey(request?: Pick<PasskeyRequest, 'signal'>): Promise<void>
    /**
     * Email the signed-in user a 6-digit code to step up with, when `stepUpMethods` lists
     * `email_code`: a user with a verified address and no two-step verification (someone who
     * signed up through a provider or by email has no password to prove). The code works for
     * ten minutes, once, and only for this session; asking again replaces it. The client never
     * calls this by itself: send the code when the user chooses to, then pass what they type
     * to `stepUp`.
     *
     * @param request - The method to prepare; `email_code` is the only one that needs it.
     * @returns Where the code went (masked) and when it expires. Never the code.
     * @throws TulaError `rate_limited` with `retryAfterMs` when a code was sent less than a
     *   minute ago (or too many this hour), `auth.step_up_required` when this user may not
     *   step up by email (they have a second factor, or no verified address),
     *   `response.invalid` for an answer that is not a receipt, `auth.unauthenticated` when
     *   nobody is signed in.
     *
     * @example
     * ```ts
     * try {
     *   await tula.oauth.unlink('google')
     * } catch (error) {
     *   if (stepUpMethods(error).includes('email_code')) {
     *     const { destination } = await tula.session.prepareStepUp({ method: 'email_code' })
     *     const code = await askForCode(`Enter the code we emailed to ${destination}`)
     *     await tula.session.stepUp({ method: 'email_code', code })
     *     await tula.oauth.unlink('google')
     *   }
     * }
     * ```
     */
    prepareStepUp(request: { method: 'email_code' }): Promise<StepUpPrepared>
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
     *   account without a password, and, for a user with two-step verification whose session
     *   has not proven it recently, `auth.step_up_required` (see `session.stepUp`).
     */
    changePassword(input: { currentPassword: string; newPassword: string }): Promise<void>
    /**
     * The signed-in user's passkeys (ADR 0027). Adding, renaming and removing one may answer
     * `auth.step_up_required`; see `session.stepUp`.
     */
    readonly passkeys: {
      /**
       * The user's passkeys, oldest first: a name, whether it is synced, when it was added
       * and last used. Never key material.
       *
       * @example
       * ```ts
       * const passkeys = await tula.user.passkeys.list()
       * ```
       */
      list(): Promise<Passkey[]>
      /**
       * Create a passkey on this device and save it to the account: asks the API for the
       * options, runs the browser's dialog and sends what it returns.
       *
       * @param input - An optional name, and a signal that ends the dialog.
       * @returns The saved passkey.
       * @throws TulaError `passkey.unsupported`, `passkey.cancelled`,
       *   `passkey.already_on_device` or `passkey.failed` from the browser;
       *   `passkey.registration_failed`, `passkey.limit_reached`, `auth.method_disabled` or
       *   `auth.step_up_required` from the API.
       *
       * @example
       * ```ts
       * const passkey = await tula.user.passkeys.add({ name: 'MacBook' })
       * ```
       */
      add(input?: { name?: string; signal?: AbortSignal }): Promise<Passkey>
      /**
       * Give a passkey another name.
       *
       * @example
       * ```ts
       * await tula.user.passkeys.rename({ passkeyId, name: 'Work phone' })
       * ```
       */
      rename(input: { passkeyId: string; name: string }): Promise<Passkey>
      /**
       * Remove a passkey from the account.
       *
       * @throws TulaError `passkey.last_sign_in_method` when it is the only way to sign in.
       *
       * @example
       * ```ts
       * await tula.user.passkeys.remove({ passkeyId })
       * ```
       */
      remove(input: { passkeyId: string }): Promise<void>
    }
    /**
     * The signed-in user's phone number: one, optional, proven with a 6-digit code sent by
     * text message. Each call may answer `auth.step_up_required`; see `session.stepUp`.
     *
     * Whether a number can be added at all is `phone.enabled` of `config.get()`. The number
     * itself is `phoneNumber` of the user, with `phoneNumberVerifiedAt`.
     */
    readonly phone: {
      /**
       * Text a 6-digit code to a number the user wants on their account. The number is
       * only pending: the account's own number, if it has one, stays until `verify`.
       *
       * @param input - The number, with its country code (`+14155550142`; spaces, hyphens
       *   and parentheses are ignored).
       * @returns The receipt: the number masked and when the code expires. Never the code.
       * @throws TulaError `phone.invalid` for what is not a phone number, `sms.disabled`
       *   where the application sends no text messages, `sms.country_not_allowed` for a
       *   number of a country it does not send to, `sms.unavailable` when the message could
       *   not be sent, `rate_limited` when a code was sent too recently or too often.
       *
       * @example
       * ```ts
       * const sent = await tula.user.phone.request({ phoneNumber: '+1 415 555 0142' })
       * ```
       */
      request(input: { phoneNumber: string }): Promise<PhoneCodeSent>
      /**
       * Prove the pending number with the code texted to it. The number becomes the
       * account's, replacing one it had, and the state's user is updated.
       *
       * @param input - The 6-digit code.
       * @returns The user, with the number.
       * @throws TulaError `verification.invalid_code` for a wrong code,
       *   `verification.expired` when no code is waiting (none was asked for, or it expired,
       *   was used or was replaced), `verification.too_many_attempts` or `rate_limited`
       *   after repeated wrong codes, `sms.disabled` or `sms.country_not_allowed` when the
       *   application stopped sending to that number since the code was asked for.
       *
       * @example
       * ```ts
       * const user = await tula.user.phone.verify({ code: '482913' })
       * user.phoneNumber // '+14155550142'
       * ```
       */
      verify(input: { code: string }): Promise<User>
      /**
       * Take the phone number off the account. Nothing happens when it has none.
       *
       * @example
       * ```ts
       * await tula.user.phone.remove()
       * ```
       */
      remove(): Promise<void>
    }
    /** The provider accounts (Google, GitHub, Apple) connected to the signed-in user. */
    readonly identities: {
      /**
       * @returns The connected accounts, oldest first.
       *
       * @example
       * ```ts
       * const accounts = await tula.user.identities.list()
       * ```
       */
      list(): Promise<Identity[]>
      /**
       * Start connecting a provider account to the signed-in user: like `signIn.withOAuth`, it
       * keeps a binding and navigates to the provider. `signIn.handleOAuthCallback()` on the
       * page it comes back to answers `linked`. Needs a recent authentication
       * (`auth.step_up_required` otherwise).
       *
       * @example
       * ```ts
       * await tula.user.identities.link({
       *   provider: 'github',
       *   redirectUrl: `${location.origin}/oauth/callback`,
       * })
       * ```
       */
      link(input: {
        provider: OAuthProvider
        redirectUrl: string
        navigate?: boolean
      }): Promise<{ url: string }>
      /**
       * Disconnect a provider account. Refused with `identity.last_sign_in_method` when nothing
       * else would let the user sign in. Needs a recent authentication.
       *
       * @example
       * ```ts
       * await tula.user.identities.unlink({ identityId })
       * ```
       */
      unlink(input: { identityId: string }): Promise<void>
    }
  }
  /**
   * Two-step verification of the signed-in user: an authenticator app (TOTP) and backup codes.
   *
   * The secret, its URI and the backup codes are returned to the caller once and kept nowhere
   * in the client: not in memory, not in storage, not in an error. Every call but `get` and
   * `confirmTotp` may answer `auth.step_up_required`; see `session.stepUp`.
   *
   * @example
   * ```ts
   * const { secret, uri } = await tula.mfa.startTotp() // show the QR code of `uri`
   * const { codes } = await tula.mfa.confirmTotp({ code: '123456' }) // show the codes once
   * ```
   */
  readonly mfa: {
    /**
     * @returns Whether an authenticator app is confirmed, since when, and how many backup
     *   codes are unused. Never a secret.
     * @throws TulaError `auth.unauthenticated` when nobody is signed in.
     */
    get(): Promise<Factors>
    /**
     * Start enrolling an authenticator app. It counts for nothing until confirmed, and lapses
     * after ten minutes; calling it again replaces the pending secret.
     *
     * @returns The Base32 secret and its `otpauth://` URI, once.
     * @throws TulaError `mfa.not_available` where the environment has it off,
     *   `mfa.already_enabled` for a user who has one, `auth.step_up_required`.
     */
    startTotp(): Promise<TotpEnrolment>
    /**
     * Confirm the authenticator with the 6-digit code it shows now: two-step verification is
     * on, and the user's other sessions end. The client then refreshes this session, so that
     * its next access token says the second factor was proven; if that refresh cannot be
     * made, the codes are returned all the same and the next `getToken()` tries again.
     *
     * @param input - The code.
     * @returns Ten backup codes, once.
     * @throws TulaError `mfa.invalid_code`, `mfa.enrolment_expired` (nothing pending, or
     *   started more than ten minutes ago), `rate_limited` after repeated wrong codes.
     */
    confirmTotp(input: { code: string }): Promise<BackupCodes>
    /**
     * Turn two-step verification off: removes the authenticator and every backup code.
     *
     * @throws TulaError `mfa.not_enabled`, `mfa.required_by_policy` where the environment
     *   requires it, `auth.step_up_required`.
     */
    disableTotp(): Promise<void>
    /**
     * Replace the user's backup codes. The earlier ones stop working.
     *
     * @returns Ten new backup codes, once.
     * @throws TulaError `mfa.not_enabled`, `auth.step_up_required`.
     */
    regenerateBackupCodes(): Promise<BackupCodes>
  }
  /** The environment's public configuration. */
  readonly config: {
    /**
     * The app's name, the enabled sign-in methods, the password policy and whether two-step
     * verification is offered (`mfa.policy`; an API that does not say means `off`). Fetched
     * once and kept; pass `force` to fetch it again.
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
  const { sessionProfile } = options
  if (
    sessionProfile !== undefined &&
    (typeof sessionProfile !== 'string' ||
      sessionProfile.length > 32 ||
      !SESSION_PROFILE_NAME.test(sessionProfile))
  ) {
    throw new TypeError(
      'createTulaClient: `sessionProfile` must be a profile name: lowercase letters, digits and single hyphens, at most 32 characters'
    )
  }
  const refreshTimeoutMs = Math.min(timeoutMs, REFRESH_TIMEOUT_MS)
  const send = options.fetch ?? ((request: Request) => globalThis.fetch(request))

  let messages: Messages = options.messages ?? {}
  const currentMessages = () => messages

  // One lock, channel and storage entry per API and environment, so two apps (or two
  // environments) on one origin do not share a session.
  const scope = `${baseUrl}|${publishableKey}`
  const transport = createTransport({
    baseUrl,
    publishableKey,
    client,
    fetch: send,
    timeoutMs,
    messages: currentMessages,
    ...(sessionProfile && { sessionProfile }),
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
    scope,
    messages: currentMessages,
  })
  if (options.onSessionChange) {
    session.subscribe(options.onSessionChange)
  }
  const links = createLinkStore(environment, scope)
  // Looked up when a passkey is asked for, not when the client is made: a page may gain or
  // lose WebAuthn (an extension, a test) after that.
  const passkeys = () =>
    environment.passkeys ? browserAuthenticator(environment.passkeys, currentMessages) : undefined
  const flows = {
    transport,
    session,
    messages: currentMessages,
    environment,
    links,
    scope,
    passkeys,
  }

  /** The browser's ceremonies, or the error that says there are none. */
  function authenticator(): PasskeyAuthenticator {
    const found = passkeys()
    if (!found) {
      throw clientError('passkey.unsupported', messages)
    }
    return found
  }
  const oauth = {
    ...flows,
    oauth: createOAuthStore(environment, scope),
    held: createOAuthTicketHolder(),
  }
  let config: Promise<ClientConfig> | null = null

  /** A 200 that is not what the operation answers is not this API: nothing is built from it. */
  function checked<T>(answer: unknown, guard: (value: unknown) => value is T): T {
    if (!guard(answer)) {
      throw clientError('response.invalid', messages)
    }
    return answer
  }
  /**
   * Run a call that answers the signed-in user, and show that user in the state.
   *
   * The user belongs to the session that asked. If that session ended, or someone else
   * signed in, while the request was in flight, it must not become the new state's user.
   */
  async function asUser<T extends User | null>(call: () => Promise<T>): Promise<T> {
    // Settle who is signed in first (a client that has not loaded yet restores its session
    // here), so that the answer can be tied to that session.
    await session.getToken()
    const asked = session.state()
    const user = await call()
    const now = session.state()
    if (
      user &&
      asked.status === 'signed-in' &&
      now.status === 'signed-in' &&
      now.sessionId === asked.sessionId
    ) {
      session.setUser(user)
    }
    return user
  }
  let handlingLink: Promise<EmailLinkOutcome> | null = null
  let handlingOAuth: Promise<OAuthCallbackOutcome> | null = null

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
      canUseEmailLink: () => links.available(),
      handleEmailLink(options) {
        if (!handlingLink) {
          const pending = handleEmailLink(
            { transport, session, environment, links, scope },
            options
          ).finally(() => {
            if (handlingLink === pending) {
              handlingLink = null
            }
          })
          handlingLink = pending
        }
        return handlingLink
      },
      canUsePasskey: () => passkeys() !== undefined,
      canAutofillPasskey: async () => (await passkeys()?.autofillAvailable()) ?? false,
      withPasskey: (request) => passkeySignIn(flows, request),
      canUseOAuth: () => oauth.oauth.available(),
      withOAuth: (input) => startOAuth(oauth, input, 'sign_in'),
      handleOAuthCallback() {
        // One exchange per answer: a UI calls this from an effect that may run twice, and the
        // second call would find the address already cleaned and answer `none`.
        if (!handlingOAuth) {
          const pending = handleOAuthCallback(oauth).finally(() => {
            if (handlingOAuth === pending) {
              handlingOAuth = null
            }
          })
          handlingOAuth = pending
        }
        return handlingOAuth
      },
      discardOAuthCallback: () => discardOAuthCallback(oauth),
    },
    resetPassword: {
      start: async (input) =>
        passwordResetFlow(flows, await transport.call('startPasswordReset', { body: input })),
    },
    session: {
      getToken: () => session.getToken(),
      refresh: () => session.refresh(),
      signOut() {
        // A round trip waiting for a retry belongs to whoever was here: forget it.
        discardOAuthCallback(oauth)
        return session.signOut()
      },
      list: async () => (await session.authorized('listSessions', {})).data,
      async revoke(sessionId) {
        await session.authorized('revokeSession', { params: { sessionId } })
        await session.ended(sessionId)
      },
      revokeOthers: async () => (await session.authorized('revokeOtherSessions', {})).revoked,
      stepUp: (proof) => session.stepUp(proof),
      async stepUpWithPasskey(request = {}) {
        const ceremonies = authenticator()
        const options = checked(
          await session.authorized('getStepUpPasskeyOptions', {}),
          isRequestOptions
        )
        const credential = await ceremonies.get(options, { signal: request.signal })
        await session.stepUp({ method: 'passkey', credential })
      },
      async prepareStepUp() {
        const { destination, expiresAt } = checked(
          await session.authorized('sendStepUpEmailCode', {}),
          isStepUpPrepared
        )
        // Only the receipt: whatever else an answer held does not travel further.
        return { method: 'email_code', destination, expiresAt }
      },
    },
    user: {
      get: () => asUser(() => session.authorized('getMe', {})),
      phone: {
        async request(input) {
          const { destination, expiresAt } = checked(
            await session.authorized('requestPhoneCode', { body: input }),
            isPhoneCodeSent
          )
          // Only the receipt: whatever else an answer held does not travel further.
          return { destination, expiresAt }
        },
        verify: (input) => asUser(() => session.authorized('verifyPhoneNumber', { body: input })),
        async remove() {
          await asUser(async () => {
            await session.authorized('removePhoneNumber', {})
            const now = session.state()
            // What the server now holds, without asking it again. `null` when the state has
            // no user to correct: nothing is installed then.
            return now.status === 'signed-in' && now.user
              ? { ...now.user, phoneNumber: null, phoneNumberVerifiedAt: null }
              : null
          })
        },
      },
      async changePassword(input) {
        await session.authorized('changeMyPassword', { body: input })
      },
      identities: {
        list: async () =>
          checked(await session.authorized('listMyIdentities', {}), isIdentityList).data,
        link: (input) => startOAuth(oauth, input, 'link'),
        async unlink({ identityId }) {
          await session.authorized('deleteMyIdentity', { params: { identityId } })
        },
      },
      passkeys: {
        list: async () =>
          checked(await session.authorized('listMyPasskeys', {}), isPasskeyList).passkeys.map(
            toPasskey
          ),
        async add(input = {}) {
          const ceremonies = authenticator()
          const options = checked(
            await session.authorized('startPasskeyRegistration', {}),
            isCreationOptions
          )
          const credential = await ceremonies.create(options, { signal: input.signal })
          return toPasskey(
            checked(
              await session.authorized('finishPasskeyRegistration', {
                body: { credential, ...(input.name !== undefined && { name: input.name }) },
              }),
              isPasskeyAnswer
            )
          )
        },
        rename: async ({ passkeyId, name }) =>
          toPasskey(
            checked(
              await session.authorized('renamePasskey', { params: { passkeyId }, body: { name } }),
              isPasskeyAnswer
            )
          ),
        async remove({ passkeyId }) {
          await session.authorized('removePasskey', { params: { passkeyId } })
        },
      },
    },
    mfa: {
      get: async () => checked(await session.authorized('getMyFactors', {}), isFactors),
      async startTotp() {
        const { secret, uri } = checked(
          await session.authorized('startTotpEnrolment', {}),
          isTotpEnrolment
        )
        return { secret, uri }
      },
      async confirmTotp({ code }) {
        await session.getToken()
        const asked = session.state()
        const { codes } = checked(
          await session.authorized('confirmTotpEnrolment', { body: { code } }),
          isBackupCodes
        )
        // The server now holds this session to have proven the factor, but the access token
        // in hand was issued before: the next sensitive call would answer
        // `auth.step_up_required`. A refresh brings a token that says so. It is made only for
        // the session that asked (a client signed out meanwhile stays signed out), and its
        // failure is not the caller's: the codes exist nowhere else and must reach them.
        const now = session.state()
        if (
          asked.status === 'signed-in' &&
          now.status === 'signed-in' &&
          now.sessionId === asked.sessionId
        ) {
          await session.refresh().catch(() => session.expire())
        }
        return { codes }
      },
      async disableTotp() {
        await session.authorized('disableTotp', {})
      },
      regenerateBackupCodes: async () => {
        const { codes } = checked(
          await session.authorized('regenerateBackupCodes', {}),
          isBackupCodes
        )
        return { codes }
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
