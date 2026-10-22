import { afterEach, describe, expect, jest, mock, spyOn, test } from 'bun:test'
import { act, renderHook, screen } from '@testing-library/react'
import { TulaError } from '@tula-tech/core'
import type { ReactNode } from 'react'
import { StepRenderer } from '../components/step-renderer'
import { TulaProvider } from '../context'
import {
  type FirstFactorFormProps,
  type FirstFactorForms,
  firstFactorStrategies,
  useCountdown,
  useFieldErrors,
  useLocalization,
  usePasskeySupport,
  useRetryCountdown,
} from '../index'
import { type World, world } from '../testing/harness'

afterEach(() => {
  jest.useRealTimers()
  mock.restore()
})

const wrapperOf = (w: World, props: object = {}) =>
  function Wrapper(wrapped: { children: ReactNode }) {
    return (
      <TulaProvider client={w.client} {...props}>
        {wrapped.children}
      </TulaProvider>
    )
  }

describe('usePasskeySupport', () => {
  test('is undefined until the browser has been asked after mount, then the answer', async () => {
    const w = world()
    const asked = spyOn(w.client.signIn, 'canUsePasskey').mockReturnValue(true)
    const seen: (boolean | undefined)[] = []
    function Probe() {
      seen.push(usePasskeySupport())
      return null
    }
    w.mount(<Probe />)
    // The first render happened before anything asked: "not known" is not "no".
    expect(seen[0]).toBeUndefined()
    expect(asked).toHaveBeenCalled()
    expect(seen.at(-1)).toBe(true)
  })

  test('false in a browser without WebAuthn', () => {
    const w = world()
    spyOn(w.client.signIn, 'canUsePasskey').mockReturnValue(false)
    const { result } = renderHook(() => usePasskeySupport(), { wrapper: wrapperOf(w) })
    expect(result.current).toBe(false)
  })
})

describe('useLocalization', () => {
  test('is the English table with the provider’s overrides merged in', () => {
    const w = world()
    const { result } = renderHook(() => useLocalization(), {
      wrapper: wrapperOf(w, { localization: { signIn: { title: 'Log in' } } }),
    })
    expect(result.current.signIn.title).toBe('Log in')
    // What was not overridden is the default.
    expect(result.current.unsupported.restart).toBe('Start again')
  })
})

describe('useFieldErrors', () => {
  const FIELDS = ['email', 'password'] as const
  const error = (init: Partial<ConstructorParameters<typeof TulaError>[0]>) =>
    new TulaError({ code: 'validation.failed', message: 'Check the form.', status: 422, ...init })

  test('no error places nothing', () => {
    const { result } = renderHook(() => useFieldErrors(null, FIELDS))
    expect(result.current).toEqual({ form: null, fields: {} })
  })

  test('the field the server named, else the code’s area', () => {
    const named = renderHook(() =>
      useFieldErrors(
        error({
          errors: [
            { field: 'password', code: 'password.too_short', message: 'Too short', params: {} },
          ],
        }),
        FIELDS
      )
    )
    expect(named.result.current.fields).toEqual({ password: ['Too short'] })
    expect(named.result.current.form).toBeNull()
    const byArea = renderHook(() =>
      useFieldErrors(
        error({ code: 'email.invalid', message: 'Not an address', errors: [] }),
        FIELDS
      )
    )
    expect(byArea.result.current.fields).toEqual({ email: ['Not an address'] })
  })

  test('a problem of no field of this form is the form’s', () => {
    const { result } = renderHook(() =>
      useFieldErrors(error({ code: 'rate_limited', message: 'Slow down.', status: 429 }), FIELDS)
    )
    expect(result.current).toEqual({ form: 'Slow down.', fields: {} })
  })

  test('invalid credentials are shown where the form says, and nowhere without one', () => {
    const wrong = error({ code: 'auth.invalid_credentials', message: 'Wrong.', status: 401 })
    const at = renderHook(() => useFieldErrors(wrong, FIELDS, 'password'))
    expect(at.result.current.fields).toEqual({ password: ['Wrong.'] })
    const none = renderHook(() => useFieldErrors(wrong, FIELDS))
    expect(none.result.current).toEqual({ form: 'Wrong.', fields: {} })
  })

  test('the same error gives the same object, so a memoised form does not redraw', () => {
    const failed = error({ code: 'email.invalid', message: 'Not an address' })
    const { result, rerender } = renderHook(() => useFieldErrors(failed, FIELDS))
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })
})

describe('useCountdown', () => {
  test('counts whole seconds down once a second and stops at zero', () => {
    jest.useFakeTimers()
    const until = Date.now() + 3_000
    const { result } = renderHook(() => useCountdown(until))
    expect(result.current).toBe(3)
    act(() => {
      jest.advanceTimersByTime(1_000)
    })
    expect(result.current).toBe(2)
    act(() => {
      jest.advanceTimersByTime(5_000)
    })
    expect(result.current).toBe(0)
  })

  test('no moment, or one already past, is zero and starts no timer', () => {
    jest.useFakeTimers()
    expect(renderHook(() => useCountdown(null)).result.current).toBe(0)
    expect(renderHook(() => useCountdown(Date.now() - 1)).result.current).toBe(0)
  })
})

