import { describe, expect, test } from 'bun:test'
import { DEFAULT_ENVIRONMENT_SETTINGS } from '@tula/contract'
import { ApiError } from '~/api/errors'
import {
  classifyFailure,
  confirmationTitle,
  describeWeakening,
  etag,
  planSave,
  type SettingsDocument,
} from './model'

const base = structuredClone(DEFAULT_ENVIRONMENT_SETTINGS) as SettingsDocument

function edited(change: (draft: typeof DEFAULT_ENVIRONMENT_SETTINGS) => void): SettingsDocument {
  const draft = structuredClone(DEFAULT_ENVIRONMENT_SETTINGS)
  change(draft)
  return draft as SettingsDocument
}

describe('etag', () => {
  test('quotes the revision, as If-Match wants it', () => {
    expect(etag(0)).toBe('"0"')
    expect(etag(12)).toBe('"12"')
  })
})

describe('planSave', () => {
  test('an unchanged document is not dirty and needs no confirmation', () => {
    const plan = planSave(base, structuredClone(base), null)
    expect(plan).toEqual({
      dirty: false,
      weakenings: [],
      managedBy: null,
      needsConfirmation: false,
    })
  })

  test('a stricter policy is saved without asking', () => {
    const plan = planSave(
      base,
      edited((draft) => {
        draft.password.minLength += 4
      }),
      null
    )
    expect(plan.dirty).toBe(true)
    expect(plan.weakenings).toEqual([])
    expect(plan.needsConfirmation).toBe(false)
  })

  test('a shorter minimum length is a weakening, by the contract’s definition', () => {
    const plan = planSave(
      base,
      edited((draft) => {
        draft.password.minLength = 8
      }),
      null
    )
    expect(plan.weakenings).toEqual(['password.minLength'])
    expect(plan.needsConfirmation).toBe(true)
  })

  test('switching two-step verification off and a notice off are both listed', () => {
    const plan = planSave(
      base,
      edited((draft) => {
        draft.mfa.policy = 'off'
        draft.notifications.newSignIn = false
      }),
      null
    )
    expect(plan.weakenings).toEqual(['notifications.newSignIn', 'mfa.policy'])
  })

  test('settings managed by a config file ask before any change', () => {
    const managedBy = { tool: 'tula-apply', drifted: false }
    const plan = planSave(
      base,
      edited((draft) => {
        draft.app.name = 'Acme'
      }),
      managedBy
    )
    expect(plan.weakenings).toEqual([])
    expect(plan.managedBy).toBe('tula-apply')
    expect(plan.needsConfirmation).toBe(true)
  })

  test('a draft the contract cannot read lists no weakening (the server will refuse it)', () => {
    const broken = { ...base, password: { ...base.password, minLength: 'eight' } }
    const plan = planSave(base, broken as unknown as SettingsDocument, null)
    expect(plan.dirty).toBe(true)
    expect(plan.weakenings).toEqual([])
  })
})

describe('an audit retention period', () => {
  const withPeriod = (retentionDays: number | null): SettingsDocument =>
    ({ ...structuredClone(DEFAULT_ENVIRONMENT_SETTINGS), audit: { retentionDays } }) as never

  test.each([
    ['set where there was none', null, 30, true],
    ['shortened', 365, 30, true],
    ['lengthened', 30, 365, false],
    ['removed', 30, null, false],
  ] as [string, number | null, number | null, boolean][])(
    '%s asks first: %p to %p is %p',
    (_name, was, is, asks) => {
      const plan = planSave(withPeriod(was), withPeriod(is), null)
      expect(plan.weakenings).toEqual(asks ? ['audit.retentionDays'] : [])
      expect(plan.needsConfirmation).toBe(asks)
    }
  )

  test('is described as what it is: a deletion that cannot be undone', () => {
    expect(describeWeakening('audit.retentionDays')).toBe(
      'Audit entries older than the new period are deleted for good, starting with the next retention run'
    )
    expect(confirmationTitle(['audit.retentionDays'])).toBe(
      'This deletes older audit entries for good. Save anyway?'
    )
    expect(confirmationTitle(['mfa.policy', 'audit.retentionDays'])).toBe(
      'This weakens security and deletes older audit entries for good. Save anyway?'
    )
    expect(confirmationTitle(['mfa.policy'])).toBe('This weakens security. Save anyway?')
    expect(confirmationTitle([])).toBe('Change settings managed by a config file?')
  })
})

describe('the daily limit of text messages', () => {
  const withLimit = (dailyMessageLimit: number): SettingsDocument =>
    ({
      ...structuredClone(DEFAULT_ENVIRONMENT_SETTINGS),
      sms: { enabled: true, allowedCountries: ['US'], dailyMessageLimit },
    }) as never

  test.each([
    ['raised', 500, 501, true],
    ['lowered', 500, 100, false],
  ] as [string, number, number, boolean][])(
    '%s asks first: %p to %p is %p',
    (_name, was, is, asks) => {
      const plan = planSave(withLimit(was), withLimit(is), null)
      expect(plan.weakenings).toEqual(asks ? ['sms.dailyMessageLimit'] : [])
      expect(plan.needsConfirmation).toBe(asks)
    }
  )

  test('left out of a draft is the default, and is judged as that', () => {
    const lowered = withLimit(100)
    const emptied = { ...lowered, sms: { enabled: true, allowedCountries: ['US'] } }
    expect(planSave(lowered, emptied as SettingsDocument, null).weakenings).toEqual([
      'sms.dailyMessageLimit',
    ])
  })

  test('is described as what it costs', () => {
    expect(describeWeakening('sms.dailyMessageLimit')).toBe(
      'More text messages may be sent in a day: abuse of this environment’s SMS can cost more'
    )
  })
})

