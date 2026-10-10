import type { OAUTH_PROVIDERS } from './oauth'

// Where a flow may send the user back to (ADR 0044). Plain data and string work: no Zod, so
// the native SDKs and a settings screen can use the same rules the server does.
//
// A redirect URL is one of three kinds:
//
// - `https`: a web page, or an **app link** (a universal link on iOS, an App Link on
//   Android): an https URL the platform hands to an app because the domain's association
//   file says so (ADR 0040).
// - `loopback`: `http` on this machine, for development.
// - `custom_scheme`: `com.example.app:/oauth`. Any app on a device can claim a scheme, which
//   is why this kind has rules of its own ({@link customSchemeRedirectRefusal}).
//
// Whatever its kind, a URL is allowed for an environment only when it is, character for
// character, an entry of `urls.allowedRedirectUrls`.

type ProviderName = (typeof OAUTH_PROVIDERS)[number]

/**
 * Schemes that are never a custom-scheme redirect, whatever follows the colon: the two web
 * schemes (which have rules of their own) and the ones a browser or an operating system
 * handles itself, where a redirect would run script, open a file, start a call or hand the
 * URL to something that is nobody's app.
 *
 * A closed list. Most of it is refused a second time by the rule that a custom scheme
 * contains a full stop; it is stated anyway, so that neither rule is the only one.
 *
 * @example
 * ```ts
 * REDIRECT_SCHEMES_NEVER_CUSTOM.includes('javascript') // true
 * ```
 */
export const REDIRECT_SCHEMES_NEVER_CUSTOM = [
  'http',
  'https',
  'javascript',
  'vbscript',
  'data',
  'file',
  'filesystem',
  'blob',
  'about',
  'mailto',
  'tel',
  'sms',
  'facetime',
  'geo',
  'maps',
  'intent',
  'content',
  'android-app',
  'market',
  'itms',
  'itms-apps',
  'itms-services',
  'app-settings',
  'ms-settings',
  'x-apple.systempreferences',
  'ftp',
  'ws',
  'wss',
  'chrome',
  'chrome-extension',
  'moz-extension',
  'resource',
  'jar',
  'cid',
  'mid',
  'view-source',
] as const

/**
 * The kinds of redirect URL an environment may list.
 *
 * @example
 * ```ts
 * const kind: RedirectUrlKind = 'custom_scheme'
 * ```
 */
export type RedirectUrlKind = 'https' | 'loopback' | 'custom_scheme'

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])

// A scheme in reverse-domain form (RFC 8252 section 7.1): lower-case labels of letters,
// digits and hyphens joined by full stops, at least two of them, the first starting with a
// letter. One character class per label and nothing optional inside a repetition: linear.
const CUSTOM_SCHEME = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/

// What may follow the colon: segments of unreserved characters (RFC 3986), each after a
// slash. `//host/path` is an empty first segment and reads the same way. No `@`, `:`, `?`,
// `#`, `%`, `*`, `\`, space or anything outside ASCII can occur, so there is no user name,
// port, query, fragment, encoded octet, wildcard or hidden character to judge separately.
const CUSTOM_REST = /^(?:\/[A-Za-z0-9._~-]*)+$/

function customSchemeOf(value: string): string | null {
  const colon = value.indexOf(':')
  if (colon <= 0) {
    return null
  }
  const scheme = value.slice(0, colon)
  const rest = value.slice(colon + 1)
  if (
    !CUSTOM_SCHEME.test(scheme) ||
    (REDIRECT_SCHEMES_NEVER_CUSTOM as readonly string[]).includes(scheme) ||
    !CUSTOM_REST.test(rest) ||
    // A browser's URL parser resolves dot segments; what is listed must be what arrives.
    rest.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    return null
  }
  return scheme
}

function webKindOf(value: string): 'https' | 'loopback' | null {
  // Written out in full and in lower case: `https:/host` and `HTTPS://host` parse as URLs,
  // and an entry is compared as the string it is.
  if (!(value.startsWith('https://') || value.startsWith('http://'))) {
    return null
  }
  if (value.includes('*') || /\s/.test(value)) {
    return null
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    return null
  }
  if (url.protocol === 'https:') {
    return 'https'
  }
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname) ? 'loopback' : null
}

/**
 * Which kind of redirect URL `value` is, or `null` when an environment may not list it.
 *
 * - `https`: any absolute URL that starts with `https://` (lower case) and has no
 *   credentials, fragment, wildcard or whitespace. A query is allowed. An app link is one
 *   of these.
 * - `loopback`: the same over `http://` for `localhost`, `127.0.0.1` and `[::1]`.
 * - `custom_scheme`: `<scheme>:/<path>` or `<scheme>://<host>/<path>` where the scheme is in
 *   reverse-domain form (lower case, **with a full stop**: `com.example.app`), is not one of
 *   {@link REDIRECT_SCHEMES_NEVER_CUSTOM}, and what follows is slashes and the characters
 *   `A-Z a-z 0-9 . _ ~ -` only. So: no user name or password, no port, **no query**, no
 *   fragment (the server adds one), no wildcard, no percent-encoded octet, no `.` or `..`
 *   segment, and no control or invisible character.
 *
 * Nothing is normalised, for any kind: the string that is listed is the string a request
 * must send, character for character.
 *
 * @param value - A URL as an operator wrote it.
 * @returns Its kind, or `null`.
 *
 * @example
 * ```ts
 * redirectUrlKind('com.example.app:/oauth') // 'custom_scheme'
 * redirectUrlKind('myapp://callback') // null: no full stop in the scheme
 * redirectUrlKind('javascript:alert(1)') // null
 * ```
 */