describe('useRetryCountdown', () => {
  const limited = (retryAfterMs: number | undefined) =>
    new TulaError({ code: 'rate_limited', message: 'Slow down.', status: 429, retryAfterMs })

  test('counts down the wait the error carries, read from the clock after render', () => {
    jest.useFakeTimers()
    const failed = limited(4_000)
    const { result } = renderHook(() => useRetryCountdown(failed))
    expect(result.current).toBe(4)
    act(() => {
      jest.advanceTimersByTime(2_000)
    })
    expect(result.current).toBe(2)
  })

  test('lags the error by one commit: the first value is 0, the next is the wait', () => {
    jest.useFakeTimers()
    const failed = limited(4_000)
    const seen: number[] = []
    renderHook(() => {
      const seconds = useRetryCountdown(failed)
      seen.push(seconds)
      return seconds
    })
    // The render that first saw the error could not read the clock; the effect's commit did.
    expect(seen[0]).toBe(0)
    expect(seen.at(-1)).toBe(4)
  })

  test('an error without a wait, and no error, are zero', () => {
    jest.useFakeTimers()
    expect(renderHook(() => useRetryCountdown(limited(undefined))).result.current).toBe(0)
    expect(renderHook(() => useRetryCountdown(null)).result.current).toBe(0)
  })

  test('a new error restarts the wait, and clearing the error ends it', () => {
    jest.useFakeTimers()
    const { result, rerender } = renderHook(
      (props: { error: TulaError | null }) => useRetryCountdown(props.error),
      { initialProps: { error: limited(2_000) as TulaError | null } }
    )
    expect(result.current).toBe(2)
    rerender({ error: limited(9_000) })
    expect(result.current).toBe(9)
    rerender({ error: null })
    expect(result.current).toBe(0)
  })
})

describe('firstFactorStrategies', () => {
  const Form = (_props: FirstFactorFormProps) => null
  const forms: FirstFactorForms = {
    password: Form,
    email_code: Form,
    email_link: Form,
    passkey: Form,
    sms_code: Form,
  }
  const can = { link: true, passkey: true, phone: false }

  test('keeps the server’s order and skips a strategy the table has no form for', () => {
    expect(firstFactorStrategies(['email_code', 'password', 'google'], forms, can)).toEqual([
      'email_code',
      'password',
    ])
    expect(firstFactorStrategies(['password', 'email_code'], { password: Form }, can)).toEqual([
      'password',
    ])
  })

  test('a name that is only on the object’s prototype is not a strategy', () => {
    expect(firstFactorStrategies(['constructor', 'toString'], forms, can)).toEqual([])
  })

  test('rules out a link, a passkey or a texted code the browser or the identifier cannot use', () => {
    const offered = ['password', 'email_link', 'passkey', 'sms_code']
    expect(
      firstFactorStrategies(offered, forms, { link: false, passkey: false, phone: false })
    ).toEqual(['password'])
  })

  describe('a passkey is hidden until known, decided here for both lists', () => {
    const offered = ['password', 'passkey']
    const withSupport = (passkey: boolean | undefined) => ({ ...can, passkey })

    test('the alternatives list: no passkey while support is unknown', () => {
      expect(firstFactorStrategies(offered, forms, withSupport(undefined), 'alternatives')).toEqual(
        ['password']
      )
    })

    test('the alternatives list: the passkey once the browser said true, none for false', () => {
      expect(firstFactorStrategies(offered, forms, withSupport(true), 'alternatives')).toEqual([
        'password',
        'passkey',
      ])
      expect(firstFactorStrategies(offered, forms, withSupport(false), 'alternatives')).toEqual([
        'password',
      ])
    })

    test('the active list keeps a passkey while support is unknown, and drops it for false', () => {
      expect(firstFactorStrategies(['passkey'], forms, withSupport(undefined))).toEqual(['passkey'])
      expect(firstFactorStrategies(['passkey'], forms, withSupport(undefined), 'active')).toEqual([
        'passkey',
      ])
      expect(firstFactorStrategies(['passkey'], forms, withSupport(true))).toEqual(['passkey'])
      expect(firstFactorStrategies(['passkey'], forms, withSupport(false))).toEqual([])
    })
  })

  test('for a phone number a texted code is the only form', () => {
    expect(
      firstFactorStrategies(['password', 'email_code', 'sms_code'], forms, { ...can, phone: true })
    ).toEqual(['sms_code'])
    // Where no texted code is offered for the number, the others stay.
    expect(firstFactorStrategies(['password'], forms, { ...can, phone: true })).toEqual([
      'password',
    ])
  })
})

describe('the headless exports work together', () => {
  test('a copied screen can be built from the step renderer and the hooks alone', () => {
    const w = world()
    spyOn(w.client.signIn, 'canUsePasskey').mockReturnValue(true)
    function Screen() {
      const t = useLocalization()
      return <p>{t.signIn.title}</p>
    }
    w.mount(
      <StepRenderer
        step={{ status: 'needs_password' }}
        screens={{ needs_password: () => <Screen /> }}
        onRestart={() => undefined}
      />
    )
    expect(screen.getByText('Sign in')).toBeTruthy()
  })
})
