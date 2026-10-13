import type { FlowStep, SignInFlow, TulaClient, TulaError } from '@tula/core'
import { clientError, toTulaError } from './errors'
import { type ExpoHost, hostOf } from './host'

// Signing in with an emailed link from an app (ADR 0055): `@tula/core` asks for the link,
// keeps its binding and presents the link; this module decides whether a URL the app was
// opened with is worth a request at all, and has the sign-in that asked finish itself.

/**
 * The two names an emailed link's fragment carries. They mirror the contract's
 * `EMAIL_LINK_TOKEN_PARAM` and `EMAIL_LINK_ATTEMPT_PARAM`, which this package cannot import
 * at run time (a test holds them equal).
 */
export const EMAIL_LINK_PARAMS = { token: 'tula_link', attempt: 'tula_attempt' } as const

/**
 * What became of a URL the app was opened with.
 *
 * - `accepted`: the server took the link, and the sign-in that asked for it was asked to
 *   finish. `step` is where it stands: `complete` (signed in), or what the server asks for
 *   next (a second factor). With `failure`, the link was taken but the sign-in could not be
 *   asked (no network, say): the link is spent, `step` is unchanged, and
 *   `flow.attemptFirstFactor({ strategy: 'email_link' })` asks again.
 * - `expired`: the link is used, replaced by a newer email, or older than ten minutes.
 *   "Used" includes used by this client a moment ago, when the server took the link and
 *   its answer was lost: `flow.attemptFirstFactor({ strategy: 'email_link' })` then
 *   finishes the sign-in, and for a link nobody opened leaves the step as it was.
 * - `refused`: nothing was sent to the server, and nothing was used up:
 *   `unexpected_url` (not the app link this client asks for, character for character,
 *   followed by a fragment), `no_link` (that URL, with no link in its fragment) or
 *   `not_started_here` (a link of a sign-in this client is not in the middle of: asked for
 *   on another device, in another app, or before this app was ended and started again; and
 *   a link the server says another client asked for).
 *
 * @example
 * ```ts
 * const outcome: EmailLinkOutcome = await openEmailLink(tula, flow, url)
 * if (outcome.status === 'accepted' && outcome.step.status === 'complete') showHome()
 * ```
 */
export type EmailLinkOutcome =
  | { readonly status: 'accepted'; readonly step: FlowStep; readonly failure?: TulaError }
  | { readonly status: 'expired' }
  | {
      readonly status: 'refused'
      readonly reason: 'unexpected_url' | 'no_link' | 'not_started_here'
    }

/** What a URL is, before anything is sent: a link of an attempt, or why it is not read. */
type Judged =
  | { readonly attemptId: string }
  | { readonly reason: 'unexpected_url' | 'no_link' | 'not_started_here' }

/**
 * Judge a URL the app was opened with, by string work alone: nothing is sent and nothing
 * is kept.
 *
 * Only the app link this client asks for is read: character for character, followed by `#`.
 * Nothing is normalised on either side (a platform hands an app whatever URL matched its
 * association, by host and path prefix). The fragment is read as `@tula/core` reads it, so
 * the attempt judged here is the attempt the client then sends.
 */
function judge(host: ExpoHost, url: unknown): Judged {
  const expected = host.emailLinkUrl
  if (typeof url !== 'string' || expected === undefined) {
    return { reason: 'unexpected_url' }
  }
  const at = url.indexOf('#')
  if (at === -1 || url.slice(0, at) !== expected) {
    return { reason: 'unexpected_url' }
  }
  const fragment = new URLSearchParams(url.slice(at + 1))
  const attemptId = fragment.get(EMAIL_LINK_PARAMS.attempt)
  if (!fragment.get(EMAIL_LINK_PARAMS.token) || !attemptId) {
    return { reason: 'no_link' }
  }
  // No binding for it in this client: opened on a device, or in an app, that did not ask.
  // The server would answer the same and spend nothing; it is not asked at all.
  return host.linkKept(attemptId) ? { attemptId } : { reason: 'not_started_here' }
}

/**
 * Whether a URL the app was opened with is this client's emailed-link URL with a link in
 * it: what {@link openEmailLink} would look further at. An app that is opened with other
 * links too asks here before it shows anything about a sign-in. Nothing is sent.
 *
 * @param client - A client from `createTulaExpoClient`.
 * @param url - The URL the app was opened with.
 * @returns `true` for the client's app link, exactly, with a link in its fragment.
 *
 * @example
 * ```ts
 * if (isEmailLink(tula, url)) await signIn.openEmailLink(url)
 * ```
 */
export function isEmailLink(client: TulaClient, url: unknown): boolean {
  const host = hostOf(client)
  if (!host) {
    return false
  }
  const judged = judge(host, url)
  return 'attemptId' in judged || judged.reason === 'not_started_here'
}

