import { ERROR_DEFINITIONS } from '@tula/contract/error-codes'
import {
  EMAIL_LINK_ATTEMPT_PARAM,
  OAUTH_ERROR_PARAM,
  OAUTH_TICKET_PARAM,
} from '@tula/contract/headers'
import type { Environment, LinkStorageLike } from './environment'
import { clientError, formatMessage, isTulaError, type Messages } from './errors'
import { type FlowContext, type SignInFlow, signInFlow } from './flows'
import type { Schemas } from './generated/api.gen'

/** A provider `signIn.withOAuth` can be asked for. */
export type OAuthProvider = Schemas['OAuthProvider']
/** A provider account connected to the signed-in user. */
export type Identity = Schemas['Identity']

/**
 * How long a kept OAuth binding is honoured, on the device's own clock: as long as an attempt
 * lives (ten minutes), with room for a slow consent screen.
 */
export const OAUTH_BINDING_TTL_MS = 15 * 60_000

/**
 * How long a ticket whose exchange got no answer is held for another try, on the device's
 * clock: as long as the API honours a ticket (60 seconds). After that a retry could only be
 * refused, so the ticket is dropped instead.
 */
export const OAUTH_TICKET_HOLD_MS = 60_000

/**
 * The failures of an exchange that say nothing about the ticket: the request got no answer, or
 * was turned away before the API looked at it. Everything else is the API's answer.
 */
const RETRYABLE: ReadonlySet<string> = new Set([
  'network.failed',
  'network.timeout',
  'rate_limited',
])

/**
 * Whether a failure thrown by `signIn.handleOAuthCallback()` left the round trip in place, so
 * that calling it again retries the exchange: the request got no answer (`network.failed`,
 * `network.timeout`) or was rate limited.
 *
 * @param error - What `handleOAuthCallback()` threw.
 * @returns `true` when calling it again can still succeed.
 *
 * @example
 * ```ts
 * try {
 *   await tula.signIn.handleOAuthCallback()
 * } catch (error) {
 *   if (isRetryableOAuthError(error)) showTryAgain()
 * }
 * ```
 */
export function isRetryableOAuthError(error: unknown): boolean {
  return isTulaError(error) && RETRYABLE.has(error.code)
}

/** Prefix of the `sessionStorage` key an OAuth binding is kept under, followed by the attempt id. */
export const OAUTH_STORAGE_PREFIX = 'tula.oauth.'

/**
 * What became of an OAuth round trip, as `signIn.handleOAuthCallback()` reports it.
 *
 * - `none`: the address holds no OAuth answer. Nothing was sent.
 * - `complete`: signed in. `flow.step.status` is `complete`.
 * - `needs_step`: the provider was accepted as a first factor and something still stands before
 *   the session (`needs_second_factor`, `needs_factor_enrolment`). `flow` is positioned on that
 *   step: `flow.submitSecondFactor(…)` and the enrolment actions work as for any sign-in.
 * - `linked`: a provider account was connected to the signed-in user (a link started with
 *   `user.identities.link`).
 * - `different_browser`: this browser did not start the sign-in (or no longer has what it kept).
 *   Nothing was completed. Start again here.
 * - `error`: it did not go through. `code` is a contract error code: `oauth.access_denied` (the
 *   user cancelled), `oauth.account_exists` (sign in the usual way, then connect the provider
 *   from the profile), `oauth.email_unverified`, `oauth.ticket_invalid`, …; `message` is its text.
 *
 * @example
 * ```ts
 * const outcome: OAuthCallbackOutcome = await tula.signIn.handleOAuthCallback()
 * if (outcome.status === 'needs_step') {
 *   await outcome.flow.submitSecondFactor({ method: 'totp', code })
 * }
 * ```
 */
