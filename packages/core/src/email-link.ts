import { EMAIL_LINK_ATTEMPT_PARAM, EMAIL_LINK_TOKEN_PARAM } from '@tula/contract/headers'
import type { ChannelLike, Environment } from './environment'
import { isTulaError } from './errors'
import type { SessionManager } from './session'
import type { Transport } from './transport'

/**
 * How long `handleEmailLink` waits, after a link was accepted, for the tab that started the
 * sign-in to finish it and for the session to show up here.
 *
 * @example
 * ```ts
 * await tula.signIn.handleEmailLink({ waitMs: EMAIL_LINK_SESSION_WAIT_MS * 2 })
 * ```
 */
export const EMAIL_LINK_SESSION_WAIT_MS = 4_000

/**
 * How often a sign-in that is waiting for its emailed link to be opened asks the server, when
 * no other tab tells it sooner.
 *
 * @example
 * ```ts
 * const seconds = EMAIL_LINK_POLL_INTERVAL_MS / 1000 // 3
 * ```
 */
export const EMAIL_LINK_POLL_INTERVAL_MS = 3_000

/**
 * How long a link's binding is kept in the browser. A little longer than an attempt lives (ten
 * minutes), and counted on the device's own clock from the moment it is stored: comparing the
 * server's expiry time with a device clock that runs fast would drop the binding at once.
 */
export const LINK_BINDING_TTL_MS = 15 * 60_000

/** Prefix of the `localStorage` entries this module owns: `tula.link.<attempt id>`. */
export const LINK_STORAGE_PREFIX = 'tula.link.'

const CHANNEL_VERSION = 1

/**
 * What became of the emailed sign-in link in the page's address.
 *
 * - `none`: the address carries no link. Nothing was sent.
 * - `signed_in`: the link was accepted and this tab is now signed in.
 * - `verified`: the link was accepted; the tab that started the sign-in finishes it. Shown
 *   when that tab has not done so yet (or was closed, in which case the user starts again).
 * - `different_browser`: the link was opened in a browser that did not ask for it. Nothing was
 *   used up: it still works in the browser that did, and the code in the email works there too.
 * - `expired`: the link is used, replaced or older than ten minutes.
 *
 * @example
 * ```ts
 * const outcome: EmailLinkOutcome = await tula.signIn.handleEmailLink()
 * if (outcome.status === 'different_browser') {
 *   show('Open the link in the browser where you started, or enter the code there.')
 * }
 * ```
 */
export interface EmailLinkOutcome {
  /** What happened. */
  readonly status: 'none' | 'signed_in' | 'verified' | 'different_browser' | 'expired'
}

/**
 * Where a browser keeps the binding of an emailed sign-in link between asking for the link and
 * opening it, so that a new tab of the same browser can present it.
 *
 * **The one thing this SDK puts in `localStorage`.** A binding is not a token and not the
 * attempt's secret: alone it authorizes nothing. It only makes the emailed token usable, and
 * even then the session goes to the tab holding the attempt's secret. An entry is removed when
 * the link is used or the sign-in completes, and after {@link LINK_BINDING_TTL_MS} otherwise.
 */
