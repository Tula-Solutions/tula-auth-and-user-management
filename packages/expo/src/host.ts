import type {
  DeviceKeySource,
  Environment,
  IdTokenProvider,
  LinkStorageLike,
  PageLike,
  PasskeyCreationOptions,
  PasskeyProvider,
  PasskeyRequestOptions,
  TulaClient,
} from '@tula/core'
import { clientError } from './errors'
import { realSchedule, type Schedule } from './secure-storage'

// What an Expo client has in place of a browser: a passkey sheet where a page has
// `navigator.credentials`, a system browser session where a page navigates, and memory
// where a tab has `sessionStorage`. Nothing here imports a native module: the sheets and the
// browser are handed in (`@tula/expo/passkeys`, `@tula/expo/browser`, `@tula/expo/google`,
// `@tula/expo/apple`, or an app's own).

/**
 * The platform's passkey sheet, as this package asks for it: Apple's authorization API on
 * iOS, Credential Manager on Android, through whatever native module the app has.
 * `@tula/expo/passkeys` is one over `react-native-passkey`; an app may write its own.
 *
 * Both calls take the options exactly as the API issued them (WebAuthn's JSON forms, binary
 * values as base64url) and resolve with the credential in WebAuthn's JSON form. **How a call
 * fails is said by the rejection's `name`**, as a browser says it: `NotAllowedError` when
 * the user dismissed the sheet, `InvalidStateError` when the device already holds a passkey
 * of the account, `NotSupportedError` where the platform has none; anything else is a
 * failure. Nothing else of a rejection is read, and its message is never shown.
 *
 * @example
 * ```ts
 * const sheet: PasskeySheet = {
 *   isSupported: () => true,
 *   create: (options) => MyModule.createPasskey(options),
 *   get: (options) => MyModule.getPasskey(options),
 * }
 * ```
 */
export interface PasskeySheet {
  /** Whether this device can use a passkey at all. Left out, it can. */
  isSupported?(): boolean
  /**
   * Make a passkey.
   *
   * @param options - The creation options, as the API issued them.
   * @returns The registration, in WebAuthn's JSON form.
   */
  create(options: PasskeyCreationOptions): Promise<unknown>
  /**
   * Ask for a passkey.
   *
   * @param options - The request options, as the API issued them.
   * @returns The assertion, in WebAuthn's JSON form.
   */
  get(options: PasskeyRequestOptions): Promise<unknown>
}

/**
 * The system browser's authentication session, as this package asks for it
 * (`ASWebAuthenticationSession` on iOS, a Custom Tab on Android). `@tula/expo/browser` is
 * one over `expo-web-browser`; an app may write its own.
 *
 * @example
 * ```ts
 * const browser: BrowserSession = {
 *   async open(url, redirectUrl) {
 *     const result = await WebBrowser.openAuthSessionAsync(url, redirectUrl)
 *     return result.type === 'success' ? result.url : null
 *   },
 * }
 * ```
 */
export interface BrowserSession {
  /**
   * Open `authorizationUrl` and wait until the browser is sent to `redirectUrl` or closed.
   *
   * @param authorizationUrl - The provider's page, from the API. Always `http(s)`.
   * @param redirectUrl - Where the round trip ends: the app's link or custom scheme.
   * @returns The whole URL the browser was sent to, fragment included, or `null` when the
   *   user closed the browser first. What it returns is checked by the caller: it need not
   *   be `redirectUrl` (the platforms match by scheme or by prefix).
   */
  open(authorizationUrl: string, redirectUrl: string): Promise<string | null>
}

/**
 * What a provider's native sign-in sheet hands the app.
 *
 * @example
 * ```ts
 * const credential: IdTokenCredential = { idToken, givenName: 'Maya' }
 * ```
 */
export interface IdTokenCredential {
  /** The provider's ID token (a JWT), exactly as the sheet returned it. */
  idToken: string
  /** The given name the sheet handed over, where it hands one over (Apple, once). */
  givenName?: string | undefined
  /** The family name the sheet handed over. */
  familyName?: string | undefined
}