export type OAuthCallbackOutcome =
  | { readonly status: 'none' }
  | { readonly status: 'complete'; readonly flow: SignInFlow }
  | { readonly status: 'needs_step'; readonly flow: SignInFlow }
  | { readonly status: 'linked'; readonly identity: Identity }
  | { readonly status: 'different_browser' }
  | { readonly status: 'error'; readonly code: string; readonly message: string }

/** What a round trip was started for. */
type Intent = 'sign_in' | 'link'

/**
 * Where a browser keeps the binding of an OAuth round trip while the tab is away at the
 * provider (ADR 0026).
 *
 * **Why `sessionStorage`, when the SDK otherwise keeps nothing there.** The page is replaced by
 * the provider's and later loaded afresh, so memory does not survive; the value has to be read
 * by the *same tab* when it comes back, which is exactly what `sessionStorage` is scoped to
 * (another tab, and another site, cannot read it). And it is **not a token and not the
 * attempt's secret**: alone it authorizes nothing, and with the ticket the API hands the page
 * it only lets *this* browser exchange it. An attacker who learned it could do nothing without
 * the ticket, which lasts a minute and is delivered to this tab only.
 *
 * It is removed when the round trip gets a definitive answer (success or a refusal), kept while
 * an exchange that got no answer can still be retried, and expires on the device's own clock.
 */
export interface OAuthStore {
  /** Whether a binding can be kept here at all. */
  available(): boolean
  /** Keep an attempt's binding. Returns `false` when it could not be stored. */
  save(attemptId: string, binding: string, intent: Intent): boolean
  /** The binding kept for an attempt and what it was started for, or `null`. */
  read(attemptId: string): { binding: string; intent: Intent } | null
  /** Forget an attempt's binding. */
  remove(attemptId: string): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Build the binding store over a tab's `sessionStorage`.
 *
 * Every access is guarded: storage can be absent (a server, a native shell), or throw (a
 * sandboxed frame, a full quota). Then nothing is kept and an OAuth sign-in is refused before
 * the browser leaves, instead of failing when it comes back.
 *
 * @param environment - The tab's storage and the clock.
 * @param scope - Distinguishes clients of different APIs or environments on one origin.
 * @returns The store.
 */
export function createOAuthStore(
  environment: Pick<Environment, 'tabStorage' | 'now'>,
  scope: string
): OAuthStore {
  const storage: LinkStorageLike | undefined = environment.tabStorage
  const keyOf = (attemptId: string) => `${OAUTH_STORAGE_PREFIX}${attemptId}`

  function guarded<T>(work: () => T, fallback: T): T {
    try {
      return work()
    } catch {
      return fallback
    }
  }

  /** Drop every entry of this SDK whose time is up, whoever's scope it is. */
  function prune(): void {
    if (!storage) {
      return
    }
    const stale: string[] = []
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index)
      if (key?.startsWith(OAUTH_STORAGE_PREFIX)) {
        const expiry = guarded(
          () => (JSON.parse(storage.getItem(key) ?? 'null') as { e?: unknown } | null)?.e,
          undefined
        )
        if (typeof expiry !== 'number' || expiry <= environment.now()) {
          stale.push(key)
        }
      }
    }
    for (const key of stale) {
      storage.removeItem(key)
    }
  }

  return {
    available: () =>
      guarded(() => {
        if (!storage) {
          return false
        }
        const probe = `${OAUTH_STORAGE_PREFIX}probe`
        storage.setItem(probe, '1')
        storage.removeItem(probe)
        return true
      }, false),
    save: (attemptId, binding, intent) =>
      guarded(() => {
        if (!storage) {
          return false
        }
        prune()
        storage.setItem(
          keyOf(attemptId),
          JSON.stringify({
            b: binding,
            e: environment.now() + OAUTH_BINDING_TTL_MS,
            s: scope,
            k: intent,
          })
        )
        return true
      }, false),
    read: (attemptId) =>
      guarded(() => {
        prune()
        const entry: unknown = JSON.parse(storage?.getItem(keyOf(attemptId)) ?? 'null')
        return isRecord(entry) &&
          typeof entry.b === 'string' &&
          entry.s === scope &&
          (entry.k === 'sign_in' || entry.k === 'link')
          ? { binding: entry.b, intent: entry.k }
          : null
      }, null),
    remove(attemptId) {
      guarded(() => storage?.removeItem(keyOf(attemptId)), undefined)
    },
  }
}

