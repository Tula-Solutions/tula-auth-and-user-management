import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  type EnvironmentSettings,
  EnvironmentSettingsSchema,
} from './environment-settings'
import { settingsWeakenings } from './settings-weakening'

const base: EnvironmentSettings = EnvironmentSettingsSchema.parse({
  password: {
    ...DEFAULT_ENVIRONMENT_SETTINGS.password,
    preset: 'custom',
    minLength: 12,
    requireNumber: true,
    minCharacterClasses: 3,
    maxRepeatedChars: 3,
    history: 5,
    breachCheck: 'block',
  },
  mfa: { policy: 'required' },
  sessions: { maxPerUser: 5 },
})

function changed(patch: (settings: EnvironmentSettings) => void): EnvironmentSettings {
  const next = structuredClone(base)
  patch(next)
  return next
}

describe('settingsWeakenings', () => {
  test('the same document weakens nothing', () => {
    expect(settingsWeakenings(base, structuredClone(base))).toEqual([])
  })

  test.each([
    [
      'a shorter minimum',
      (s) => {
        s.password.minLength = 10
      },
      ['password.minLength'],
    ],
    [
      'a laxer breach check',
      (s) => {
        s.password.breachCheck = 'warn'
      },
      ['password.breachCheck'],
    ],
    [
      'a rule switched off',
      (s) => {
        s.password.requireNumber = false
      },
      ['password.requireNumber'],
    ],
    [
      'fewer character classes',
      (s) => {
        s.password.minCharacterClasses = 2
      },
      ['password.minCharacterClasses'],
    ],
    [
      'longer runs allowed',
      (s) => {
        s.password.maxRepeatedChars = null
      },
      ['password.maxRepeatedChars'],
    ],
    [
      'a shorter history',
      (s) => {
        s.password.history = 0
      },
      ['password.history'],
    ],
    [
      'a notice switched off',
      (s) => {
        s.notifications.newSignIn = false
      },
      ['notifications.newSignIn'],
    ],
    [
      'a weaker MFA policy',
      (s) => {
        s.mfa.policy = 'optional'
      },
      ['mfa.policy'],
    ],
    [
      'a raised session limit',
      (s) => {
        s.sessions.maxPerUser = 10
      },
      ['sessions.maxPerUser'],
    ],
    [
      'a removed session limit',
      (s) => {
        s.sessions.maxPerUser = null
      },
      ['sessions.maxPerUser'],
    ],
    [
      'a longer idle timeout',
      (s) => {
        s.sessions.profiles.web.idleTimeout = '90d'
      },
      ['sessions.profiles.web'],
    ],
    [
      'a profile clients may now select',
      (s) => {
        s.sessions.profiles.mobile.clientSelectable = true
      },
      ['sessions.profiles.mobile'],
    ],
    [
      'several at once, in document order',
      (s) => {
        s.mfa.policy = 'off'
        s.password.minLength = 8
      },
      ['password.minLength', 'mfa.policy'],
    ],
  ] as [string, (settings: EnvironmentSettings) => void, string[]][])(
    '%s',
    (_name, patch, expected) => {
      expect(settingsWeakenings(base, changed(patch))).toEqual(expected)
    }
  )

  test.each([
    [
      'a longer minimum',
      (s) => {
        s.password.minLength = 16
      },
    ],
    [
      'a method switched off',
      (s) => {
        s.signIn.methods.password.enabled = false
      },
    ],
    [
      'another app name',
      (s) => {
        s.app.name = 'Other'
      },
    ],
    [
      'a lower session limit',
      (s) => {
        s.sessions.maxPerUser = 2
      },
    ],
  ] as [string, (settings: EnvironmentSettings) => void][])(
    '%s is not a weakening',
    (_name, patch) => {
      expect(settingsWeakenings(base, changed(patch))).toEqual([])
    }
  )

  test.each([
    ['a period where there was none', null, 365, true],
    ['a shorter period', 365, 30, true],
    ['the shortest period, from none', null, 1, true],
    ['a longer period', 30, 365, false],
    ['the same period', 30, 30, false],
    ['no period where there was one', 365, null, false],
    ['none, as before', null, null, false],
  ] as [string, number | null, number | null, boolean][])(
    'audit retention: %s (%p to %p) is a weakening: %p',
    (_name, was, is, weaker) => {
      const before = changed((s) => {
        s.audit.retentionDays = was
      })
      const after = changed((s) => {
        s.audit.retentionDays = is
      })
      expect(settingsWeakenings(before, after)).toEqual(weaker ? ['audit.retentionDays'] : [])
    }
  )

  test('the audit period is listed in document order, between the password and the notices', () => {
    const after = changed((s) => {
      s.password.minLength = 10
      s.audit.retentionDays = 30
      s.notifications.newSignIn = false
    })
    expect(settingsWeakenings(base, after)).toEqual([
      'password.minLength',
      'audit.retentionDays',
      'notifications.newSignIn',
    ])
  })

  test('a new profile clients may select that outlives web is a weakening; a tighter one is not', () => {
    const loose = changed((s) => {
      s.sessions.profiles.kiosk = {
        ...s.sessions.profiles.web,
        idleTimeout: '365d',
        absoluteTimeout: null,
        clientSelectable: true,
      }
    })
    expect(settingsWeakenings(base, loose)).toEqual(['sessions.profiles.kiosk'])
    const tight = changed((s) => {
      s.sessions.profiles.kiosk = { ...s.sessions.profiles.web, clientSelectable: true }
    })
    expect(settingsWeakenings(base, tight)).toEqual([])
  })

  test('a removed profile is compared with the web profile its sessions fall back to', () => {
    const before = changed((s) => {
      s.sessions.profiles.kiosk = {
        ...s.sessions.profiles.web,
        idleTimeout: '5m',
        accessTokenTtl: '1m',
      }
    })
    expect(settingsWeakenings(before, base)).toEqual(['sessions.profiles.kiosk'])
  })
})

