import { describe, expect, test } from 'bun:test'
import { render } from '@testing-library/react'
import { DEFAULT_THEME, THEME_TOKENS } from '@tula/contract/theme'
import { isTulaError } from '@tula/core'
import { type ComponentType, createElement, StrictMode } from 'react'
import {
  checkTheme,
  createScreens,
  readScreensState,
  SCREENS_MESSAGES,
  type ScreensNativeModule,
  type ScreensRuntime,
  SESSION_EVENT,
  TulaAccountView,
  TulaAuthView,
  type TulaScreens,
  type TulaScreensState,
  toScreensError,
} from './native-screens-core'

// The JavaScript half of the native screens against a fake native module and fake native
// views: what the module is handed, what is taken back from it, what reaches a native view
// as a prop, and that nothing of a token, of a native error's text or of a refused theme
// value is kept, passed on or said. No native code runs here: neither screen was drawn.

const KEY = 'tula_pk_test_screens'
const BASE = 'https://auth.example.com'
const ACCESS = 'eyJhbGciOiJFZERTQSJ9.canary-acc3ss-t0k3n.c2ln'
const NATIVE_TEXT = 'native-canary-7f1e: java.net.ConnectException /v1/client/sign-ins/att_9'
const HOSTILE = 'red; background: url(https://evil.example/canary-th3me)'

/** One prop set a fake native view was rendered with. */
type Drawn = Record<string, unknown>

interface Fake {
  runtime: ScreensRuntime
  module: ScreensNativeModule
  calls: string[]
  configured: Record<string, string | boolean>[]
  listeners: Map<string, ((body: unknown) => void)[]>
  removed: number
  auth: Drawn[]
  account: Drawn[]
  /** What the next call of a method does instead of its default. */
  next: Partial<Record<'configure' | 'load' | 'getToken' | 'signOut', () => unknown>>
  emit(body: unknown): void
}

function fake(platform = 'ios'): Fake {
  const made: Fake = {
    calls: [],
    configured: [],
    listeners: new Map(),
    removed: 0,
    auth: [],
    account: [],
    next: {},
    emit(body) {
      for (const listener of made.listeners.get(SESSION_EVENT) ?? []) {
        listener(body)
      }
    },
    module: {
      configure(options) {
        made.calls.push('configure')
        made.configured.push(options)
        made.next.configure?.()
      },
      async load() {
        made.calls.push('load')
        return made.next.load ? made.next.load() : { status: 'signed-out' }
      },
      async getState() {
        made.calls.push('getState')
        return { status: 'loading' }
      },
      async getToken() {
        made.calls.push('getToken')
        return made.next.getToken ? made.next.getToken() : ACCESS
      },
      async signOut() {
        made.calls.push('signOut')
        return made.next.signOut?.()
      },
      addListener(event, listener) {
        made.calls.push(`addListener:${event}`)
        made.listeners.set(event, [...(made.listeners.get(event) ?? []), listener])
        return {
          remove() {
            made.removed += 1
          },
        }
      },
    },
    runtime: undefined as unknown as ScreensRuntime,
  }
  const view =
    (into: Drawn[]): ComponentType<Record<string, unknown>> =>
    (props) => {
      into.push(props)
      return null
    }
  made.runtime = {
    platform,
    module: made.module,
    authView: view(made.auth),
    accountView: view(made.account),
  }
  return made
}

function screens(f: Fake, extra: object = {}): TulaScreens {
  return createScreens(f.runtime, { publishableKey: KEY, baseUrl: BASE, ...extra })
}

/** A native rejection as Expo hands it over: an error with a `code` and a message. */
function nativeError(code: unknown, message = NATIVE_TEXT): Error {
  return Object.assign(new Error(message), { code })
}

function last<T>(items: T[]): T {
  const item = items.at(-1)
  if (item === undefined) {
    throw new Error('nothing was drawn')
  }
  return item
}

