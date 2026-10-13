import {
  isValidThemeValue,
  THEME_TOKENS,
  type ThemeOverrides,
  type ThemeTokenDefinition,
} from '@tula-tech/contract/theme'
import { EN_MESSAGES, TulaError } from '@tula-tech/core'
import {
  type ComponentType,
  createElement,
  type ReactElement,
  useEffect,
  useMemo,
  useRef,
} from 'react'

// Tula's native screens in an Expo app (ADR 0063), as far as it can be written without the
// native module: what JavaScript hands the module, what it takes back, and the two
// components. `index.ts` is the entry point that loads the module and the views
// and hands them to `createScreens`; tests hand it fakes.
//
// The native client (the Swift client on iOS, the Kotlin client on Android) owns the
// tokens and the refresh. Nothing here holds a token: `getToken()` passes the native
// client's answer on and keeps nothing of it.

/** The name the native module is registered under, on both platforms. */
export const SCREENS_MODULE_NAME = 'TulaScreens'

/** The names of the module's two native views, the same on both platforms. */
export const SCREENS_VIEW_NAMES = {
  auth: 'TulaAuthScreenView',
  account: 'TulaAccountScreenView',
} as const

/** The one event of the native module: the session's state, when it changes. */
export const SESSION_EVENT = 'onSessionChange'

/**
 * The codes of the native module's own refusals, with the sentence of each. They are
 * client codes like `@tula-tech/core`'s (`status: 0`).
 */
export const SCREENS_MESSAGES = {
  'screens.not_configured': 'The native screens were used before they were set up.',
  'screens.already_configured':
    'The native screens are already set up with other options. Restart the app to change them.',
  'screens.invalid_options': 'The native client refused the options it was given.',
  'screens.unsupported': 'The native screens do not run on this device.',
} as const

/** A code of the native module's own. */
export type TulaScreensErrorCode = keyof typeof SCREENS_MESSAGES

/**
 * What the app says once, when it sets the native screens up. Every value is a string or a
 * boolean: nothing here is a token, a key store or a function.
 */
export interface TulaScreensOptions {
  /** The environment's publishable key (`tula_pk_…`). */
  publishableKey: string
  /** The API's address. */
  baseUrl: string
  /** The session profile to ask for; the environment must mark it `clientSelectable`. */
  sessionProfile?: string
  /**
   * Bind sessions to a key the device keeps (ADR 0043): the Keychain's on iOS, the
   * Keystore's on Android. Only where the session profile allows a key.
   */
  deviceBinding?: boolean
  /** Offer passkeys: the system's passkey sheet on iOS, Credential Manager on Android. */
  passkeys?: boolean
  /** iOS only: offer the Sign in with Apple sheet. Ignored on Android. */
  apple?: boolean
  /**
   * Offer the other providers in the system's browser. A provider is drawn only where the
   * screen is also given a `redirectUrl`.
   */
  browser?: boolean
  /**
   * Android only: the OAuth client ID of the environment's Google provider (a web client
   * ID), for Google's own sheet. It is not a secret. Ignored on iOS, where Google goes
   * through the browser.
   */
  googleWebClientId?: string
}

/** What the native client says the session is. It never holds a token. */
export type TulaScreensState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; sessionId: string; userId: string | null }

/** What `index.ts` reads of the native module. */
export interface ScreensNativeModule {
  /** Make the process's one native client. Throws an error with a `code`. */
  configure(options: Record<string, string | boolean>): void
  /** Read the stored session, once. */
  load(): Promise<unknown>
  /** The session's state now. */
  getState(): Promise<unknown>
  /** An access token of the native client's session, refreshed when it has to be. */
  getToken(): Promise<unknown>
  /** End the session; rejects when the server could not be told. */
  signOut(): Promise<unknown>
  /** Listen to an event of the module. */
  addListener(event: string, listener: (body: unknown) => void): { remove(): void }
}

