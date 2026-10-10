import {
  EN_MESSAGES,
  type Identity,
  isRetryableOAuthError,
  type OAuthCallbackOutcome,
  type OAuthProvider,
  type SignInFlow,
  type TulaClient,
  TulaError,
} from '@tula/core'
import { toTulaError } from './errors'
import { type ExpoHost, hostOf } from './host'

// Signing in with a provider from an app: the API's own round trip (ADR 0026), with the
// system browser where a page would navigate. `@tula/core` starts it and exchanges the
// ticket; this module opens the browser between the two and decides whether what came back
// is worth a request at all.

/**
 * What a provider sign-in asks for.
 *
 * @example
 * ```ts
 * const input: ProviderSignInInput = {
 *   provider: 'google',
 *   redirectUrl: 'com.example.app:/oauth/callback',
 * }
 * ```
 */
export interface ProviderSignInInput {
  /** The provider, as the client configuration lists it (`signIn.oauth`). */
  provider: OAuthProvider
  /**
   * Where the round trip ends, exactly as it is listed in the environment's redirect URLs:
   * the app's custom scheme (`com.example.app:/oauth/callback`; only for a provider that
   * binds its code with PKCE) or an `https` app link. The server decides whether it is
   * allowed (`request.redirect_not_allowed`, with a reason).
   */
  redirectUrl: string
}

/**
 * How a provider round trip ended.
 *
 * - `complete`: signed in. `flow.step` is the `complete` step.
 * - `needs_step`: the provider vouched and the server asks for more (a second factor).
 *   Go on with `flow`.
 * - `linked`: the account is connected to the signed-in user (`linkProvider`).
 * - `cancelled`: the user closed the browser. Not an error and not a sign-in.
 * - `refused`: what the browser came back with was not sent to the server at all:
 *   `unexpected_return` (not the redirect URL that was asked for), `no_answer` (no ticket
 *   and no error in it) or `not_started_here` (a ticket for a round trip this client holds
 *   no binding for, or one the server says another client started). Nobody is signed in.
 * - `error`: the provider or the server refused; `code` is a contract code
 *   (`oauth.access_denied`, `oauth.email_unverified`, `oauth.account_exists`, …) and
 *   `message` is ready to show.
 *
 * @example
 * ```ts
 * const outcome: ProviderOutcome = await signInWithProvider(tula, input)
 * if (outcome.status === 'complete') showHome()
 * ```
 */
export type ProviderOutcome =
  | { readonly status: 'complete'; readonly flow: SignInFlow }
  | { readonly status: 'needs_step'; readonly flow: SignInFlow }
  | { readonly status: 'linked'; readonly identity: Identity }
  | { readonly status: 'cancelled' }
  | {
      readonly status: 'refused'
      readonly reason: 'unexpected_return' | 'no_answer' | 'not_started_here'
    }
  | { readonly status: 'error'; readonly code: string; readonly message: string }

function clientError(code: 'flow.busy' | 'storage.failed'): TulaError {
  return new TulaError({ code, message: EN_MESSAGES[code] })
}

/** What `@tula/core` made of the returned URL, in this package's words. */
function outcomeOf(host: ExpoHost, answer: OAuthCallbackOutcome): ProviderOutcome {
  switch (answer.status) {
    case 'none':
      // Neither a ticket nor an error: nothing was asked of the server.
      host.forget()
      return { status: 'refused', reason: 'no_answer' }
    case 'different_browser':
      host.forget()
      return { status: 'refused', reason: 'not_started_here' }
    default:
      return answer
  }
}

/**
 * Exchange what the client holds of a round trip, and clear the address whatever happens.
 * A failure that may be tried again leaves the binding (in memory) and the ticket (in
 * `@tula/core`'s closure) where they are.
 */
async function exchange(client: TulaClient, host: ExpoHost): Promise<ProviderOutcome> {
  try {
    return outcomeOf(host, await client.signIn.handleOAuthCallback())
  } catch (error) {
    if (!isRetryableOAuthError(error)) {
      host.forget()
    }
    throw toTulaError(error)
  } finally {
    host.setAddress('')
  }
}

