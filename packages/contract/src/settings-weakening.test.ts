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
        s.sessions.profiles.admin = { ...s.sessions.profiles.web, jwtTemplate: 'spare' }
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
        s.sessions.profiles.admin = { ...s.sessions.profiles.web }
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