/**
 * Ask for the emailed sign-in link of a sign-in (step `needs_first_factor` offering
 * `email_link`). The link leads to the app link the client was created with
 * (`emailLinkUrl`) and to nowhere else: a link asked for with another URL would never be
 * read by this app.
 *
 * The server hands the client a binding for the link, which is kept in memory only, for
 * fifteen minutes at most: never in the secure store, a file, a log line, an error or a
 * URL. The email also carries a 6-digit code, which works on any device.
 *
 * @param client - A client from `createTulaExpoClient`, created with `emailLinkUrl`.
 * @param flow - The sign-in, from `client.signIn.start`.
 * @returns The step, with `prepared` saying where the email went (masked).
 * @throws TulaError `storage.failed`, before any request, for a client with no
 *   `emailLinkUrl`; what the server answered otherwise (`request.redirect_not_allowed` for
 *   an app link the environment does not list, `auth.method_disabled`, `rate_limited`).
 *
 * @example
 * ```ts
 * const flow = await tula.signIn.start({ identifier: email })
 * await requestEmailLink(tula, flow)
 * ```
 */
export async function requestEmailLink(client: TulaClient, flow: SignInFlow): Promise<FlowStep> {
  const redirectUrl = hostOf(client)?.emailLinkUrl
  if (redirectUrl === undefined) {
    throw clientError('storage.failed')
  }
  return flow.prepareFirstFactor({ strategy: 'email_link', redirectUrl })
}

/**
 * Open an emailed sign-in link the app was opened with, and have the sign-in that asked
 * for it finish.
 *
 * A URL is sent to the server only when all of this holds, and is otherwise refused
 * without a request: it is the client's app link, character for character, followed by a
 * fragment; the fragment carries a link; the link names `flow`; and this client still
 * keeps the binding the server gave it when `flow` asked. So a link opened on another
 * device, in another app, or after this app was ended and started again proves nothing and
 * spends nothing: it still works where it was asked for, and so does the code in the same
 * email.
 *
 * The server's acceptance of a link signs nobody in. `flow` holds the attempt's secret, in
 * memory, and is the one that finishes: it is asked once, right after the link was taken.
 * Nothing of the link (its token, its binding) is written to storage, a log, an error or a
 * URL this package builds.
 *
 * @param client - A client from `createTulaExpoClient`, created with `emailLinkUrl`.
 * @param flow - The sign-in that asked for the link.
 * @param url - The whole URL the app was opened with, fragment included.
 * @returns What became of it.
 * @throws TulaError `storage.failed` for a client with no `emailLinkUrl`; `flow.busy`
 *   while another link, or a provider's round trip, is under way; and what the server or
 *   the network answered to the link. A refusal the server sent (`rate_limited`,
 *   `auth.method_disabled`) spent nothing, and the same URL can be opened again. **A
 *   request that got no answer (`network.failed`, `network.timeout`) may have been taken
 *   all the same**: the link may be spent, and opening the URL again then answers
 *   `expired`. Nothing is asked on a guess. After either, ask the flow to finish
 *   (`flow.attemptFirstFactor({ strategy: 'email_link' })`, the hook's
 *   `finishEmailLink()`): it completes a sign-in whose link was taken, and otherwise
 *   leaves the step unchanged, with nothing counted against the attempt.
 *
 * @example
 * ```ts
 * const outcome = await openEmailLink(tula, flow, url)
 * ```
 */
export async function openEmailLink(
  client: TulaClient,
  flow: SignInFlow,
  url: string
): Promise<EmailLinkOutcome> {
  const host = hostOf(client)
  if (host?.emailLinkUrl === undefined) {
    throw clientError('storage.failed')
  }
  if (host.roundTrip) {
    // The client has one address: a provider's round trip, or another link, has it.
    throw clientError('flow.busy')
  }
  const judged = judge(host, url)
  if ('reason' in judged) {
    return { status: 'refused', reason: judged.reason }
  }
  if (judged.attemptId !== flow.id) {
    // A link of another sign-in of this client: the one given here could not finish it.
    return { status: 'refused', reason: 'not_started_here' }
  }
  host.roundTrip = true
  try {
    // The client reads the link from its page's address, takes it out of the address
    // before anything is sent, and presents it with the binding it kept.
    host.setAddress(url)
    let answer: { status: string }
    try {
      // No wait for a session to appear: the flow below is what makes one.
      answer = await client.signIn.handleEmailLink({ waitMs: 0 })
    } catch (error) {
      // With no answer the link may have been taken all the same. The flow is not asked
      // on that guess: the caller is told, and asks it to finish when it chooses.
      throw toTulaError(error)
    } finally {
      host.setAddress('')
    }
    switch (answer.status) {
      case 'signed_in':
      case 'verified':
        break
      case 'expired':
        return { status: 'expired' }
      case 'different_browser':
        return { status: 'refused', reason: 'not_started_here' }
      default:
        return { status: 'refused', reason: 'no_link' }
    }
    try {
      return { status: 'accepted', step: await flow.attemptFirstFactor({ strategy: 'email_link' }) }
    } catch (error) {
      return { status: 'accepted', step: flow.step, failure: toTulaError(error) }
    }
  } finally {
    host.roundTrip = false
  }
}
