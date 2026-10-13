// `@tula-tech/expo/plugin`: the Expo config plugin. It runs in Node while an app's configuration
// is read (`expo prebuild`, EAS Build), never in the app, and imports nothing: it is a
// function from one configuration object to another, so it needs no `@expo/config-plugins`
// and is tested on plain objects. It is built as CommonJS, which is how Expo loads a plugin
// (`require`), and as a module beside it for an `import`.

/**
 * What the app's native side needs for Tula, said once.
 *
 * @example
 * ```ts
 * const props: TulaPluginProps = {
 *   domains: ['example.com'],
 *   appLinks: [{ domain: 'app.example.com', paths: ['/oauth/callback'] }],
 *   apple: true,
 *   google: {
 *     webClientId: '1234-abc.apps.googleusercontent.com',
 *     iosClientId: '1234-def.apps.googleusercontent.com',
 *   },
 * }
 * ```
 */
export interface TulaPluginProps {
  /**
   * The domains the app shares credentials with: the relying party of its passkeys
   * (`passkeys.rpId`), where Apple fetches `apple-app-site-association`. Each becomes a
   * `webcredentials:` entry of the iOS Associated Domains entitlement. Android needs
   * nothing in the app for it (it reads the domain's `assetlinks.json`).
   */
  domains?: readonly string[]
  /**
   * The `https` links the app opens itself: where a provider sign-in returns to. Each
   * domain becomes an `applinks:` entry on iOS and, with its paths, a verified intent
   * filter on Android. The paths are exact, as the environment's native app lists them
   * (`appLinkPaths`).
   */
  appLinks?: readonly { readonly domain: string; readonly paths: readonly string[] }[]
  /** Whether the app offers Sign in with Apple: adds the entitlement on iOS. */
  apple?: boolean
  /**
   * The Google OAuth client ids of the app's native sign-in. They are copied to
   * `extra.tula.google`, where the app reads them for `googleSheet(…)`, and on iOS the
   * reversed iOS client id becomes a URL scheme (Google's SDK returns through it) and
   * `GIDClientID` is set. Neither id is a secret.
   */
  google?: { readonly webClientId: string; readonly iosClientId?: string }
}

/** An Android intent filter, as an Expo configuration writes one. */
interface IntentFilter {
  action?: unknown
  autoVerify?: unknown
  data?: unknown
  category?: unknown
}

/** The parts of an Expo configuration this plugin reads and writes. Everything else is kept. */
export interface ExpoConfigLike {
  ios?: {
    associatedDomains?: readonly string[]
    usesAppleSignIn?: boolean
    entitlements?: Readonly<Record<string, unknown>>
    infoPlist?: Readonly<Record<string, unknown>>
    [key: string]: unknown
  }
  android?: {
    intentFilters?: readonly IntentFilter[]
    [key: string]: unknown
  }
  extra?: Readonly<Record<string, unknown>>
  [key: string]: unknown
}

/** A host name: labels of letters, digits and hyphens, at least two, no scheme, port or path. */
const DOMAIN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/i
/** An exact path: segments of unreserved characters, no query, fragment, dot segment or trailing slash. */
const PATH = /^(?:\/[A-Za-z0-9._~-]+)+$/
/** What Google calls an OAuth client id. */
const GOOGLE_CLIENT_ID = /^([A-Za-z0-9-]+)\.apps\.googleusercontent\.com$/