/** What the facade and the components are made from: tests pass fakes. */
export interface ScreensRuntime {
  /** React Native's `Platform.OS`. */
  platform: string
  /** The native module. */
  module: ScreensNativeModule
  /** The native view of the sign-in and sign-up screens. */
  authView: ComponentType<Record<string, unknown>>
  /** The native view of the account screen. */
  accountView: ComponentType<Record<string, unknown>>
}

/**
 * The native client's session, as far as JavaScript may see it.
 *
 * It is not a second client: it asks the native one, and holds only the last state it was
 * told (a status and two ids).
 */
export interface TulaScreens {
  /** The last state the native client told. `loading` until it has said anything. */
  getState(): TulaScreensState
  /**
   * Read the stored session, once.
   *
   * @returns The state after the read.
   * @throws TulaError when the stored session could not be read or refreshed; the state is
   *   then still `loading`.
   */
  load(): Promise<TulaScreensState>
  /**
   * Be told of every change of state.
   *
   * @param listener - Called with each new state.
   * @returns A function that stops it.
   */
  addListener(listener: (state: TulaScreensState) => void): () => void
  /**
   * An access token for the app's own backend, from the native client, which refreshes it
   * when it has to. It is returned and not kept: ask again for each request. The refresh
   * token is never returned by anything.
   *
   * @returns The token, or `null` when nobody is signed in.
   * @throws TulaError as the native client's `getToken()` does.
   */
  getToken(): Promise<string | null>
  /**
   * End the session.
   *
   * @throws TulaError when the server could not be told: a failed sign-out is not a
   *   sign-out, and the session may still be active.
   */
  signOut(): Promise<void>
}

/** What the facade hands the components; not for an app to read. */
interface Internals {
  readonly authView: ComponentType<Record<string, unknown>>
  readonly accountView: ComponentType<Record<string, unknown>>
}

const INTERNALS = new WeakMap<TulaScreens, Internals>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ownString(value: Record<string, unknown>, key: string): string | undefined {
  const found = Object.hasOwn(value, key) ? value[key] : undefined
  return typeof found === 'string' ? found : undefined
}

/**
 * Read a state the native module sent. The module is this package's own, but what crosses
 * the bridge is checked like any other answer.
 *
 * @param body - What the module sent.
 * @returns The state, or `undefined` for a body that is none.
 */
export function readScreensState(body: unknown): TulaScreensState | undefined {
  if (!isRecord(body)) {
    return undefined
  }
  const status = ownString(body, 'status')
  if (status === 'loading' || status === 'signed-out') {
    return { status }
  }
  const sessionId = ownString(body, 'sessionId')
  if (status === 'signed-in' && sessionId !== undefined) {
    return { status, sessionId, userId: ownString(body, 'userId') ?? null }
  }
  return undefined
}

/**
 * The error of a native call, as a `TulaError`.
 *
 * Only a code crosses: one the client knows (a contract code, a client code, one of the
 * module's own) gets its sentence from this side's tables; anything else, a code this
 * version does not know among them, is `internal`. Nothing of the native error is kept:
 * not its message, not itself as a `cause`.
 *
 * @param caught - What the native call rejected with or threw.
 * @returns The error.
 */
export function toScreensError(caught: unknown): TulaError {
  const code = isRecord(caught) ? ownString(caught, 'code') : undefined
  if (code !== undefined && Object.hasOwn(SCREENS_MESSAGES, code)) {
    return new TulaError({ code, message: SCREENS_MESSAGES[code as TulaScreensErrorCode] })
  }
  if (code !== undefined && Object.hasOwn(EN_MESSAGES, code)) {
    return new TulaError({ code, message: EN_MESSAGES[code as keyof typeof EN_MESSAGES] })
  }
  return new TulaError({ code: 'internal', message: EN_MESSAGES.internal })
}

/** The options the native module reads, and what each must be. */
export const SCREENS_OPTION_TYPES = {
  publishableKey: 'string',
  baseUrl: 'string',
  sessionProfile: 'string',
  deviceBinding: 'boolean',
  passkeys: 'boolean',
  apple: 'boolean',
  browser: 'boolean',
  googleWebClientId: 'string',
} as const