describe('settingsWeakenings and device binding', () => {
  // ADR 0043: a profile's `deviceBinding` says what a sign-in that is not a browser's is held
  // to. Asking less than before is a weakening; asking more is not.
  type Binding = 'none' | 'optional' | 'required'
  const ORDER: Binding[] = ['none', 'optional', 'required']

  function withBinding(mobile: Binding, extra: Record<string, unknown> = {}): EnvironmentSettings {
    return EnvironmentSettingsSchema.parse({
      sessions: { profiles: { mobile: { deviceBinding: mobile }, ...extra } },
    })
  }

  // Every pair of values, on the built-in `mobile` and on a profile an environment added.
  const pairs = ORDER.flatMap((was) => ORDER.map((is) => [was, is] as const))

  test.each(pairs)('mobile from %s to %s', (was, is) => {
    const looser = ORDER.indexOf(is) < ORDER.indexOf(was)
    expect(settingsWeakenings(withBinding(was), withBinding(is))).toEqual(
      looser ? ['sessions.profiles.mobile.deviceBinding'] : []
    )
  })

  test.each(pairs)('an added profile from %s to %s', (was, is) => {
    const looser = ORDER.indexOf(is) < ORDER.indexOf(was)
    expect(
      settingsWeakenings(
        withBinding('optional', { kiosk: { deviceBinding: was } }),
        withBinding('optional', { kiosk: { deviceBinding: is } })
      )
    ).toEqual(looser ? ['sessions.profiles.kiosk.deviceBinding'] : [])
  })

  test('it is listed beside what else got weaker, under its own path', () => {
    const before = withBinding('required')
    const after = structuredClone(before)
    after.sessions.profiles.mobile.deviceBinding = 'none'
    after.sessions.profiles.mobile.idleTimeout = '30d'
    expect(settingsWeakenings(before, after)).toEqual([
      'sessions.profiles.mobile',
      'sessions.profiles.mobile.deviceBinding',
    ])
  })

  test('the web profile has no exception: the rule errs towards asking', () => {
    const before = EnvironmentSettingsSchema.parse({
      sessions: { profiles: { web: { deviceBinding: 'required' } } },
    })
    expect(settingsWeakenings(before, EnvironmentSettingsSchema.parse({}))).toEqual([
      'sessions.profiles.web.deviceBinding',
    ])
  })

  test('a removed profile is compared with mobile, which a native client that named it now gets', () => {
    const before = withBinding('optional', {
      vault: { deviceBinding: 'required', clientSelectable: true },
    })
    expect(settingsWeakenings(before, withBinding('optional'))).toEqual([
      'sessions.profiles.vault.deviceBinding',
    ])
    expect(settingsWeakenings(before, withBinding('required'))).toEqual([])
  })

  test('a new selectable profile is a way round a requirement, and only round a requirement', () => {
    const selectable = { clientSelectable: true }
    // Under `required` on mobile, a profile a client may name that asks less.
    for (const binding of ['none', 'optional'] as const) {
      expect(
        settingsWeakenings(
          withBinding('required'),
          withBinding('required', { kiosk: { ...selectable, deviceBinding: binding } })
        )
      ).toEqual(['sessions.profiles.kiosk.deviceBinding'])
    }
    expect(
      settingsWeakenings(
        withBinding('required'),
        withBinding('required', { kiosk: { ...selectable, deviceBinding: 'required' } })
      )
    ).toEqual([])
    // Nobody can get a profile clients may not select.
    expect(
      settingsWeakenings(
        withBinding('required'),
        withBinding('required', { kiosk: { deviceBinding: 'none' } })
      )
    ).toEqual([])
    // Under `optional` the client already chooses: a `none` profile takes nothing away.
    expect(
      settingsWeakenings(
        withBinding('optional'),
        withBinding('optional', { kiosk: { ...selectable, deviceBinding: 'none' } })
      )
    ).toEqual([])
  })
})