describe('setting the native screens up', () => {
  test('the module is configured once, before it is listened to, with the options as given', () => {
    const f = fake()
    screens(f, {
      sessionProfile: 'mobile',
      deviceBinding: true,
      passkeys: true,
      apple: true,
      browser: true,
      googleWebClientId: 'web-client.apps.example',
    })
    expect(f.calls).toEqual(['configure', `addListener:${SESSION_EVENT}`])
    expect(f.configured).toEqual([
      {
        publishableKey: KEY,
        baseUrl: BASE,
        sessionProfile: 'mobile',
        deviceBinding: true,
        passkeys: true,
        apple: true,
        browser: true,
        googleWebClientId: 'web-client.apps.example',
      },
    ])
  })

  test('an option left undefined is not handed over', () => {
    const f = fake('android')
    screens(f, { sessionProfile: undefined, passkeys: undefined })
    expect(f.configured).toEqual([{ publishableKey: KEY, baseUrl: BASE }])
  })

  test.each(['web', 'windows', 'macos', ''])(
    'the platform %p is refused before the module is touched',
    (platform) => {
      const f = fake(platform)
      expect(() => screens(f)).toThrow(TypeError)
      expect(f.calls).toEqual([])
    }
  )

  test.each([
    ['client', 'ios'],
    ['storage', {}],
    ['secureStore', {}],
    ['deviceKey', {}],
    ['deviceKeys', {}],
    ['fetch', () => undefined],
  ])('`%s` is not an option: the native client decides it', (name, value) => {
    const f = fake()
    expect(() => screens(f, { [name]: value })).toThrow(
      new RegExp(`^createTulaScreens: \`${name}\` is not an option: `)
    )
    expect(f.calls).toEqual([])
  })

  test('no refusal repeats what it was given', () => {
    const canary = 'canary-0pt10n-5a1c'
    const refused: unknown[] = []
    const tries: (() => unknown)[] = [
      () => createScreens(fake().runtime, null as never),
      () => createScreens(fake().runtime, [canary] as never),
      () => screens(fake(), { [canary]: true }),
      () => screens(fake(), { passkeys: canary }),
      () => screens(fake(), { sessionProfile: 7 }),
      () => createScreens(fake().runtime, { publishableKey: canary } as never),
      () => createScreens(fake().runtime, { baseUrl: canary } as never),
      () => createScreens(fake().runtime, { publishableKey: 1, baseUrl: canary } as never),
      () => screens(fake(), { storage: canary }),
    ]
    for (const attempt of tries) {
      try {
        attempt()
      } catch (caught) {
        refused.push(caught)
      }
    }
    expect(refused).toHaveLength(tries.length)
    for (const caught of refused) {
      expect(caught).toBeInstanceOf(TypeError)
      expect(String(caught)).not.toContain(canary)
    }
  })

  test.each(Object.keys(SCREENS_MESSAGES))(
    "a refusal of the module (%s) is a TulaError with this side's sentence",
    (code) => {
      const f = fake()
      f.next.configure = () => {
        throw nativeError(code)
      }
      let caught: unknown
      try {
        screens(f)
      } catch (thrown) {
        caught = thrown
      }
      expect(isTulaError(caught)).toBe(true)
      const error = caught as Error & { code: string; status: number; cause?: unknown }
      expect(error.code).toBe(code)
      expect(error.status).toBe(0)
      expect(error.message).toBe(SCREENS_MESSAGES[code as keyof typeof SCREENS_MESSAGES])
      expect(error.cause).toBeUndefined()
      // A module that refused is not listened to.
      expect(f.calls).toEqual(['configure'])
    }
  )
})

describe('an error of the native side', () => {
  test.each([
    ['auth.invalid_credentials', 'auth.invalid_credentials'],
    ['storage.failed', 'storage.failed'],
    ['network.timeout', 'network.timeout'],
    ['screens.not_configured', 'screens.not_configured'],
    // A code this version has no sentence for is not passed on: it is text from elsewhere.
    ['billing.card_declined', 'internal'],
    [NATIVE_TEXT, 'internal'],
    ['__proto__', 'internal'],
    ['constructor', 'internal'],
    ['toString', 'internal'],
    ['', 'internal'],
    [7, 'internal'],
    [undefined, 'internal'],
  ])('with the code %p crosses as %p', (code, expected) => {
    const error = toScreensError(nativeError(code))
    expect(isTulaError(error)).toBe(true)
    expect(error.code).toBe(expected)
    expect(error.status).toBe(0)
  })

  test.each([[undefined], [null], ['a string'], [7], [[]], [new Error(NATIVE_TEXT)]])(
    '%p is `internal`',
    (caught) => {
      expect(toScreensError(caught).code).toBe('internal')
    }
  )

  test('nothing of the native error is kept: not its message, not itself', () => {
    for (const code of [
      'auth.invalid_credentials',
      'screens.unsupported',
      'no.such_code',
      undefined,
    ]) {
      const error = toScreensError(nativeError(code))
      expect(error.cause).toBeUndefined()
      expect(error.message).not.toContain('native-canary')
      expect(JSON.stringify(error)).not.toContain('native-canary')
      expect(String(error.stack)).not.toContain('native-canary')
    }
  })
})