export function redirectUrlKind(value: string): RedirectUrlKind | null {
  // The two web schemes are judged by their own rule and by no other.
  if (/^https?:/i.test(value)) {
    return webKindOf(value)
  }
  return customSchemeOf(value) === null ? null : 'custom_scheme'
}

/**
 * Whether an environment may list `value` in `urls.allowedRedirectUrls`.
 *
 * @param value - A URL as an operator wrote it.
 * @returns `true` for any {@link RedirectUrlKind}.
 *
 * @example
 * ```ts
 * isRedirectUrl('https://app.example.com/oauth/callback') // true
 * ```
 */
export function isRedirectUrl(value: string): boolean {
  return redirectUrlKind(value) !== null
}

/**
 * Whether `value` is a custom-scheme redirect URL ({@link redirectUrlKind}).
 *
 * @param value - A URL.
 * @returns `true` only for the `custom_scheme` kind.
 *
 * @example
 * ```ts
 * isCustomSchemeRedirectUrl('com.example.app:/oauth') // true
 * isCustomSchemeRedirectUrl('https://app.example.com/oauth') // false
 * ```
 */
export function isCustomSchemeRedirectUrl(value: string): boolean {
  return redirectUrlKind(value) === 'custom_scheme'
}

/**
 * The providers whose authorization code Tula binds to the attempt with PKCE (ADR 0026): the
 * code is redeemable only with the verifier the attempt holds.
 *
 * @example
 * ```ts
 * OAUTH_PROVIDERS_WITH_PKCE.includes('google') // true
 * ```
 */
export const OAUTH_PROVIDERS_WITH_PKCE = [
  'google',
  'github',
  'microsoft',
  'discord',
  'x',
] as const satisfies readonly ProviderName[]

/**
 * The providers that do **not** bind their code with PKCE, as a fact about the provider and
 * not a setting: Apple and LinkedIn document none, and Facebook's has it only in a flow that
 * is not used (ADR 0026).
 *
 * A provider sign-in with one of them is never returned to a custom scheme
 * ({@link customSchemeRedirectRefusal}). A new provider is added to this list or to
 * {@link OAUTH_PROVIDERS_WITH_PKCE}; a test fails for one that is in neither.
 *
 * @example
 * ```ts
 * OAUTH_PROVIDERS_WITHOUT_PKCE.includes('apple') // true
 * ```
 */
export const OAUTH_PROVIDERS_WITHOUT_PKCE = [
  'apple',
  'linkedin',
  'facebook',
] as const satisfies readonly ProviderName[]

/**
 * Whether a provider's code is bound to the attempt with PKCE
 * ({@link OAUTH_PROVIDERS_WITH_PKCE}). The one place that says so.
 *
 * @param provider - A provider's name.
 * @returns `true` only for a provider on the list; `false` for any other string.
 *
 * @example
 * ```ts
 * bindsCodeWithPkce('google') // true
 * bindsCodeWithPkce('apple') // false
 * ```
 */
export function bindsCodeWithPkce(provider: string): boolean {
  return (OAUTH_PROVIDERS_WITH_PKCE as readonly string[]).includes(provider)
}

/**
 * Why a listed custom-scheme redirect URL is still refused for one request, as the fixed word
 * in `params.reason` of `request.redirect_not_allowed`:
 *
 * - `provider_without_pkce`: the provider's code is not bound with PKCE.
 * - `client_not_native`: the attempt was not started as a native client (`x-tula-client: ios` or
 *   `android`).
 * - `not_a_provider_sign_in`: the redirect is not for a provider sign-in (an emailed link).
 *
 * @example
 * ```ts
 * const reason: CustomSchemeRedirectRefusal = CUSTOM_SCHEME_REDIRECT_REFUSALS[0]
 * ```
 */
export const CUSTOM_SCHEME_REDIRECT_REFUSALS = [
  'provider_without_pkce',
  'client_not_native',
  'not_a_provider_sign_in',
] as const

/** One of {@link CUSTOM_SCHEME_REDIRECT_REFUSALS}. */
export type CustomSchemeRedirectRefusal = (typeof CUSTOM_SCHEME_REDIRECT_REFUSALS)[number]

/**
 * Why a redirect to `url` is refused for this use although the environment lists it, or
 * `null` when it is not.
 *
 * Only a custom-scheme URL is ever refused here. Any app on the device can claim a scheme,
 * so the app that receives the redirect may be another one. What then keeps a sign-in from
 * being completed by it:
 *
 * - the provider's code is bound with PKCE, so a provider that is told to return to the
 *   scheme's owner cannot be made to hand a usable code to someone else. Without PKCE the
 *   redirect is refused, whatever else holds;
 * - the attempt belongs to a native client. A browser page has no use for a custom scheme,
 *   and a `web` attempt ends in cookies.
 *
 * It depends on the URL, the provider and the client kind, never on a user.
 *
 * @param url - A redirect URL the environment lists.
 * @param use - The client kind of the attempt, and the provider when it is a provider
 *   sign-in.
 * @returns The reason, or `null`.
 *
 * @example
 * ```ts
 * customSchemeRedirectRefusal('com.example.app:/oauth', { client: 'ios', provider: 'apple' })
 * // 'provider_without_pkce'
 * ```
 */
export function customSchemeRedirectRefusal(
  url: string,
  use: { client: string; provider?: string }
): CustomSchemeRedirectRefusal | null {
  if (!isCustomSchemeRedirectUrl(url)) {
    return null
  }
  if (use.provider === undefined) {
    return 'not_a_provider_sign_in'
  }
  if (!bindsCodeWithPkce(use.provider)) {
    return 'provider_without_pkce'
  }
  return use.client === 'ios' || use.client === 'android' ? null : 'client_not_native'
}