describe('settingsWeakenings and SMS', () => {
  // A text message costs the operator money, and what an attacker can make an environment
  // send in a day is bounded by the daily limit (ADR 0037): raising it is a weakening. While
  // no texted code signs anyone in (the method is off here), the switch and the country list
  // are not.
  const sms = (enabled: boolean, allowedCountries: string[], dailyMessageLimit = 500) => ({
    enabled,
    allowedCountries,
    dailyMessageLimit,
  })

  test.each([
    ['switched on', sms(false, []), sms(true, ['DE'])],
    ['switched off', sms(true, ['DE']), sms(false, ['DE'])],
    ['a country added', sms(true, ['DE']), sms(true, ['DE', 'US'])],
    ['a country removed', sms(true, ['DE', 'US']), sms(true, ['DE'])],
    ['the daily limit lowered', sms(true, ['DE'], 500), sms(true, ['DE'], 100)],
    ['the daily limit as it was', sms(true, ['DE'], 500), sms(true, ['DE'], 500)],
  ])('%s is not a weakening', (_name, was, is) => {
    const before = EnvironmentSettingsSchema.parse({ sms: was })
    const after = EnvironmentSettingsSchema.parse({ sms: is })
    expect(settingsWeakenings(before, after)).toEqual([])
  })

  test.each([
    ['by one', sms(true, ['DE'], 500), sms(true, ['DE'], 501)],
    ['while text messages are off', sms(false, [], 500), sms(false, [], 5000)],
    ['with a country taken away', sms(true, ['DE', 'US'], 500), sms(true, ['DE'], 5000)],
  ])('the daily limit raised %s is a weakening', (_name, was, is) => {
    const before = EnvironmentSettingsSchema.parse({ sms: was })
    const after = EnvironmentSettingsSchema.parse({ sms: is })
    expect(settingsWeakenings(before, after)).toEqual(['sms.dailyMessageLimit'])
  })
})

describe('settingsWeakenings and a texted code as the second step', () => {
  const doc = (policy: 'off' | 'optional' | 'required', enabled: boolean) =>
    EnvironmentSettingsSchema.parse({ mfa: { policy, smsCode: { enabled } } })

  test('switched on where a second step is required, it is listed', () => {
    // A required second step may then be a text message: the weakest one there is.
    expect(settingsWeakenings(doc('required', false), doc('required', true))).toEqual([
      'mfa.smsCode',
    ])
  })

  test.each([
    ['switched on under an optional policy', doc('optional', false), doc('optional', true)],
    ['switched on with the policy off', doc('off', false), doc('off', true)],
    ['switched off under a required policy', doc('required', true), doc('required', false)],
    ['left on under a required policy', doc('required', true), doc('required', true)],
    [
      'the policy made required over a switch that was on',
      doc('optional', true),
      doc('required', true),
    ],
  ])('%s is not a weakening', (_name, before, after) => {
    expect(settingsWeakenings(before, after)).toEqual([])
  })

  test('switched on together with a weaker policy, only the policy is listed', () => {
    expect(settingsWeakenings(doc('required', false), doc('optional', true))).toEqual([
      'mfa.policy',
    ])
  })

  test('switched on together with a policy made required, it is listed', () => {
    expect(settingsWeakenings(doc('optional', false), doc('required', true))).toEqual([
      'mfa.smsCode',
    ])
  })
})