describe('the state the native client tells', () => {
  test.each([
    [{ status: 'loading' }, { status: 'loading' }],
    [{ status: 'signed-out' }, { status: 'signed-out' }],
    [
      { status: 'signed-in', sessionId: 'ses_1', userId: 'usr_1' },
      { status: 'signed-in', sessionId: 'ses_1', userId: 'usr_1' },
    ],
    // iOS leaves the user out until it has read one; Android sends null.
    [
      { status: 'signed-in', sessionId: 'ses_1' },
      { status: 'signed-in', sessionId: 'ses_1', userId: null },
    ],
    [
      { status: 'signed-in', sessionId: 'ses_1', userId: null },
      { status: 'signed-in', sessionId: 'ses_1', userId: null },
    ],
    // Whatever else the body holds is not taken.
    [{ status: 'signed-out', token: ACCESS }, { status: 'signed-out' }],
    [
      {
        status: 'signed-in',
        sessionId: 'ses_1',
        userId: 'usr_1',
        accessToken: ACCESS,
        refreshToken: 'r',
      },
      { status: 'signed-in', sessionId: 'ses_1', userId: 'usr_1' },
    ],
  ])('%p is read as %p', (body, expected) => {
    expect(readScreensState(body)).toEqual(expected as TulaScreensState)
  })

  test.each([
    [undefined],
    [null],
    ['signed-in'],
    [7],
    [[]],
    [{}],
    [{ status: 'signed-in' }],
    [{ status: 'signed-in', sessionId: 7 }],
    [{ status: 'signedIn', sessionId: 'ses_1' }],
    [{ status: 'banned' }],
    [Object.create({ status: 'signed-out' })],
  ])('%p is no state', (body) => {
    expect(readScreensState(body)).toBeUndefined()
  })

  test('the state is `loading` until the module says, and listeners hear each change once', () => {
    const f = fake()
    const tula = screens(f)
    const heard: TulaScreensState[] = []
    const stop = tula.addListener((state) => heard.push(state))
    expect(tula.getState()).toEqual({ status: 'loading' })

    f.emit({ status: 'loading' })
    f.emit({ status: 'signed-out' })
    f.emit({ status: 'signed-out' })
    f.emit({ status: 'signed-in', sessionId: 'ses_1', userId: 'usr_1' })
    f.emit({ status: 'signed-in', sessionId: 'ses_1', userId: 'usr_1' })
    f.emit({ status: 'signed-in', sessionId: 'ses_2', userId: 'usr_1' })
    f.emit('nonsense')
    f.emit({ status: 'signed-in' })
    expect(heard).toEqual([
      { status: 'signed-out' },
      { status: 'signed-in', sessionId: 'ses_1', userId: 'usr_1' },
      { status: 'signed-in', sessionId: 'ses_2', userId: 'usr_1' },
    ])
    expect(tula.getState()).toEqual({ status: 'signed-in', sessionId: 'ses_2', userId: 'usr_1' })

    stop()
    f.emit({ status: 'signed-out' })
    expect(heard).toHaveLength(3)
    expect(tula.getState()).toEqual({ status: 'signed-out' })
  })

  test('a listener that stops another in the middle of a change does not break the round', () => {
    const f = fake()
    const tula = screens(f)
    const heard: string[] = []
    const stops: (() => void)[] = []
    stops.push(
      tula.addListener(() => {
        heard.push('first')
        stops[1]?.()
      })
    )
    stops.push(tula.addListener(() => heard.push('second')))
    f.emit({ status: 'signed-out' })
    expect(heard).toEqual(['first', 'second'])
    f.emit({ status: 'loading' })
    expect(heard).toEqual(['first', 'second', 'first'])
  })

  test('`load` sets the state from the answer and returns it', async () => {
    const f = fake()
    const tula = screens(f)
    f.next.load = () => ({ status: 'signed-in', sessionId: 'ses_1', userId: 'usr_1' })
    const heard: TulaScreensState[] = []
    tula.addListener((state) => heard.push(state))
    expect(await tula.load()).toEqual({ status: 'signed-in', sessionId: 'ses_1', userId: 'usr_1' })
    expect(heard).toHaveLength(1)
  })

  test('a load that failed leaves the state `loading` and throws the code', async () => {
    const f = fake()
    const tula = screens(f)
    f.next.load = () => {
      throw nativeError('storage.failed')
    }
    const failure = await tula.load().catch((caught: unknown) => caught)
    expect(isTulaError(failure)).toBe(true)
    expect((failure as { code: string }).code).toBe('storage.failed')
    expect(String((failure as Error).message)).not.toContain('native-canary')
    expect(tula.getState()).toEqual({ status: 'loading' })
  })
})