/**
 * A provider's native sign-in sheet, as this package asks for it: Sign in with Apple's
 * sheet, or Google's account sheet. `@tula/expo/apple` is one over
 * `expo-apple-authentication` and `@tula/expo/google` one over
 * `react-native-nitro-google-signin`; an app may write its own.
 *
 * The sheet is given a nonce and must put it into its request **unchanged**: this package
 * has already made it what the provider's token must carry (for Apple the SHA-256 of the
 * server's nonce, for Google the server's nonce itself).
 *
 * @example
 * ```ts
 * const sheet: IdTokenSheet = {
 *   isAvailable: () => MyModule.isAvailable(),
 *   async signIn({ nonce }) {
 *     const result = await MyModule.signIn({ nonce })
 *     return result.cancelled ? null : { idToken: result.idToken }
 *   },
 * }
 * ```
 */
export interface IdTokenSheet {
  /**
   * Whether the sheet can be shown here: the native module is in the build and the device
   * has the provider's sign-in. Asked each time, never when the client is created; a sheet
   * that cannot say answers `false`.
   */
  isAvailable(): boolean | Promise<boolean>
  /**
   * Show the sheet.
   *
   * @param request - The nonce to hand the provider, unchanged.
   * @returns What the sheet handed over, or `null` when the user dismissed it. A rejection
   *   is a failure.
   */
  signIn(request: { nonce: string }): Promise<IdTokenCredential | null>
}

/** A rejection that says only its `name`, as a browser's `DOMException` does. */
function named(name: string): Error {
  return Object.assign(new Error(name), { name })
}

/**
 * The longest a passkey sheet holds its place: the lifetime of the challenge it answers.
 * It mirrors the contract's `PASSKEY_CHALLENGE_TTL_MS` (five minutes; a test holds the two
 * equal), which this package cannot import at run time: an answer that comes later than
 * that is for a challenge the server no longer has.
 */
export const PASSKEY_SHEET_CEILING_MS = 300_000

/**
 * Hold a passkey sheet to one request at a time.
 *
 * A platform shows one passkey sheet, and each request answers one challenge: a second
 * request is **refused**, never joined to the first (its answer would be for another
 * challenge) and never queued. The place stays taken until the sheet itself has answered,
 * also when the caller's signal gave the wait up: the sheet may still be on screen.
 *
 * **A sheet that never answers does not hold the place for ever.** A native promise can
 * be left unsettled (an app sent to the background while the sheet is up). After
 * {@link PASSKEY_SHEET_CEILING_MS} the wait ends as a ceremony nobody answered in time
 * (`NotAllowedError`, as a browser says it), the place is free, and whatever the abandoned
 * sheet answers later is dropped: it is never handed to anyone.
 *
 * @param sheet - The platform's passkey sheet.
 * @param schedule - How the ceiling is waited for. The runtime's timers when left out.
 * @returns The provider `@tula/core` asks, and whether a sheet holds the place right now.
 */
export function oneAtATime(
  sheet: PasskeySheet,
  schedule: Schedule = realSchedule
): PasskeyProvider & { held(): boolean } {
  // The request that holds the place, or `null`. An identity and not a flag: a sheet that
  // answers after the ceiling must not free the place of the request that came after it.
  let holder: object | null = null
  const ask =
    <Options>(call: (options: Options) => Promise<unknown>) =>
    (options: Options, request: { signal?: AbortSignal }): Promise<unknown> => {
      const { signal } = request
      if (holder || signal?.aborted) {
        return Promise.reject(named('AbortError'))
      }
      const mine = {}
      holder = mine
      const release = () => {
        if (holder === mine) {
          holder = null
        }
      }
      let answer: Promise<unknown>
      try {
        answer = Promise.resolve(call(options))
      } catch (error) {
        answer = Promise.reject(error)
      }
      return new Promise((resolve, reject) => {
        let over = false
        // The wait ends once: what comes after (the sheet's own answer after an abort or
        // after the ceiling) is dropped here.
        const end = (finish: () => void) => {
          if (!over) {
            over = true
            signal?.removeEventListener('abort', abandon)
            finish()
          }
        }
        // A sheet cannot be taken off the screen from here: the wait ends and the place
        // stays taken, until the sheet answers or the ceiling is reached.
        const abandon = () => end(() => reject(named('AbortError')))
        const stop = schedule(() => {
          release()
          end(() => reject(named('NotAllowedError')))
        }, PASSKEY_SHEET_CEILING_MS)
        signal?.addEventListener('abort', abandon, { once: true })
        answer.then(
          (value) => {
            stop()
            release()
            end(() => resolve(value))
          },
          (error: unknown) => {
            stop()
            release()
            end(() => reject(error))
          }
        )
      })
    }
  return {
    create: ask((options: PasskeyCreationOptions) => sheet.create(options)),
    get: ask((options: PasskeyRequestOptions) => sheet.get(options)),
    held: () => holder !== null,
  }
}