/** What an OAuth callback left in a URL's fragment. */
export interface OAuthFragment {
  attemptId: string
  /** The single-use ticket, when the provider vouched. */
  ticket: string | null
  /** The error code, when it did not. */
  error: string | null
  /** The URL without those parameters, to put back in the address bar. */
  cleanUrl: string
}

/**
 * Read what the API's OAuth callback put in a page's URL fragment.
 *
 * @param url - The page's full URL.
 * @returns The ticket or error with its attempt id, or `null` when the fragment has neither.
 *
 * @example
 * ```ts
 * readOAuthFragment('https://app.example.com/cb#tula_ticket=t&tula_attempt=a')?.ticket // 't'
 * ```
 */
export function readOAuthFragment(url: string): OAuthFragment | null {
  const at = url.indexOf('#')
  if (at === -1) {
    return null
  }
  const fragment = new URLSearchParams(url.slice(at + 1))
  const ticket = fragment.get(OAUTH_TICKET_PARAM)
  const error = fragment.get(OAUTH_ERROR_PARAM)
  if (!ticket && !error) {
    return null
  }
  const attemptId = fragment.get(EMAIL_LINK_ATTEMPT_PARAM) ?? ''
  for (const name of [OAUTH_TICKET_PARAM, OAUTH_ERROR_PARAM, EMAIL_LINK_ATTEMPT_PARAM]) {
    fragment.delete(name)
  }
  const rest = fragment.toString()
  return {
    attemptId,
    ticket: ticket || null,
    error: ticket ? null : error,
    cleanUrl: `${url.slice(0, at)}${rest ? `#${rest}` : ''}`,
  }
}

/** A ticket whose exchange has not had a definitive answer yet. */
export interface HeldOAuthTicket {
  attemptId: string
  ticket: string
  /** When it stops being worth a retry, on the device's clock. */
  until: number
}

/**
 * Where a client keeps the ticket of an exchange that may be retried: **in memory only**, in a
 * closure. Never in storage, a URL, an error or anything `JSON.stringify` or an inspector can
 * reach from the client object.
 */
export interface OAuthTicketHolder {
  /** The held ticket, or `null`. */
  get(): HeldOAuthTicket | null
  /** Hold a ticket, or forget it with `null`. */
  set(held: HeldOAuthTicket | null): void
}

/**
 * Build a ticket holder for one client.
 *
 * @returns The holder, empty.
 */
export function createOAuthTicketHolder(): OAuthTicketHolder {
  let held: HeldOAuthTicket | null = null
  return {
    get: () => held,
    set(next) {
      held = next
    },
  }
}

/** What the OAuth calls are built from. */
export interface OAuthContext extends FlowContext {
  oauth: OAuthStore
  /** The ticket of an exchange that got no answer, for a retry. */
  held: OAuthTicketHolder
}

/**
 * Forget a round trip that is waiting for a retry: the held ticket and the binding kept for it.
 * Called on sign-out, when another round trip starts, and when an app gives up on the callback.
 *
 * @param context - Storage and the ticket holder.
 */
export function discardOAuthCallback(context: Pick<OAuthContext, 'oauth' | 'held'>): void {
  const held = context.held.get()
  if (held) {
    context.held.set(null)
    context.oauth.remove(held.attemptId)
  }
}

function isLinkStart(value: unknown): value is Schemas['IdentityLinkStart'] {
  return (
    isRecord(value) &&
    typeof value.attemptId === 'string' &&
    value.attemptId !== '' &&
    typeof value.authorizationUrl === 'string' &&
    typeof value.binding === 'string'
  )
}