describe('the access token', () => {
  test("is the native client's answer, asked for each time and kept nowhere", async () => {
    const f = fake()
    const tula = screens(f)
    expect(await tula.getToken()).toBe(ACCESS)
    expect(await tula.getToken()).toBe(ACCESS)
    expect(f.calls.filter((call) => call === 'getToken')).toHaveLength(2)
    // Nothing the facade is, or holds in the open, has the token.
    expect(JSON.stringify(tula)).toBe('{}')
    expect(JSON.stringify(tula.getState())).not.toContain('canary')
    expect(Object.isFrozen(tula)).toBe(true)
    expect(Object.keys(tula).sort()).toEqual([
      'addListener',
      'getState',
      'getToken',
      'load',
      'signOut',
    ])
  })

  test.each([[null], [undefined], [''], [7], [{ token: ACCESS }], [[ACCESS]]])(
    'an answer of %p is nobody signed in',
    async (answer) => {
      const f = fake()
      const tula = screens(f)
      f.next.getToken = () => answer
      expect(await tula.getToken()).toBeNull()
    }
  )

  test('a failure is the code, with nothing of the native text', async () => {
    const f = fake()
    const tula = screens(f)
    f.next.getToken = () => {
      throw nativeError('network.failed')
    }
    const failure = await tula.getToken().catch((caught: unknown) => caught)
    expect((failure as { code: string }).code).toBe('network.failed')
    expect(JSON.stringify(failure)).not.toContain('native-canary')
  })

  test('no event the module sends puts a token into the state or before a listener', () => {
    const f = fake()
    const tula = screens(f)
    const heard: unknown[] = []
    tula.addListener((state) => heard.push(state))
    f.emit({ status: 'signed-in', sessionId: 'ses_1', userId: 'usr_1', accessToken: ACCESS })
    expect(JSON.stringify([heard, tula.getState()])).not.toContain('canary')
  })
})

describe('signing out', () => {
  test('asks the native client and resolves with nothing', async () => {
    const f = fake()
    const tula = screens(f)
    f.next.signOut = () => ({ unexpected: ACCESS })
    expect(await tula.signOut()).toBeUndefined()
    expect(f.calls).toContain('signOut')
  })

  test('a failed sign-out is not a sign-out: it throws, and the state is what the module said', async () => {
    const f = fake()
    const tula = screens(f)
    f.emit({ status: 'signed-in', sessionId: 'ses_1', userId: 'usr_1' })
    f.next.signOut = () => {
      throw nativeError('network.timeout')
    }
    const failure = await tula.signOut().catch((caught: unknown) => caught)
    expect((failure as { code: string }).code).toBe('network.timeout')
    expect(tula.getState().status).toBe('signed-in')
  })
})

