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