function isIdentity(value: unknown): value is Identity {
  return isRecord(value) && typeof value.id === 'string' && typeof value.provider === 'string'
}

/**
 * Whether a list answer is the user's identities.
 *
 * @param value - A response body.
 * @returns `true` for `{ data: Identity[] }`.
 */
export function isIdentityList(value: unknown): value is Schemas['IdentityList'] {
  return isRecord(value) && Array.isArray(value.data) && value.data.every(isIdentity)
}

/**
 * Start an OAuth round trip: ask the API for the provider's URL, keep the binding for this tab,
 * and send the browser there.
 *
 * Refused before any request when the binding could not be kept (`storage.failed`) or when
 * `redirectUrl` is on another origin than this page (`link.cross_origin`): the page the browser
 * comes back to could not read the binding, so the round trip could only end in
 * "different browser".
 *
 * @param context - Transport, session, storage and the page.
 * @param input - The provider, the page to come back to, and whether to navigate.
 * @param intent - A sign-in, or connecting an account to the signed-in user.
 * @returns The provider's URL. The browser is already on its way there unless `navigate` is
 *   `false` or there is no page to navigate.
 * @throws TulaError `storage.failed`, `link.cross_origin`, `response.invalid`, or what the API
 *   answered (`auth.method_disabled`, `request.redirect_not_allowed`, `auth.step_up_required`).
 */