export interface LinkStore {
  /** @returns Whether a binding can be kept at all (storage exists and accepts writes). */
  available(): boolean
  /**
   * @param attemptId - The sign-in the link belongs to.
   * @param binding - The binding the server returned.
   * @returns Whether it was stored.
   */
  save(attemptId: string, binding: string): boolean
  /**
   * @param attemptId - The sign-in named by the link.
   * @returns Its binding, or `null` when this browser has none (or it has expired).
   */
  read(attemptId: string): string | null
  /** @param attemptId - The sign-in whose binding is no longer needed. */
  remove(attemptId: string): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Build the binding store over the environment's shared storage.
 *
 * Every access is guarded: storage can be missing, full, or refuse access outright (a
 * sandboxed frame, a privacy mode), and none of that may break a sign-in. Without storage the
 * emailed link simply cannot be used; the code in the same email still can.
 *
 * @param environment - The runtime: its shared storage and clock.
 * @param scope - Names the API and environment, so two apps on one origin never read each
 *   other's entries.
 * @returns The store.
 */
export function createLinkStore(
  environment: Pick<Environment, 'linkStorage' | 'now'>,
  scope: string
): LinkStore {
  const storage = environment.linkStorage
  const keyOf = (attemptId: string) => `${LINK_STORAGE_PREFIX}${attemptId}`

  /** A stored entry's binding, when the entry is this client's and still alive. */
  function parse(raw: string | null): string | null {
    if (raw === null) {
      return null
    }
    let entry: unknown
    try {
      entry = JSON.parse(raw)
    } catch {
      return null
    }
    return isRecord(entry) &&
      typeof entry.b === 'string' &&
      typeof entry.e === 'number' &&
      entry.s === scope &&
      entry.e > environment.now()
      ? entry.b
      : null
  }

  /** Remove every entry of this module that is no longer alive, whoever wrote it. */
  function prune(): void {
    if (!storage) {
      return
    }
    const stale: string[] = []
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index)
      if (key?.startsWith(LINK_STORAGE_PREFIX)) {
        let expiry: unknown
        try {
          expiry = (JSON.parse(storage.getItem(key) ?? 'null') as { e?: unknown } | null)?.e
        } catch {
          expiry = undefined
        }
        if (typeof expiry !== 'number' || expiry <= environment.now()) {
          stale.push(key)
        }
      }
    }
    for (const key of stale) {
      storage.removeItem(key)
    }
  }

  function guarded<T>(work: () => T, fallback: T): T {
    try {
      return work()
    } catch {
      return fallback
    }
  }

  return {
    available: () =>
      guarded(() => {
        if (!storage) {
          return false
        }
        const probe = `${LINK_STORAGE_PREFIX}probe`
        storage.setItem(probe, '1')
        storage.removeItem(probe)
        return true
      }, false),
    save: (attemptId, binding) =>
      guarded(() => {
        if (!storage) {
          return false
        }
        prune()
        const expiry = environment.now() + LINK_BINDING_TTL_MS
        storage.setItem(keyOf(attemptId), JSON.stringify({ b: binding, e: expiry, s: scope }))
        return true
      }, false),
    read: (attemptId) =>
      guarded(() => {
        prune()
        return storage ? parse(storage.getItem(keyOf(attemptId))) : null
      }, null),
    remove(attemptId) {
      guarded(() => storage?.removeItem(keyOf(attemptId)), undefined)
    },
  }
}

/** What an emailed link's fragment carries, and the page's URL without it. */
export interface LinkFragment {
  token: string
  attemptId: string
  /** The page's URL with the link's parameters removed from the fragment. */
  cleanUrl: string
}

/**
 * Read an emailed sign-in link out of a page URL's fragment.
 *
 * @param url - The page's full URL.
 * @returns The token, the attempt id and the URL without them; `null` when the fragment does
 *   not carry both.
 *
 * @example
 * ```ts
 * readLinkFragment('https://app.example.com/link#tula_link=abc&tula_attempt=0199…')
 * // { token: 'abc', attemptId: '0199…', cleanUrl: 'https://app.example.com/link' }
 * ```
 */