/** Options a caller might expect from the headless client, and why they are none here. */
const DECIDED_NATIVELY = {
  client: 'the client kind is the platform the app runs on',
  storage: 'the refresh token is kept by the native client (Keychain, Keystore) and nowhere else',
  secureStore: 'the native client keeps the refresh token; the secure store is not used',
  deviceKey: 'a session is bound to a key the device keeps: say `deviceBinding: true`',
  deviceKeys: 'the native client has its own key store: say `deviceBinding: true`',
  fetch: 'requests are made by the native client',
} as const

function checkedOptions(options: TulaScreensOptions): Record<string, string | boolean> {
  if (!isRecord(options)) {
    throw new TypeError('createTulaScreens: the options are an object.')
  }
  const given: Record<string, unknown> = options
  const checked: Record<string, string | boolean> = {}
  for (const name of Object.keys(given)) {
    if (Object.hasOwn(DECIDED_NATIVELY, name)) {
      const why = DECIDED_NATIVELY[name as keyof typeof DECIDED_NATIVELY]
      throw new TypeError(`createTulaScreens: \`${name}\` is not an option: ${why}`)
    }
    if (!Object.hasOwn(SCREENS_OPTION_TYPES, name)) {
      // The name is not repeated: it is whatever the caller wrote.
      throw new TypeError('createTulaScreens: an option was given that this version does not have.')
    }
    const type = SCREENS_OPTION_TYPES[name as keyof typeof SCREENS_OPTION_TYPES]
    const value = given[name]
    if (value === undefined) {
      continue
    }
    if (typeof value !== type) {
      throw new TypeError(`createTulaScreens: \`${name}\` is a ${type}.`)
    }
    checked[name] = value as string | boolean
  }
  if (checked.publishableKey === undefined || checked.baseUrl === undefined) {
    throw new TypeError('createTulaScreens: `publishableKey` and `baseUrl` are required.')
  }
  return checked
}

/**
 * Set the native screens up for a runtime. `createTulaScreens` calls it with the app's own.
 *
 * @param runtime - The platform's name, the native module and its two views.
 * @param options - The publishable key, the API's address and what the screens may offer.
 * @returns The native client's session, as far as JavaScript may see it.
 * @throws TypeError on a platform other than iOS and Android, and for options that are not
 *   this function's.
 * @throws TulaError when the native module refuses (`screens.already_configured`,
 *   `screens.invalid_options`, `screens.unsupported`).
 */
