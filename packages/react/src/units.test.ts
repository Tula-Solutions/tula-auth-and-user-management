import { describe, expect, test } from 'bun:test'
import { TulaError } from '@tula/core'
import { ELEMENT_NAMES, elementProps, mergeAppearance, rootAttributes } from './appearance'
import { attemptsLeft, fieldResolver, formatDuration, placeErrors } from './components/form-errors'
import { deviceName, fullName, initials, relativeTime } from './components/user-display'
import { toTulaError } from './errors'
import { EN_LOCALIZATION, formatText, resolveLocalization } from './localization'
import { go, safeUrl } from './navigation'
import { TEST_USER } from './testing/harness'

describe('safeUrl', () => {
  const page = 'https://app.example.com/sign-in?x=1'
  test.each([
    ['/app', 'https://app.example.com/app'],
    ['app', 'https://app.example.com/app'],
    ['?tab=2', 'https://app.example.com/sign-in?tab=2'],
    ['https://other.example.com/welcome', 'https://other.example.com/welcome'],
    ['http://localhost:3000/', 'http://localhost:3000/'],
  ] as [string, string][])('%s is allowed', (url, resolved) => {
    expect(safeUrl(url, page)).toBe(resolved)
  })

  test.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'blob:https://app.example.com/1',
    'http://[bad',
    '',
    '   ',
    // A destination with no scheme means this origin: a host must be written with its scheme.
    '//evil.example',
    '//evil.example/app',
    '/\\evil.example',
    '\\\\evil.example',
    '/\t/evil.example',
    ' //evil.example',
    '/.//evil.example',
    '/a/..//evil.example',
    '/%2e//evil.example',
  ])('%p is refused', (url) => {
    expect(safeUrl(url, page)).toBeNull()
  })

  test('go() hands a router no destination that names a host without a scheme', () => {
    const seen: string[] = []
    for (const url of ['//evil.example', '/\\evil.example', '/.//evil.example']) {
      expect(go(url, (to) => seen.push(to))).toBe(false)
    }
    expect(seen).toEqual([])
    expect(go('/app', (to) => seen.push(to))).toBe(true)
    expect(seen).toEqual(['/app'])
  })

  test('undefined is refused, and go() does nothing for it', () => {
    expect(safeUrl(undefined, page)).toBeNull()
    expect(go(undefined, () => undefined)).toBe(false)
    expect(go('javascript:alert(1)', () => undefined)).toBe(false)
  })
})

describe('appearance', () => {
  test('every element name is unique and maps to a tula- class and a data attribute', () => {
    expect(new Set(ELEMENT_NAMES).size).toBe(ELEMENT_NAMES.length)
    const el = elementProps({ elements: { primaryButton: 'mine' } })
    expect(el('primaryButton', 'tula-is-pending', false, undefined)).toEqual({
      className: 'tula-primary-button tula-is-pending mine',
      'data-tula-element': 'primaryButton',
    })
    expect(el('card')).toEqual({ className: 'tula-card', 'data-tula-element': 'card' })
  })

  test('an inherited key is not taken for a class name', () => {
    const el = elementProps({ elements: Object.create({ card: 'inherited' }) })
    expect(el('card').className).toBe('tula-card')
  })

  test('mergeAppearance: either side alone is returned as it is', () => {
    const one = { colorScheme: 'dark' as const }
    expect(mergeAppearance(one, undefined)).toBe(one)
    expect(mergeAppearance(undefined, one)).toBe(one)
    expect(mergeAppearance(undefined, undefined)).toEqual({})
    expect(mergeAppearance({ colorScheme: 'dark' }, { elements: { card: 'x' } })).toMatchObject({
      colorScheme: 'dark',
      elements: { card: 'x' },
    })
  })

  test('rootAttributes: `system` forces nothing', () => {
    expect(rootAttributes({ colorScheme: 'system' })).toEqual({})
    expect(rootAttributes({ colorScheme: 'light', theme: {} })).toEqual({
      'data-tula-theme': 'light',
    })
  })
})

describe('localization', () => {
  test('with no overrides the English table itself is used', () => {
    expect(resolveLocalization()).toBe(EN_LOCALIZATION)
  })

  test('only known keys with string values are taken', () => {
    const hostile = JSON.parse(
      '{"signIn":{"title":"Log in","continue":{"html":"<b>"},"nope":"x"},"password":{"rules":{"min_length":"Mínimo {min}"}},"locale":"es","common":"oops","__proto__":{"x":1},"errors":{"rate_limited":"Despacio."}}'
    )
    const resolved = resolveLocalization(hostile)
    expect(resolved.signIn.title).toBe('Log in')
    expect(resolved.signIn.continue).toBe('Continue')
    expect(resolved.locale).toBe('es')
    expect(resolved.common).toEqual(EN_LOCALIZATION.common)
    expect(resolved.password.rules.min_length).toBe('Mínimo {min}')
    expect(resolved.password.rules.number).toBe('One number')
    expect(resolved.errors).toEqual({ rate_limited: 'Despacio.' })
    expect(Object.keys(resolved.signIn)).toEqual(Object.keys(EN_LOCALIZATION.signIn))
    expect(resolveLocalization({ errors: 'x' as unknown as undefined }).errors).toEqual({})
  })

  test('formatText fills placeholders it has values for', () => {
    expect(formatText('{a} and {b} and {toString}', { a: 1 })).toBe('1 and {b} and {toString}')
  })
})