/** The binding of a provider round trip, where a tab would keep it: in memory. */
function memoryTab(): LinkStorageLike & { clear(): void } {
  const entries = new Map<string, string>()
  return {
    get length() {
      return entries.size
    },
    key: (index) => [...entries.keys()][index] ?? null,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
    removeItem: (key) => void entries.delete(key),
    clear: () => entries.clear(),
  }
}

/** What a client of this package has beside `@tula/core`'s own state. */
export interface ExpoHost {
  /** The system browser, when the app gave one. */
  readonly browser: BrowserSession | undefined
  /** Whether a passkey can be asked for here: a sheet was given and the device has passkeys. */
  passkeys(): boolean
  /** Whether a passkey sheet of this client is still out (one request at a time). */
  sheetHeld(): boolean
  /**
   * The address the client takes for its page: the redirect URL while a round trip starts,
   * the URL the browser was sent to while it ends, and nothing otherwise.
   *
   * @param url - The address, or an empty string for none.
   */
  setAddress(url: string): void
  /** Forget every binding kept for a round trip. */
  forget(): void
  /** How many bindings are kept. Zero outside a round trip. */
  kept(): number
  /** Whether a round trip is under way; one at a time. */
  roundTrip: boolean
  /** The native sign-in sheet the app gave for a provider, if any. */
  idTokenSheet(provider: IdTokenProvider): IdTokenSheet | undefined
  /**
   * The providers whose sheet said, when last asked, that it can be shown. Empty until
   * {@link ExpoHost.askIdTokenWays} has answered once: a control is hidden until known.
   */
  idTokenWays(): readonly IdTokenProvider[]
  /**
   * Ask every sheet the app gave whether it can be shown, and remember the answers. A
   * sheet that throws or rejects cannot.
   *
   * @returns The providers that can be asked for an ID token here.
   */
  askIdTokenWays(): Promise<readonly IdTokenProvider[]>
  /** Whether a provider's native sheet of this client is out; one at a time. */
  idTokenSheetOut: boolean
  /** How this client waits (a sheet's ceiling). */
  readonly schedule: Schedule
}

const hosts = new WeakMap<TulaClient, ExpoHost>()

/**
 * What a client can do beside codes and passwords, for `flowScreen`.
 *
 * @param client - The client.
 * @returns Whether it can ask for a passkey, whether it can open a provider's page, and
 *   which providers' native sheets were last known to be there.
 */
export function waysOf(client: TulaClient): {
  passkey: boolean
  providers: boolean
  idToken: readonly IdTokenProvider[]
} {
  const host = hosts.get(client)
  return {
    passkey: host?.passkeys() === true,
    providers: host?.browser !== undefined,
    idToken: host?.idTokenWays() ?? [],
  }
}

/**
 * The host of a client this package made.
 *
 * @param client - The client.
 * @returns Its host, or `undefined` for a client made some other way.
 */
export function hostOf(client: TulaClient): ExpoHost | undefined {
  return hosts.get(client)
}

/**
 * Refuse a passkey action while a sheet of this client is still out, before any request.
 *
 * `@tula/core` reports a provider's refusal as `passkey.cancelled`, which the hooks draw
 * as "the user dismissed the sheet". A request that was never shown to the user is not
 * that: the hooks ask here first and say `flow.busy`.
 *
 * @param client - The client.
 * @throws TulaError `flow.busy` while a passkey sheet holds its place, or a provider's
 *   native sheet is out.
 */