export function createScreens(runtime: ScreensRuntime, options: TulaScreensOptions): TulaScreens {
  if (runtime.platform !== 'ios' && runtime.platform !== 'android') {
    throw new TypeError(
      "@tula-tech/expo-screens draws Tula's SwiftUI and Compose screens: it runs in iOS and Android apps. On the web (Expo web included) use `@tula-tech/react`."
    )
  }
  const { module } = runtime
  const checked = checkedOptions(options)
  try {
    module.configure(checked)
  } catch (caught) {
    throw toScreensError(caught)
  }

  let state: TulaScreensState = { status: 'loading' }
  const listeners = new Set<(state: TulaScreensState) => void>()

  function told(body: unknown): void {
    const next = readScreensState(body)
    if (next === undefined || same(state, next)) {
      return
    }
    state = next
    for (const listener of [...listeners]) {
      listener(next)
    }
  }

  // The module starts watching its client when it is first listened to, and tells the
  // state it has then: so it is listened to after `configure`, and for the app's life.
  module.addListener(SESSION_EVENT, told)

  const screens: TulaScreens = {
    getState: () => state,
    async load() {
      try {
        told(await module.load())
      } catch (caught) {
        throw toScreensError(caught)
      }
      return state
    },
    addListener(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async getToken() {
      let token: unknown
      try {
        token = await module.getToken()
      } catch (caught) {
        throw toScreensError(caught)
      }
      return typeof token === 'string' && token !== '' ? token : null
    },
    async signOut() {
      try {
        await module.signOut()
      } catch (caught) {
        throw toScreensError(caught)
      }
    },
  }
  INTERNALS.set(screens, { authView: runtime.authView, accountView: runtime.accountView })
  return Object.freeze(screens)
}

function same(a: TulaScreensState, b: TulaScreensState): boolean {
  return (
    a.status === b.status &&
    (a.status !== 'signed-in' ||
      (b.status === 'signed-in' && a.sessionId === b.sessionId && a.userId === b.userId))
  )
}

function internalsOf(tula: TulaScreens, component: string): Internals {
  const internals = INTERNALS.get(tula)
  if (internals === undefined) {
    throw new TypeError(`<${component}>: \`tula\` is what \`createTulaScreens()\` returned.`)
  }
  return internals
}

/** A theme as it is handed to the native screens, and what was left out of it. */
export interface CheckedTheme {
  /** The values that passed, by token; `light` and `dark` hold the colours. */
  theme: Record<string, string | Record<string, string>>
  /** The tokens whose values were refused (`light.primary`, `radius`), never a value. */
  refused: string[]
}

/**
 * Check a theme before it reaches the native screens.
 *
 * A theme value is untrusted (a tenant's brand colour). Each is checked with the
 * contract's grammar for its token's type (`isValidThemeValue`); one that is refused, one
 * for a name that is no token, and one that is no string are left out, so the native
 * default is drawn. The native screens check every value again and refuse what they cannot
 * draw.
 *
 * @param theme - The app's overrides.
 * @returns The values that passed and the names of the tokens that did not.
 */
export function checkTheme(theme: ThemeOverrides | undefined): CheckedTheme {
  const checked: CheckedTheme = { theme: {}, refused: [] }
  if (!isRecord(theme)) {
    return checked
  }
  const known = new Set<string>(['light', 'dark'])
  for (const scheme of ['light', 'dark'] as const) {
    const given: unknown = Object.hasOwn(theme, scheme) ? theme[scheme] : undefined
    if (!isRecord(given)) {
      continue
    }
    const colors: Record<string, string> = {}
    const names = new Set<string>()
    for (const token of THEME_TOKENS) {
      if (token.scope === 'scheme') {
        names.add(token.key)
        take(given, token, colors, checked.refused, `${scheme}.`)
      }
    }
    unknownNames(given, names, checked.refused, `${scheme}.`)
    checked.theme[scheme] = colors
  }
  for (const token of THEME_TOKENS) {
    if (token.scope === 'shared') {
      known.add(token.key)
      take(theme, token, checked.theme, checked.refused, '')
    }
  }
  unknownNames(theme, known, checked.refused, '')
  return checked
}

/** Put one token's value into `into` when it passes, and name the token when it does not. */
function take(
  source: Record<string, unknown>,
  token: ThemeTokenDefinition,
  into: Record<string, string | Record<string, string>>,
  refused: string[],
  prefix: string
): void {
  const value: unknown = Object.hasOwn(source, token.key) ? source[token.key] : undefined
  if (value === undefined) {
    return
  }
  if (typeof value === 'string' && isValidThemeValue(token.type, value)) {
    into[token.key] = value
  } else {
    refused.push(`${prefix}${token.key}`)
  }
}

/** A name that is no token is the caller's own text: it is counted, never repeated. */
function unknownNames(
  source: Record<string, unknown>,
  known: ReadonlySet<string>,
  refused: string[],
  prefix: string
): void {
  if (Object.keys(source).some((name) => !known.has(name))) {
    refused.push(`${prefix}(unknown)`)
  }
}

/** What both screens take. */
interface ScreenProps {
  /** What `createTulaScreens()` returned. */
  tula: TulaScreens
  /**
   * The theme, in the tokens of `@tula-tech/contract/theme` (the ones `@tula-tech/react` takes).
   * Every value is checked before it reaches the native screen, and a refused one is left
   * out. Keep the object the same between renders (a constant, `useMemo`).
   */
  theme?: ThemeOverrides
  /**
   * Called with the names of the tokens whose values were refused here, when there are
   * any. Never a value. The native screens may refuse more (what they cannot draw) and do
   * not report it.
   */
  onThemeRefused?: (tokens: readonly string[]) => void
  /** React Native's `style` of the view: give the screen its size (`{ flex: 1 }`). */
  style?: unknown
  /** React Native's `testID`. */
  testID?: string
}

/** The props of `<TulaAuthView>`. */
export interface TulaAuthViewProps extends ScreenProps {
  /** Which flow the screen opens with. `sign-in` when left out. */
  mode?: 'sign-in' | 'sign-up'
  /**
   * Where a provider's page comes back to: an app link or a custom scheme the environment
   * lists among its redirect URLs. The server judges it. Without it no provider that needs
   * the browser is drawn.
   */
  redirectUrl?: string
  /**
   * Called once per completed sign-in or sign-up, with nothing. Where the app goes next is
   * decided here and nowhere else: the screens read no URL and follow no link.
   */
  onSignedIn?: () => void
}

/** The props of `<TulaAccountView>`. */
export interface TulaAccountViewProps extends ScreenProps {
  /** Called for a sign-out the server was told of, never for one that failed. */
  onSignedOut?: () => void
}

function useCheckedTheme(
  theme: ThemeOverrides | undefined,
  onThemeRefused: ((tokens: readonly string[]) => void) | undefined
): CheckedTheme['theme'] {
  const checked = useMemo(() => checkTheme(theme), [theme])
  const report = useRef(onThemeRefused)
  report.current = onThemeRefused
  // Told after the render, once per theme: a callback may set state.
  useEffect(() => {
    if (checked.refused.length > 0) {
      report.current?.(checked.refused)
    }
  }, [checked])
  return checked.theme
}

/**
 * Sign-in, sign-up and password reset, drawn by the platform: `TulaAuthUI`'s
 * `TulaAuthView` (SwiftUI) on iOS and `tula-auth-compose`'s `TulaAuth` (Compose) on
 * Android, on the native client `createTulaScreens()` set up.
 *
 * Nothing the screen holds (an address, a password, a code, a token) crosses to
 * JavaScript, and nothing JavaScript passes is drawn as text.
 *
 * @param props - The screens, the mode, the theme and the callback.
 * @returns The native view.
 * @throws TypeError when `tula` is not what `createTulaScreens()` returned.
 * @example
 * <TulaAuthView tula={tula} mode="sign-in" style={{ flex: 1 }} onSignedIn={() => setSignedIn(true)} />
 */
export function TulaAuthView(props: TulaAuthViewProps): ReactElement {
  const { authView } = internalsOf(props.tula, 'TulaAuthView')
  const theme = useCheckedTheme(props.theme, props.onThemeRefused)
  const { onSignedIn } = props
  return createElement(authView, {
    mode: props.mode === 'sign-up' ? 'sign-up' : 'sign-in',
    theme,
    redirectUrl: typeof props.redirectUrl === 'string' ? props.redirectUrl : undefined,
    // The native event carries nothing, and nothing of it is passed on.
    onSignedIn: () => onSignedIn?.(),
    style: props.style,
    testID: props.testID,
  })
}

/**
 * The signed-in user's account, drawn by the platform: `TulaAuthUI`'s `TulaAccountView`
 * on iOS and `tula-auth-compose`'s `TulaAccount` on Android.
 *
 * @param props - The screens, the theme and the callback.
 * @returns The native view.
 * @throws TypeError when `tula` is not what `createTulaScreens()` returned.
 * @example
 * <TulaAccountView tula={tula} style={{ flex: 1 }} onSignedOut={() => setSignedIn(false)} />
 */
export function TulaAccountView(props: TulaAccountViewProps): ReactElement {
  const { accountView } = internalsOf(props.tula, 'TulaAccountView')
  const theme = useCheckedTheme(props.theme, props.onThemeRefused)
  const { onSignedOut } = props
  return createElement(accountView, {
    theme,
    onSignedOut: () => onSignedOut?.(),
    style: props.style,
    testID: props.testID,
  })
}