describe('a theme before it reaches a native screen', () => {
  test('values that pass are handed on by token, and nothing else is', () => {
    const checked = checkTheme({
      light: { primary: '#0f766e', primaryHover: '#115e59' },
      dark: { primary: '#5eead4' },
      radius: '6px',
      fontFamily: 'Inter, sans-serif',
    })
    expect(checked).toEqual({
      theme: {
        light: { primary: '#0f766e', primaryHover: '#115e59' },
        dark: { primary: '#5eead4' },
        radius: '6px',
        fontFamily: 'Inter, sans-serif',
      },
      refused: [],
    })
  })

  test('the whole default theme passes with nothing refused', () => {
    const checked = checkTheme(DEFAULT_THEME)
    expect(checked.refused).toEqual([])
    expect(checked.theme).toEqual(DEFAULT_THEME as never)
  })

  test('a refused value is left out, and its token is named without the value', () => {
    const checked = checkTheme({
      light: { primary: HOSTILE, text: '#111111' },
      dark: { background: 'url(https://evil.example/canary-th3me)' },
      radius: 'calc(1px); canary-th3me',
      spacing: '12px',
    })
    expect(checked.theme).toEqual({ light: { text: '#111111' }, dark: {}, spacing: '12px' })
    expect(checked.refused).toEqual(['light.primary', 'dark.background', 'radius'])
    expect(JSON.stringify(checked)).not.toContain('canary')
    expect(JSON.stringify(checked)).not.toContain('evil')
  })

  test('every token refuses a hostile value and a value that is no string', () => {
    for (const token of THEME_TOKENS) {
      for (const value of [HOSTILE, 7, null, {}, ['#000000'], true]) {
        const theme =
          token.scope === 'scheme' ? { light: { [token.key]: value } } : { [token.key]: value }
        const checked = checkTheme(theme as never)
        const name = token.scope === 'scheme' ? `light.${token.key}` : token.key
        expect(checked.refused).toEqual([name])
        expect(JSON.stringify(checked.theme)).not.toContain('canary')
        expect(token.scope === 'scheme' ? checked.theme.light : checked.theme).not.toHaveProperty(
          token.key
        )
      }
    }
  })

  test('a name that is no token is left out and never repeated', () => {
    const checked = checkTheme({
      light: { 'canary-n4me': '#000000', primary: '#0f766e' },
      'canary-0ther': '4px',
      // A shared token inside a scheme, and a colour outside one, are no tokens there.
      dark: { radius: '4px' },
      primary: '#0f766e',
      __proto__: { radius: '1px' },
    } as never)
    expect(checked.theme).toEqual({ light: { primary: '#0f766e' }, dark: {} })
    expect(checked.refused).toEqual(['light.(unknown)', 'dark.(unknown)', '(unknown)'])
    expect(JSON.stringify(checked)).not.toContain('canary')
  })

  test.each([[undefined], [null], ['a theme'], [7], [[]]])(
    '%p is no theme: nothing is handed on',
    (theme) => {
      expect(checkTheme(theme as never)).toEqual({ theme: {}, refused: [] })
    }
  )

  test('a scheme that is no object is left out', () => {
    expect(checkTheme({ light: '#000000', dark: null } as never)).toEqual({
      theme: {},
      refused: [],
    })
  })
})