describe('placing errors', () => {
  const error = (init: ConstructorParameters<typeof TulaError>[0]) => new TulaError(init)

  test('no error places nothing', () => {
    expect(placeErrors(null, fieldResolver(['email']))).toEqual({ form: null, fields: {} })
  })

  test('by the server’s field name, then by the code’s area, else above the form', () => {
    const resolve = fieldResolver(['email', 'password', 'code'], 'password')
    expect(resolve('validation.failed', 'email')).toBe('email')
    expect(resolve('password.common', null)).toBe('password')
    expect(resolve('verification.expired', null)).toBe('code')
    expect(resolve('auth.invalid_credentials', null)).toBe('password')
    expect(resolve('rate_limited', null)).toBeNull()
    expect(resolve('constructor.x', null)).toBeNull()
    expect(fieldResolver(['email'])('auth.invalid_credentials', null)).toBeNull()
    expect(fieldResolver(['email'])('password.common', 'password')).toBeNull()
  })

  test('the same message is listed once', () => {
    const placed = placeErrors(
      error({
        code: 'password.too_short',
        message: 'Password is too short.',
        errors: [
          { field: 'password', code: 'password.too_short', message: 'Same.', params: {} },
          { field: 'password', code: 'password.common', message: 'Same.', params: {} },
        ],
      }),
      fieldResolver(['password'])
    )
    expect(placed).toEqual({ form: null, fields: { password: ['Same.'] } })
  })

  test('attemptsLeft reads only a real, own, numeric param', () => {
    const t = EN_LOCALIZATION
    expect(attemptsLeft(null, t)).toBeNull()
    expect(attemptsLeft(error({ code: 'x', message: 'x' }), t)).toBeNull()
    expect(
      attemptsLeft(error({ code: 'x', message: 'x', params: { attemptsRemaining: '3' } }), t)
    ).toBeNull()
    expect(
      attemptsLeft(error({ code: 'x', message: 'x', params: { attemptsRemaining: -1 } }), t)
    ).toBeNull()
    expect(
      attemptsLeft(error({ code: 'x', message: 'x', params: { attemptsRemaining: 0 } }), t)
    ).toBe('0 attempts left.')
  })

  test('formatDuration', () => {
    expect(formatDuration(42, EN_LOCALIZATION)).toBe('42s')
    expect(formatDuration(252, EN_LOCALIZATION)).toBe('4m 12s')
  })

  test('toTulaError keeps a TulaError and wraps anything else without showing its message', () => {
    const original = error({ code: 'rate_limited', message: 'Slow down.' })
    expect(toTulaError(original)).toBe(original)
    const wrapped = toTulaError(new TypeError('secret detail'))
    expect(wrapped).toMatchObject({
      code: 'internal',
      message: 'Something went wrong on our side.',
    })
    expect(wrapped.message).not.toContain('secret detail')
  })
})

describe('showing a user and their devices', () => {
  const t = EN_LOCALIZATION

  test('names and initials', () => {
    expect(fullName({ ...TEST_USER, firstName: 'Maya', lastName: 'Torres' })).toBe('Maya Torres')
    expect(fullName({ ...TEST_USER, firstName: null, lastName: null })).toBeNull()
    expect(initials({ ...TEST_USER, firstName: 'maya', lastName: 'torres' })).toBe('MT')
    expect(initials({ ...TEST_USER, firstName: ' ', lastName: null })).toBe('M')
    expect(initials({ ...TEST_USER, firstName: null, lastName: null, email: '' })).toBe('?')
  })

  test.each([
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36 Edg/140.0',
      'Edge on Windows',
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0', 'Firefox on Linux'],
    [
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36',
      'Chrome on Android',
    ],
    [
      'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Safari/604.1',
      'Safari on iPad',
    ],
    [
      'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
      'Chrome on ChromeOS',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36 OPR/110.0',
      'Opera on macOS',
    ],
    ['curl/8.0 Firefox/1.0', 'Firefox'],
    ['MyApp/1.0 (Android)', 'Android'],
    ['<img src=x onerror=alert(1)>', 'Unknown device'],
  ] as [string, string][])('%s is %s', (userAgent, expected) => {
    expect(deviceName({ userAgent }, t)).toBe(expected)
  })

  test('relative times, and values that are not dates', () => {
    const now = Date.parse('2026-10-03T12:00:00.000Z')
    expect(relativeTime('2026-10-01T12:00:00.000Z', now, 'en')).toBe('2 days ago')
    expect(relativeTime('2026-10-03T09:00:00.000Z', now, 'en')).toBe('3 hours ago')
    expect(relativeTime('2026-10-03T11:59:50.000Z', now, 'en')).toBe('this minute')
    expect(relativeTime('2025-09-01T12:00:00.000Z', now, 'en')).toBe('last year')
    expect(relativeTime('2026-08-01T12:00:00.000Z', now, 'en')).toBe('2 months ago')
    expect(relativeTime('not a date', now, 'en')).toBe('not a date')
    expect(relativeTime('2026-10-01T12:00:00.000Z', now, 'not a locale!')).toBe('2026-10-01')
  })
})