export function readLinkFragment(url: string): LinkFragment | null {
  const at = url.indexOf('#')
  if (at === -1) {
    return null
  }
  const fragment = new URLSearchParams(url.slice(at + 1))
  const token = fragment.get(EMAIL_LINK_TOKEN_PARAM)
  const attemptId = fragment.get(EMAIL_LINK_ATTEMPT_PARAM)
  if (!token || !attemptId) {
    return null
  }
  fragment.delete(EMAIL_LINK_TOKEN_PARAM)
  fragment.delete(EMAIL_LINK_ATTEMPT_PARAM)
  const rest = fragment.toString()
  return { token, attemptId, cleanUrl: `${url.slice(0, at)}${rest ? `#${rest}` : ''}` }
}

/**
 * Open the channel on which a tab that accepted a link tells the tab waiting for it.
 *
 * The message names an attempt and nothing else. It is only a nudge: the waiting tab asks the
 * server, which alone decides whether the link was accepted.
 *
 * @param environment - The runtime.
 * @param scope - Names the API and environment.
 * @returns The channel, or `undefined` where there is none (the waiting tab then just polls).
 */
export function openLinkChannel(
  environment: Pick<Environment, 'createChannel'>,
  scope: string
): ChannelLike | undefined {
  try {
    return environment.createChannel?.(`tula-link:${scope}`)
  } catch {
    return undefined
  }
}

/**
 * @param data - A message received on the link channel.
 * @param attemptId - The attempt the receiver is waiting on.
 * @returns Whether the message says that attempt's link was accepted.
 */
export function isLinkAccepted(data: unknown, attemptId: string): boolean {
  return (
    isRecord(data) &&
    data.v === CHANNEL_VERSION &&
    data.type === 'link-accepted' &&
    data.attemptId === attemptId
  )
}

/** What {@link handleEmailLink} is built from. */
export interface EmailLinkContext {
  transport: Transport
  session: SessionManager
  environment: Environment
  links: LinkStore
  scope: string
}

/** Resolve `true` once this client is signed in, or with one last look when `waitMs` is over. */
function sessionAppears(context: EmailLinkContext, waitMs: number): Promise<boolean> {
  const { session, environment } = context
  if (session.state().status === 'signed-in') {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    let settled = false
    const settle = (signedIn: boolean) => {
      if (!settled) {
        settled = true
        stop()
        cancel()
        resolve(signedIn)
      }
    }
    const stop = session.subscribe((state) => {
      if (state.status === 'signed-in') {
        settle(true)
      }
    })
    const cancel = environment.setTimer(() => {
      // The other tab's message may have been missed (no channel); the cookie, if the sign-in
      // was finished, has not. One refresh settles it either way.
      session.refresh().then(
        (token) => settle(token !== null),
        () => settle(false)
      )
    }, waitMs)
  })
}

/**
 * Handle the emailed sign-in link in the page's address, if there is one.
 *
 * The link's token and attempt id are read from the URL fragment, which is then removed from
 * the address bar and the history entry **before** anything is sent, so a token never lingers
 * in a URL. They are posted, with this browser's binding for that attempt, to the API. Opening
 * a link never signs the opening tab in by itself: the tab that started the sign-in holds the
 * attempt's secret and finishes it, and this tab then picks the session up from it.
 *
 * @param context - Transport, session, runtime and the binding store.
 * @param options - `waitMs`: how long to wait for the session to appear after the link was
 *   accepted.
 * @returns What became of the link.
 * @throws TulaError when the API could not be reached or refused for another reason
 *   (`rate_limited`, `request.origin_not_allowed`, `auth.method_disabled`).
 */
export async function handleEmailLink(
  context: EmailLinkContext,
  options: { waitMs?: number } = {}
): Promise<EmailLinkOutcome> {
  const { environment, links, transport } = context
  const page = environment.page
  const link = page ? readLinkFragment(page.url()) : null
  if (!page || !link) {
    return { status: 'none' }
  }
  try {
    page.replaceUrl(link.cleanUrl)
  } catch {
    // The address cannot be rewritten here (a sandboxed frame). The token is single use and
    // about to be spent, so go on.
  }
  const binding = links.read(link.attemptId)
  try {
    await transport.call('verifySignInLink', {
      body: {
        token: link.token,
        attemptId: link.attemptId,
        ...(binding !== null && { binding }),
      },
    })
  } catch (error) {
    if (isTulaError(error) && error.code === 'verification.different_browser') {
      return { status: 'different_browser' }
    }
    if (isTulaError(error) && error.code === 'verification.expired') {
      links.remove(link.attemptId)
      return { status: 'expired' }
    }
    throw error
  }
  links.remove(link.attemptId)
  const channel = openLinkChannel(environment, context.scope)
  try {
    channel?.postMessage({ v: CHANNEL_VERSION, type: 'link-accepted', attemptId: link.attemptId })
  } catch {
    // Best effort: without the nudge the waiting tab finds out on its next poll.
  }
  channel?.close?.()
  const signedIn = await sessionAppears(context, options.waitMs ?? EMAIL_LINK_SESSION_WAIT_MS)
  return { status: signedIn ? 'signed_in' : 'verified' }
}