describe('a texted code as the second step', () => {
  const doc = (policy: 'off' | 'optional' | 'required', enabled: boolean): SettingsDocument => {
    const settings = structuredClone(DEFAULT_ENVIRONMENT_SETTINGS)
    settings.mfa = { policy, smsCode: { enabled } }
    return settings as never
  }

  test.each([
    [
      'switched on where a second step is required',
      doc('required', false),
      doc('required', true),
      ['mfa.smsCode'],
    ],
    ['switched on where it is optional', doc('optional', false), doc('optional', true), []],
    ['switched off where it is required', doc('required', true), doc('required', false), []],
  ] as [string, SettingsDocument, SettingsDocument, string[]][])(
    '%s',
    (_name, was, is, weakenings) => {
      const plan = planSave(was, is, null)
      expect(plan.weakenings).toEqual(weakenings)
      expect(plan.needsConfirmation).toBe(weakenings.length > 0)
    }
  )

  test('is described as what it lets through, in words and not as a path', () => {
    expect(describeWeakening('mfa.smsCode')).toBe(
      'The required second step may be a texted code: whoever receives the messages of a user’s number passes it'
    )
  })
})

describe('signing in with a texted code', () => {
  const doc = (
    smsCode: boolean,
    enabled: boolean,
    allowedCountries: string[]
  ): SettingsDocument => {
    const settings = structuredClone(DEFAULT_ENVIRONMENT_SETTINGS)
    settings.signIn.methods.smsCode.enabled = smsCode
    settings.sms = { enabled, allowedCountries, dailyMessageLimit: 500 } as never
    return settings as never
  }

  test.each([
    [
      'the method switched on where text messages are sent',
      doc(false, true, ['US']),
      doc(true, true, ['US']),
      ['signIn.methods.smsCode'],
    ],
    [
      'text messages switched on under the method',
      doc(true, false, ['US']),
      doc(true, true, ['US']),
      ['signIn.methods.smsCode'],
    ],
    [
      'a first country under the method',
      doc(true, true, []),
      doc(true, true, ['US']),
      ['signIn.methods.smsCode'],
    ],
    [
      'the method switched on where no text message is sent',
      doc(false, false, []),
      doc(true, false, []),
      [],
    ],
    [
      'a country added while a texted code signs in',
      doc(true, true, ['US']),
      doc(true, true, ['US', 'DE']),
      ['sms.allowedCountries'],
    ],
    [
      'a country added while it does not',
      doc(false, true, ['US']),
      doc(false, true, ['US', 'DE']),
      [],
    ],
    ['the method switched off', doc(true, true, ['US']), doc(false, true, ['US']), []],
  ] as [string, SettingsDocument, SettingsDocument, string[]][])(
    '%s',
    (_name, was, is, weakenings) => {
      const plan = planSave(was, is, null)
      expect(plan.weakenings).toEqual(weakenings)
      expect(plan.needsConfirmation).toBe(weakenings.length > 0)
    }
  )

  test('is described as what it opens, in words and not as a path', () => {
    expect(describeWeakening('signIn.methods.smsCode')).toBe(
      'A texted code can sign people in: whoever receives the messages of a number an account has proven can enter that account, with no password and no inbox'
    )
    expect(describeWeakening('sms.allowedCountries')).toBe(
      'A texted code can sign in accounts whose phone numbers are in the countries added'
    )
  })
})

describe('describeWeakening', () => {
  test('says a known path in words and keeps an unknown one', () => {
    expect(describeWeakening('password.minLength')).toContain('shorter')
    expect(describeWeakening('sessions.profiles.admin')).toContain('admin')
    // A profile's template is its own sentence, and names the profile alone.
    expect(describeWeakening('sessions.profiles.admin.jwtTemplate')).toBe(
      'Sessions of the “admin” profile lose custom claims, or get different ones: an application that reads them may refuse those users'
    )
    expect(describeWeakening('future.setting')).toBe('future.setting')
  })
})

describe('classifyFailure', () => {
  test('412 is a conflict: the settings changed elsewhere', () => {
    const error = new ApiError({ status: 412, code: 'precondition.failed', detail: 'Stale.' })
    expect(classifyFailure(error)).toBe('conflict')
  })
  test('field errors are a refused document', () => {
    const error = new ApiError({
      status: 422,
      code: 'validation.failed',
      detail: 'Invalid.',
      fieldErrors: [{ field: 'signIn.methods', code: 'validation.failed', message: 'x' }],
    })
    expect(classifyFailure(error)).toBe('invalid')
  })
  test('anything else just failed', () => {
    expect(classifyFailure(new Error('boom'))).toBe('failed')
  })
})