async function roundTrip(
  client: TulaClient,
  input: ProviderSignInInput,
  start: (input: ProviderSignInInput & { navigate: false }) => Promise<{ url: string }>
): Promise<ProviderOutcome> {
  const host = hostOf(client)
  if (!host?.browser) {
    // No browser to open: as a page that cannot keep the binding, before any request.
    throw clientError('storage.failed')
  }
  if (host.roundTrip) {
    throw clientError('flow.busy')
  }
  const { browser } = host
  const { provider, redirectUrl } = input
  host.roundTrip = true
  try {
    // A round trip that never came back is over: its binding goes before a new one is kept.
    host.forget()
    // The client takes the redirect URL for its page while it starts, so that only this
    // call (never `signIn.withOAuth` on the client) gets past its same-origin rule.
    host.setAddress(redirectUrl)
    let url: string
    try {
      ;({ url } = await start({ provider, redirectUrl, navigate: false }))
    } finally {
      host.setAddress('')
    }
    let returned: string | null
    try {
      returned = await browser.open(url, redirectUrl)
    } catch (error) {
      host.forget()
      throw toTulaError(error)
    }
    if (typeof returned !== 'string') {
      host.forget()
      return { status: 'cancelled' }
    }
    // The platforms hand back whatever matched by scheme (iOS) or by prefix (Android): only
    // the redirect URL that was asked for, character for character, with a fragment, is
    // read. Anything else is never sent anywhere.
    const at = returned.indexOf('#')
    if (at === -1 || returned.slice(0, at) !== redirectUrl) {
      host.forget()
      return { status: 'refused', reason: at === -1 ? 'no_answer' : 'unexpected_return' }
    }
    host.setAddress(returned)
    return await exchange(client, host)
  } finally {
    host.roundTrip = false
  }
}

/**
 * Sign in with a provider: start the attempt, open the provider's page in the system
 * browser, and exchange the ticket the browser comes back with.
 *
 * The attempt is started as this app's platform (`ios` or `android`). The binding the server
 * hands out at the start is kept in memory only, and the ticket is honoured only with it: a
 * URL that reaches the app some other way (a link someone sent) completes nothing. Nothing
 * of the round trip (the ticket, the binding, the provider's code) is written to storage, a
 * log, an error or a URL this package builds. One round trip at a time: a second call while
 * the browser is open is `flow.busy`.
 *
 * @param client - A client from `createTulaExpoClient`, created with a `browser`.
 * @param input - The provider and the redirect URL.
 * @returns How the round trip ended.
 * @throws TulaError what the start answered (`request.redirect_not_allowed` with
 *   `params.reason`, `auth.method_disabled`, `rate_limited`), `network.failed` or
 *   `network.timeout` (for the exchange: `retryProviderSignIn` tries it again), `flow.busy`,
 *   `storage.failed` for a client with no browser, and `internal` when the browser module
 *   threw.
 *
 * @example
 * ```ts
 * const outcome = await signInWithProvider(tula, {
 *   provider: 'google',
 *   redirectUrl: 'com.example.app:/oauth/callback',
 * })
 * ```
 */
export function signInWithProvider(
  client: TulaClient,
  input: ProviderSignInInput
): Promise<ProviderOutcome> {
  return roundTrip(client, input, (start) => client.signIn.withOAuth(start))
}

/**
 * Connect a provider account to the signed-in user, by the same round trip. Needs a recent
 * authentication (`auth.step_up_required` otherwise).
 *
 * The server makes this attempt a browser's, so `redirectUrl` must be an `https` app link:
 * a custom scheme is refused (`request.redirect_not_allowed`).
 *
 * @param client - A client from `createTulaExpoClient`, created with a `browser`.
 * @param input - The provider and the redirect URL.
 * @returns How the round trip ended: `linked` with the identity when it worked.
 * @throws TulaError as {@link signInWithProvider}, and `auth.step_up_required`.
 *
 * @example
 * ```ts
 * const outcome = await linkProvider(tula, {
 *   provider: 'github',
 *   redirectUrl: 'https://app.example.com/oauth/callback',
 * })
 * ```
 */
export function linkProvider(
  client: TulaClient,
  input: ProviderSignInInput
): Promise<ProviderOutcome> {
  return roundTrip(client, input, (start) => client.user.identities.link(start))
}

/**
 * Try again the exchange of a round trip whose ticket got no answer (`network.failed`,
 * `network.timeout`, `rate_limited`). The ticket is held for a minute, in memory; after
 * that, or when there is nothing to retry, start again.
 *
 * @param client - The client whose `signInWithProvider` or `linkProvider` threw.
 * @returns How the round trip ended; `refused` with `no_answer` when nothing was waiting.
 * @throws TulaError as the first try.
 *
 * @example
 * ```ts
 * const outcome = await retryProviderSignIn(tula)
 * ```
 */
export async function retryProviderSignIn(client: TulaClient): Promise<ProviderOutcome> {
  const host = hostOf(client)
  if (!host) {
    throw clientError('storage.failed')
  }
  if (host.roundTrip) {
    throw clientError('flow.busy')
  }
  host.roundTrip = true
  try {
    return await exchange(client, host)
  } finally {
    host.roundTrip = false
  }
}