describe('settingsWeakenings and signing in with a texted code', () => {
  const doc = (smsCode: boolean, enabled: boolean, allowedCountries: string[]) =>
    EnvironmentSettingsSchema.parse({
      signIn: { methods: { smsCode: { enabled: smsCode } } },
      sms: { enabled, allowedCountries },
    })

  test.each([
    ['the method switched on', doc(false, true, ['DE']), doc(true, true, ['DE'])],
    [
      'text messages switched on under a method that was on',
      doc(true, false, ['DE']),
      doc(true, true, ['DE']),
    ],
    [
      'a first country allowed under a method that was on',
      doc(true, true, []),
      doc(true, true, ['DE']),
    ],
    ['everything switched on at once', doc(false, false, []), doc(true, true, ['DE', 'US'])],
  ])('%s is listed as the method', (_name, before, after) => {
    expect(settingsWeakenings(before, after)).toEqual(['signIn.methods.smsCode'])
  })

  test.each([
    [
      'the method switched on while text messages are off',
      doc(false, false, []),
      doc(true, false, []),
    ],
    ['the method switched on with no country', doc(false, true, []), doc(true, true, [])],
    ['the method switched off', doc(true, true, ['DE']), doc(false, true, ['DE'])],
    ['text messages switched off', doc(true, true, ['DE']), doc(true, false, ['DE'])],
    ['a country removed', doc(true, true, ['DE', 'US']), doc(true, true, ['DE'])],
    ['the countries reordered', doc(true, true, ['DE', 'US']), doc(true, true, ['US', 'DE'])],
    [
      'a country added while the method is off',
      doc(false, true, ['DE']),
      doc(false, true, ['DE', 'US']),
    ],
    ['nothing changed', doc(true, true, ['DE']), doc(true, true, ['DE'])],
  ])('%s is not a weakening', (_name, before, after) => {
    expect(settingsWeakenings(before, after)).toEqual([])
  })

  test.each([
    ['one added', ['DE'], ['DE', 'US']],
    ['one swapped for another', ['DE'], ['US']],
  ])('a country that was not allowed, while a texted code signs in: %s', (_name, was, is) => {
    expect(settingsWeakenings(doc(true, true, was), doc(true, true, is))).toEqual([
      'sms.allowedCountries',
    ])
  })

  test('the paths come last, after the daily limit', () => {
    const before = EnvironmentSettingsSchema.parse({
      sms: { enabled: true, allowedCountries: ['DE'] },
    })
    const after = EnvironmentSettingsSchema.parse({
      signIn: { methods: { smsCode: { enabled: true } } },
      sms: { enabled: true, allowedCountries: ['DE'], dailyMessageLimit: 501 },
    })
    expect(settingsWeakenings(before, after)).toEqual([
      'sms.dailyMessageLimit',
      'signIn.methods.smsCode',
    ])
  })
})

