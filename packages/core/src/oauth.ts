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
 * It is removed on every outcome of the round trip and expires on the device's own clock.
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

/** What the OAuth calls are built from. */
export interface OAuthContext extends FlowContext {
  oauth: OAuthStore
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
 * The ticket is posted, in a JSON body, with the binding this tab kept. What it kept is removed
 * whatever the outcome.
 *
 * @param context - Transport, session, storage and the page.
 * @returns What became of the round trip.
 * @throws TulaError when the API could not be reached (`network.failed`, `network.timeout`) or
 *   answered something unusable (`response.invalid`), or `rate_limited`.
 */
export async function handleOAuthCallback(context: OAuthContext): Promise<OAuthCallbackOutcome> {
  const { environment, oauth, transport, session } = context
  const page = environment.page
  const answer = page ? readOAuthFragment(page.url()) : null
  if (!page || !answer) {
    return { status: 'none' }
  }
  try {
    page.replaceUrl(answer.cleanUrl)
  } catch {
    // The address cannot be rewritten here (a sandboxed frame). The ticket is single use and
    // about to be spent, so go on.
  }
  const kept = oauth.read(answer.attemptId)
  oauth.remove(answer.attemptId)
  if (answer.error !== null) {
    return failed(answer.error, context.messages())
  }
  if (!kept || answer.ticket === null) {
    // Without the binding the exchange can only be refused: this browser did not start it.
    return { status: 'different_browser' }
  }
  const body = { ticket: answer.ticket, attemptId: answer.attemptId, binding: kept.binding }
  try {
    if (kept.intent === 'link') {
      const identity: unknown = await session.authorized('exchangeIdentityLinkTicket', { body })
      if (!isIdentity(identity)) {
        throw clientError('response.invalid', context.messages())
      }
      return { status: 'linked', identity }
    }
    const attempt = await transport.call('exchangeOAuthTicket', { body })
    if (isRecord(attempt) && isRecord(attempt.step) && attempt.step.status === 'complete') {
      return { status: 'complete', flow: await signInFlow(context, attempt) }
    }
    return { status: 'needs_step', flow: await signInFlow(context, attempt) }
  } catch (error) {
    if (!isTulaError(error) || error.status === 0 || error.code === 'rate_limited') {
      throw error
    }
    if (error.code === 'oauth.different_browser') {
      return { status: 'different_browser' }
    }
    return { status: 'error', code: error.code, message: error.message }
  }
}