export async function startOAuth(
  context: OAuthContext,
  input: { provider: OAuthProvider; redirectUrl: string; navigate?: boolean },
  intent: Intent
): Promise<{ url: string }> {
  const { environment, oauth, transport, session } = context
  // A new round trip replaces one that was waiting for a retry.
  discardOAuthCallback(context)
  if (!oauth.available()) {
    throw clientError('storage.failed', context.messages())
  }
  const page = environment.page
  if (page && originOf(input.redirectUrl) !== originOf(page.url())) {
    throw clientError('link.cross_origin', context.messages())
  }
  const body = { provider: input.provider, redirectUrl: input.redirectUrl }
  let attemptId: string
  let started: { authorizationUrl: string; binding: string }
  if (intent === 'link') {
    const answer: unknown = await session.authorized('startIdentityLink', { body })
    if (!isLinkStart(answer)) {
      throw clientError('response.invalid', context.messages())
    }
    attemptId = answer.attemptId
    started = answer
  } else {
    const answer: unknown = await transport.call('startOAuthSignIn', { body })
    if (
      !isRecord(answer) ||
      !isRecord(answer.attempt) ||
      typeof answer.attempt.id !== 'string' ||
      typeof answer.authorizationUrl !== 'string' ||
      typeof answer.binding !== 'string'
    ) {
      throw clientError('response.invalid', context.messages())
    }
    attemptId = answer.attempt.id
    started = { authorizationUrl: answer.authorizationUrl, binding: answer.binding }
  }
  // Only ever an http(s) URL: the answer is the server's, but a navigation is not something
  // to hand a `javascript:` URL to on anyone's word.
  if (!/^https?:\/\//i.test(started.authorizationUrl)) {
    throw clientError('response.invalid', context.messages())
  }
  if (!oauth.save(attemptId, started.binding, intent)) {
    throw clientError('storage.failed', context.messages())
  }
  if (input.navigate !== false) {
    page?.assign?.(started.authorizationUrl)
  }
  return { url: started.authorizationUrl }
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** The outcome for a contract error: its code and the text an app can show. */
function failed(code: string, messages: Messages): OAuthCallbackOutcome {
  // A code from the address bar is untrusted: only one the contract defines is passed on.
  const known = Object.hasOwn(ERROR_DEFINITIONS, code) ? code : 'oauth.provider_error'
  return {
    status: 'error',
    code: known,
    message: formatMessage(known as keyof typeof ERROR_DEFINITIONS, { messages }),
  }
}

/**
 * Finish an OAuth round trip on the page the API redirected to.
 *
 * Reads the ticket (or the error) from the URL fragment and **removes it from the address
 * before anything is sent**, so it is neither left in history nor visible to later scripts.
 * The ticket is posted, in a JSON body, with the binding this tab kept.
 *
 * **What was kept is removed once the exchange has a definitive answer**: success, or any
 * refusal by the API. When the request got no answer (`network.failed`, `network.timeout`) or
 * was rate limited, the error is thrown and both the binding (in `sessionStorage`) and the
 * ticket (in memory only, for {@link OAUTH_TICKET_HOLD_MS}) are kept: calling this again on the
 * same client retries the exchange, although the address no longer holds the ticket.
 *
 * @param context - Transport, session, storage, the ticket holder and the page.
 * @returns What became of the round trip.
 * @throws TulaError when the API could not be reached (`network.failed`, `network.timeout`) or
 *   answered `rate_limited` (call again to retry), or answered something unusable
 *   (`response.invalid`, not retryable).
 */
export async function handleOAuthCallback(context: OAuthContext): Promise<OAuthCallbackOutcome> {
  const { environment, oauth, held, transport, session } = context
  const page = environment.page
  if (!page) {
    return { status: 'none' }
  }
  const arrived = readOAuthFragment(page.url())
  let answer: HeldOAuthTicket
  if (arrived) {
    try {
      page.replaceUrl(arrived.cleanUrl)
    } catch {
      // The address cannot be rewritten here (a sandboxed frame). The ticket is single use and
      // about to be spent, so go on.
    }
    // What the address says now replaces a round trip that was waiting for a retry.
    discardOAuthCallback(context)
    if (arrived.error !== null || arrived.ticket === null) {
      oauth.remove(arrived.attemptId)
      return arrived.error !== null
        ? failed(arrived.error, context.messages())
        : { status: 'different_browser' }
    }
    answer = {
      attemptId: arrived.attemptId,
      ticket: arrived.ticket,
      until: environment.now() + OAUTH_TICKET_HOLD_MS,
    }
  } else {
    const waiting = held.get()
    if (!waiting) {
      return { status: 'none' }
    }
    if (waiting.until <= environment.now()) {
      // The API no longer honours it: say so without asking.
      discardOAuthCallback(context)
      return failed('oauth.ticket_invalid', context.messages())
    }
    answer = waiting
  }
  const kept = oauth.read(answer.attemptId)
  /** The exchange has its answer: nothing is kept for another try. */
  const settle = () => {
    held.set(null)
    oauth.remove(answer.attemptId)
  }
  if (!kept) {
    // Without the binding the exchange can only be refused: this browser did not start it.
    settle()
    return { status: 'different_browser' }
  }
  held.set(answer)
  const body = { ticket: answer.ticket, attemptId: answer.attemptId, binding: kept.binding }
  try {
    let outcome: OAuthCallbackOutcome
    if (kept.intent === 'link') {
      const identity: unknown = await session.authorized('exchangeIdentityLinkTicket', { body })
      if (!isIdentity(identity)) {
        throw clientError('response.invalid', context.messages())
      }
      outcome = { status: 'linked', identity }
    } else {
      const attempt = await transport.call('exchangeOAuthTicket', { body })
      const complete =
        isRecord(attempt) && isRecord(attempt.step) && attempt.step.status === 'complete'
      outcome = {
        status: complete ? 'complete' : 'needs_step',
        flow: await signInFlow(context, attempt),
      }
    }
    settle()
    return outcome
  } catch (error) {
    if (isRetryableOAuthError(error)) {
      // No answer about the ticket: keep it and the binding, so the caller can try again.
      throw error
    }
    settle()
    if (!isTulaError(error) || error.status === 0) {
      throw error
    }
    if (error.code === 'oauth.different_browser') {
      return { status: 'different_browser' }
    }
    return { status: 'error', code: error.code, message: error.message }
  }
}