export function requireFreeSheet(client: TulaClient): void {
  const host = hosts.get(client)
  if (host?.sheetHeld() || host?.idTokenSheetOut) {
    throw clientError('flow.busy')
  }
}

/**
 * Build what replaces a browser for one client: the members of `@tula/core`'s environment
 * an app does differently, and the host the package's own calls reach them through.
 *
 * - `tabStorage` is memory, in this closure: the binding of a provider round trip never
 *   reaches the secure store, a file or a log, and is gone when the app is.
 * - `page` has an address only during a round trip, so `signIn.withOAuth` called on the
 *   client directly is refused before any request (`link.cross_origin`).
 * - `linkStorage` is absent: an emailed link cannot be asked for (`storage.failed`, before
 *   any request). The code in the same email is the way.
 * - `passkeys` (a browser's globals) is absent whatever the runtime has: only the sheet is
 *   asked.
 * - `deviceKey` is where the device's key is found when a request needs a proof (ADR 0052),
 *   when the app gave a key store.
 *
 * @param parts - The sheets, the browser and the source of a device key the app gave, if any.
 * @returns How to make the client's environment from the runtime's, and the host.
 */
export function createHost(parts: {
  passkeys?: PasskeySheet | undefined
  browser?: BrowserSession | undefined
  google?: IdTokenSheet | undefined
  apple?: IdTokenSheet | undefined
  /** Where the client's device key comes from, when it has a key store. */
  deviceKey?: DeviceKeySource | undefined
  /** How a sheet's ceiling is waited for. The runtime's timers when left out. */
  schedule?: Schedule | undefined
}): {
  /** The runtime's environment with an app's members in place of a browser's. */
  environment(base: Environment): Environment
  host: ExpoHost
  /** Call once with the client the environment was given to. */
  adopt(client: TulaClient): void
} {
  const tab = memoryTab()
  let address = ''
  const page: PageLike = {
    url: () => address,
    replaceUrl(url) {
      address = url
    },
  }
  const sheet = parts.passkeys
  const provider = sheet && oneAtATime(sheet, parts.schedule)
  // Asked each time (the module answers from the platform's version, at no cost), so that a
  // sheet which starts to answer otherwise is believed.
  const passkeys = () => {
    try {
      return sheet !== undefined && sheet.isSupported?.() !== false
    } catch {
      // A module that cannot say is one that cannot be asked.
      return false
    }
  }
  const sheets: [IdTokenProvider, IdTokenSheet | undefined][] = [
    ['google', parts.google],
    ['apple', parts.apple],
  ]
  let ways: readonly IdTokenProvider[] = []
  const host: ExpoHost = {
    idTokenSheet: (wanted) => sheets.find(([provider]) => provider === wanted)?.[1],
    idTokenWays: () => ways,
    async askIdTokenWays() {
      const answers = await Promise.all(
        sheets.map(async ([provider, given]) => {
          try {
            return given !== undefined && (await given.isAvailable()) === true ? provider : null
          } catch {
            // A module that cannot say is one that cannot be asked.
            return null
          }
        })
      )
      ways = answers.filter((provider) => provider !== null)
      return ways
    },
    idTokenSheetOut: false,
    schedule: parts.schedule ?? realSchedule,
    browser: parts.browser,
    passkeys,
    sheetHeld: () => provider?.held() === true,
    setAddress(url) {
      address = url
    },
    forget: () => tab.clear(),
    kept: () => tab.length,
    roundTrip: false,
  }
  return {
    environment: (base) => ({
      ...base,
      tabStorage: tab,
      linkStorage: undefined,
      page,
      passkeys: undefined,
      ...(parts.deviceKey && { deviceKey: parts.deviceKey }),
      // Asked when a passkey is, not before: creating a client calls no native module.
      get passkeyProvider() {
        return passkeys() ? provider : undefined
      },
    }),
    host,
    adopt: (client) => void hosts.set(client, host),
  }
}