describe('settingsWeakenings and custom claims', () => {
  const templated: EnvironmentSettings = EnvironmentSettingsSchema.parse({
    sessions: {
      jwtTemplates: {
        app: { claims: { role: { value: 'member' }, email: { from: 'user.email' } } },
        spare: { claims: { plan: { value: 'free' } } },
      },
      profiles: {
        web: { jwtTemplate: 'app' },
        admin: { jwtTemplate: 'app' },
      },
    },
  })

  function after(patch: (settings: EnvironmentSettings) => void): EnvironmentSettings {
    const next = structuredClone(templated)
    patch(next)
    return next
  }

  // What an application may be authorizing on is gone or means something else.
  test.each([
    [
      'a profile stops using its template',
      (s) => {
        s.sessions.profiles.web.jwtTemplate = null
      },
      ['sessions.profiles.web.jwtTemplate'],
    ],
    [
      'a claim is removed from a template in use: every profile that uses it',
      (s) => {
        s.sessions.jwtTemplates.app = { claims: { email: { from: 'user.email' } } }
      },
      ['sessions.profiles.web.jwtTemplate', 'sessions.profiles.admin.jwtTemplate'],
    ],
    [
      'a claim’s constant changes',
      (s) => {
        s.sessions.jwtTemplates.app = {
          claims: { role: { value: 'admin' }, email: { from: 'user.email' } },
        }
      },
      ['sessions.profiles.web.jwtTemplate', 'sessions.profiles.admin.jwtTemplate'],
    ],
    [
      'a claim’s source changes',
      (s) => {
        s.sessions.jwtTemplates.app = {
          claims: { role: { value: 'member' }, email: { from: 'session.client' } },
        }
      },
      ['sessions.profiles.web.jwtTemplate', 'sessions.profiles.admin.jwtTemplate'],
    ],
    [
      'a profile switches to a template without one of its claims',
      (s) => {
        s.sessions.profiles.admin = {
          ...s.sessions.profiles.web,
          deviceBinding: 'optional',
          jwtTemplate: 'spare',
        }
      },
      ['sessions.profiles.admin.jwtTemplate'],
    ],
    [
      'a profile is removed and the built-in it falls back to lacks its claims',
      (s) => {
        delete s.sessions.profiles.admin
        s.sessions.profiles.web.jwtTemplate = 'spare'
      },
      ['sessions.profiles.web.jwtTemplate', 'sessions.profiles.admin.jwtTemplate'],
    ],
  ] as [string, (settings: EnvironmentSettings) => void, string[]][])(
    '%s',
    (_name, patch, expected) => {
      expect(settingsWeakenings(templated, after(patch))).toEqual(expected)
    }
  )

  test.each([
    [
      'a new template',
      (s) => {
        s.sessions.jwtTemplates.extra = { claims: { a: { value: 1 } } }
      },
    ],
    [
      'a claim added to a template in use',
      (s) => {
        s.sessions.jwtTemplates.app = {
          claims: {
            role: { value: 'member' },
            email: { from: 'user.email' },
            beta: { value: true },
          },
        }
      },
    ],
    [
      'a profile starts using a template',
      (s) => {
        s.sessions.profiles.mobile.jwtTemplate = 'spare'
      },
    ],
    [
      'a template no profile uses is changed',
      (s) => {
        s.sessions.jwtTemplates.spare = { claims: {} }
      },
    ],
    [
      'a template no profile uses is removed',
      (s) => {
        delete s.sessions.jwtTemplates.spare
      },
    ],
    [
      'a template is renamed and its profiles follow',
      (s) => {
        s.sessions.jwtTemplates.renamed = {
          claims: { role: { value: 'member' }, email: { from: 'user.email' } },
        }
        delete s.sessions.jwtTemplates.app
        s.sessions.profiles.web.jwtTemplate = 'renamed'
        s.sessions.profiles.admin = { ...s.sessions.profiles.web, deviceBinding: 'optional' }
      },
    ],
    [
      'the claims are written in another order',
      (s) => {
        s.sessions.jwtTemplates.app = {
          claims: { email: { from: 'user.email' }, role: { value: 'member' } },
        }
      },
    ],
    [
      'a profile is removed and the built-in carries the same claims',
      (s) => {
        delete s.sessions.profiles.admin
      },
    ],
  ] as [string, (settings: EnvironmentSettings) => void][])(
    '%s is not a weakening',
    (_name, patch) => {
      expect(settingsWeakenings(templated, after(patch))).toEqual([])
    }
  )

  test('a stored profile naming a template that is gone had no claims to lose', () => {
    const before = after((s) => {
      s.sessions.profiles.web.jwtTemplate = 'gone'
    })
    const next = after((s) => {
      s.sessions.profiles.web.jwtTemplate = null
    })
    expect(settingsWeakenings(before, next)).toEqual([])
  })
})