/** A problem with what the plugin was given. It names the option, never its value. */
function refuse(option: string, why: string): never {
  throw new TypeError(`@tula-tech/expo/plugin: \`${option}\` ${why}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function domainsOf(option: string, value: unknown): string[] {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value)) {
    refuse(option, 'must be a list of domain names')
  }
  return value.map((domain: unknown, at) => {
    if (typeof domain !== 'string' || !DOMAIN.test(domain)) {
      refuse(`${option}.${at}`, 'must be a domain name: no scheme, port, path or wildcard')
    }
    return domain.toLowerCase()
  })
}

/** `list` with every entry of `more` it does not hold yet, in order. */
function withEach<T>(list: readonly T[] | undefined, more: readonly T[]): T[] {
  const all = [...(list ?? [])]
  for (const entry of more) {
    if (!all.some((held) => JSON.stringify(held) === JSON.stringify(entry))) {
      all.push(entry)
    }
  }
  return all
}

/**
 * Google's "reversed client id" of an iOS client id: the URL scheme its iOS SDK returns to
 * the app through. `withTula` adds it to the app's URL schemes; a native module whose own
 * plugin asks for it (`react-native-nitro-google-signin`'s `iosUrlScheme`) is given the
 * same value, so the client id is written once.
 *
 * @param iosClientId - The iOS OAuth client id (`….apps.googleusercontent.com`).
 * @returns The scheme, `com.googleusercontent.apps.…`.
 * @throws TypeError for a value that is not a Google client id. It never repeats the value.
 *
 * @example
 * ```ts
 * reversedGoogleClientId('1234-def.apps.googleusercontent.com')
 * // 'com.googleusercontent.apps.1234-def'
 * ```
 */
export function reversedGoogleClientId(iosClientId: string): string {
  const parts = typeof iosClientId === 'string' && GOOGLE_CLIENT_ID.exec(iosClientId)
  if (!parts) {
    refuse('google.iosClientId', 'must be a Google client id (….apps.googleusercontent.com)')
  }
  return `com.googleusercontent.apps.${parts[1]}`
}

/** The URL types of an `Info.plist` with one more scheme, unless it is there. */
function withUrlScheme(types: unknown, scheme: string): unknown[] {
  const list = Array.isArray(types) ? (types as unknown[]) : []
  const held = list.some(
    (type) =>
      isRecord(type) &&
      Array.isArray(type.CFBundleURLSchemes) &&
      type.CFBundleURLSchemes.includes(scheme)
  )
  return held ? list : [...list, { CFBundleURLSchemes: [scheme] }]
}

/**
 * The Expo config plugin of `@tula-tech/expo`: the Associated Domains entitlement, the Android
 * intent filters of the app's links, the Sign in with Apple entitlement and Google's client
 * ids, set from one place.
 *
 * It only adds: what the configuration already holds is kept, an entry that is already
 * there is not added twice (applying the plugin again changes nothing), and the object it
 * was given is not changed. It writes what an Expo configuration can say and no native file
 * itself, so a native module with a plugin of its own (`react-native-nitro-google-signin`
 * patches the iOS Podfile) is still listed beside it. A value that is not what its option
 * takes is refused with a `TypeError` that names the option and never the value.
 *
 * Whether Expo's prebuild turns this configuration into the entitlements, the `Info.plist`
 * and the manifest described here was not run from this repository: see `docs/expo.md`.
 *
 * @param config - The app's Expo configuration.
 * @param props - What the app uses.
 * @returns A new configuration with the native pieces added.
 * @throws TypeError for an option that is not of the shape it takes.
 *
 * @example
 * ```ts
 * // app.config.ts
 * import { withTula } from '@tula-tech/expo/plugin'
 *
 * export default withTula(
 *   { name: 'Example', slug: 'example', ios: { bundleIdentifier: 'com.example.app' } },
 *   { domains: ['example.com'], apple: true }
 * )
 * ```
 */
export function withTula<Config extends ExpoConfigLike>(
  config: Config,
  props: TulaPluginProps = {}
): Config {
  if (!isRecord(config)) {
    refuse('config', 'must be the Expo configuration object')
  }
  if (!isRecord(props)) {
    refuse('props', 'must be an object')
  }
  const domains = domainsOf('domains', props.domains)
  const links = props.appLinks ?? []
  if (!Array.isArray(links)) {
    refuse('appLinks', 'must be a list of `{ domain, paths }`')
  }
  const linkDomains: string[] = []
  const filters: IntentFilter[] = []
  for (const [at, link] of links.entries()) {
    if (!isRecord(link)) {
      refuse(`appLinks.${at}`, 'must be `{ domain, paths }`')
    }
    const [domain] = domainsOf(`appLinks.${at}.domain`, [link.domain]) as [string]
    const { paths } = link
    if (!Array.isArray(paths) || paths.length === 0) {
      refuse(`appLinks.${at}.paths`, 'must list at least one path')
    }
    for (const [index, path] of paths.entries()) {
      if (typeof path !== 'string' || !PATH.test(path) || /(^|\/)\.{1,2}(\/|$)/.test(path)) {
        refuse(
          `appLinks.${at}.paths.${index}`,
          'must be an exact path: no wildcard, query, fragment, dot segment or trailing slash'
        )
      }
    }
    linkDomains.push(domain)
    filters.push({
      action: 'VIEW',
      autoVerify: true,
      data: paths.map((path) => ({ scheme: 'https', host: domain, path })),
      category: ['BROWSABLE', 'DEFAULT'],
    })
  }
  if (props.apple !== undefined && typeof props.apple !== 'boolean') {
    refuse('apple', 'must be true or false')
  }
  const { google } = props
  let iosScheme: string | undefined
  if (google !== undefined) {
    if (
      !isRecord(google) ||
      typeof google.webClientId !== 'string' ||
      !GOOGLE_CLIENT_ID.test(google.webClientId)
    ) {
      refuse('google.webClientId', 'must be a Google client id (….apps.googleusercontent.com)')
    }
    if (google.iosClientId !== undefined) {
      iosScheme = reversedGoogleClientId(google.iosClientId as string)
    }
  }

  const ios = { ...config.ios }
  const associated = withEach(ios.associatedDomains, [
    ...domains.map((domain) => `webcredentials:${domain}`),
    ...linkDomains.map((domain) => `applinks:${domain}`),
  ])
  if (associated.length > 0) {
    ios.associatedDomains = associated
  }
  if (props.apple === true) {
    ios.usesAppleSignIn = true
    ios.entitlements = { ...ios.entitlements, 'com.apple.developer.applesignin': ['Default'] }
  }
  if (google?.iosClientId !== undefined && iosScheme !== undefined) {
    ios.infoPlist = {
      ...ios.infoPlist,
      GIDClientID: google.iosClientId,
      CFBundleURLTypes: withUrlScheme(ios.infoPlist?.CFBundleURLTypes, iosScheme),
    }
  }
  const android = { ...config.android }
  if (filters.length > 0) {
    android.intentFilters = withEach(android.intentFilters, filters)
  }
  const tula = isRecord(config.extra?.tula) ? config.extra.tula : {}
  return {
    ...config,
    ...(Object.keys(ios).length > 0 && { ios }),
    ...(Object.keys(android).length > 0 && { android }),
    ...(google !== undefined && {
      extra: {
        ...config.extra,
        tula: {
          ...tula,
          google: {
            webClientId: google.webClientId,
            ...(google.iosClientId !== undefined && { iosClientId: google.iosClientId }),
          },
        },
      },
    }),
  }
}

// Expo calls what a plugin's module exports by default with `(config, props)`: an app that
// lists `['@tula-tech/expo/plugin', { … }]` under `plugins` reaches the function this way.
export default withTula