describe('<TulaAuthView>', () => {
  test('hands the native view the mode, the checked theme and the redirect URL, and nothing of the facade', () => {
    const f = fake()
    const tula = screens(f)
    const theme = { light: { primary: '#0f766e', link: HOSTILE }, radius: '6px' }
    render(
      <TulaAuthView
        tula={tula}
        mode='sign-up'
        theme={theme}
        redirectUrl='com.example.app:/oauth'
        style={{ flex: 1 }}
        testID='auth'
      />
    )
    const drawn = last(f.auth)
    expect(Object.keys(drawn).sort()).toEqual([
      'mode',
      'onSignedIn',
      'redirectUrl',
      'style',
      'testID',
      'theme',
    ])
    expect(drawn.mode).toBe('sign-up')
    expect(drawn.theme).toEqual({ light: { primary: '#0f766e' }, radius: '6px' })
    expect(drawn.redirectUrl).toBe('com.example.app:/oauth')
    expect(drawn.style).toEqual({ flex: 1 })
    expect(drawn.testID).toBe('auth')
    expect(JSON.stringify(drawn)).not.toContain('canary')
    expect(f.account).toEqual([])
  })

  test.each([
    [undefined, 'sign-in'],
    ['sign-in', 'sign-in'],
    ['sign-up', 'sign-up'],
    ['reset', 'sign-in'],
    [7, 'sign-in'],
  ])('the mode %p is drawn as %p', (mode, expected) => {
    const f = fake()
    render(<TulaAuthView tula={screens(f)} mode={mode as never} />)
    expect(last(f.auth).mode).toBe(expected)
  })

  test('a redirect URL that is no string is not handed on', () => {
    const f = fake()
    render(<TulaAuthView tula={screens(f)} redirectUrl={{ href: 'x' } as never} />)
    expect(last(f.auth).redirectUrl).toBeUndefined()
  })

  test('`onSignedIn` is called with nothing, whatever the native event carries', () => {
    const f = fake()
    const got: unknown[][] = []
    render(<TulaAuthView tula={screens(f)} onSignedIn={(...args: unknown[]) => got.push(args)} />)
    const told = last(f.auth).onSignedIn as (event: unknown) => void
    told({ nativeEvent: { accessToken: ACCESS, url: 'https://evil.example/next' } })
    expect(got).toEqual([[]])
  })

  test('without `onSignedIn` the native event is taken and nothing happens', () => {
    const f = fake()
    render(<TulaAuthView tula={screens(f)} />)
    expect(() => (last(f.auth).onSignedIn as (event: unknown) => void)({})).not.toThrow()
  })

  test('the tokens of refused values are reported once per theme, after the render, never a value', () => {
    const f = fake()
    const tula = screens(f)
    const theme = { light: { primary: HOSTILE }, radius: '6px' }
    const reported: (readonly string[])[] = []
    const view = (given: object) => (
      <StrictMode>
        <TulaAuthView
          tula={tula}
          theme={given}
          onThemeRefused={(tokens) => reported.push(tokens)}
        />
      </StrictMode>
    )
    const { rerender } = render(view(theme))
    rerender(view(theme))
    // StrictMode runs an effect twice on mount; a rerender with the same theme adds nothing.
    expect(reported.length).toBeLessThanOrEqual(2)
    expect(reported.every((tokens) => tokens.join() === 'light.primary')).toBe(true)
    expect(reported.length).toBeGreaterThan(0)
    const before = reported.length
    rerender(view({ radius: '6px' }))
    expect(reported).toHaveLength(before)
    expect(JSON.stringify(reported)).not.toContain('canary')
  })

  test('the same theme object gives the native view the same prop: no new theme per render', () => {
    const f = fake()
    const tula = screens(f)
    const theme = { radius: '6px' }
    const { rerender } = render(<TulaAuthView tula={tula} theme={theme} mode='sign-in' />)
    rerender(<TulaAuthView tula={tula} theme={theme} mode='sign-up' />)
    expect(f.auth.length).toBeGreaterThanOrEqual(2)
    expect(last(f.auth).theme).toBe(f.auth[0]?.theme)
  })

  test.each([undefined, null, {}, { getToken: () => ACCESS }])(
    '`tula` of %p is refused',
    (tula) => {
      const f = fake()
      screens(f)
      expect(() => TulaAuthView({ tula: tula as never })).toThrow(TypeError)
      expect(() => TulaAccountView({ tula: tula as never })).toThrow(TypeError)
    }
  )

  test('a copy of the facade is not the facade', () => {
    const f = fake()
    const tula = screens(f)
    expect(() => TulaAuthView({ tula: { ...tula } })).toThrow(TypeError)
  })
})

describe('<TulaAccountView>', () => {
  test('hands the native view the checked theme and nothing of the session', () => {
    const f = fake('android')
    const tula = screens(f)
    f.emit({ status: 'signed-in', sessionId: 'ses_1', userId: 'usr_1' })
    render(
      <TulaAccountView
        tula={tula}
        theme={{ dark: { text: '#ffffff' }, spacing: HOSTILE }}
        testID='account'
      />
    )
    const drawn = last(f.account)
    expect(Object.keys(drawn).sort()).toEqual(['onSignedOut', 'style', 'testID', 'theme'])
    expect(drawn.theme).toEqual({ dark: { text: '#ffffff' } })
    expect(JSON.stringify(drawn)).not.toContain('ses_1')
    expect(JSON.stringify(drawn)).not.toContain('canary')
    expect(f.auth).toEqual([])
  })

  test('`onSignedOut` is called with nothing', () => {
    const f = fake()
    const got: unknown[][] = []
    render(
      createElement(TulaAccountView, {
        tula: screens(f),
        onSignedOut: (...args: unknown[]) => got.push(args),
      })
    )
    ;(last(f.account).onSignedOut as (event: unknown) => void)({
      nativeEvent: { reason: NATIVE_TEXT },
    })
    expect(got).toEqual([[]])
    // And without the callback nothing happens.
    const g = fake()
    render(<TulaAccountView tula={screens(g)} />)
    expect(() => (last(g.account).onSignedOut as (event: unknown) => void)({})).not.toThrow()
  })
})

describe('two set-ups', () => {
  test('each is its own facade, and the module decides whether the second is allowed', () => {
    const f = fake()
    const first = screens(f)
    const second = screens(f)
    expect(first).not.toBe(second)
    expect(f.configured).toHaveLength(2)
    f.next.configure = () => {
      throw nativeError('screens.already_configured')
    }
    expect(() => screens(f, { baseUrl: 'https://other.example.com' })).toThrow(
      SCREENS_MESSAGES['screens.already_configured']
    )
  })
})
