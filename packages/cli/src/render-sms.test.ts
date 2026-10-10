import { describe, expect, test } from 'bun:test'
import { defineConfig, type EnvironmentConfigInput } from '@tula/config'
import { DEFAULT_ENVIRONMENT_SETTINGS, type EnvironmentSettings } from '@tula/contract'
import { buildPlan, type Plan } from './diff'
import { createOutput } from './output'
import { planWarnings, renderPlan } from './render'

// What an operator reads in a plan about text messages, word for word: the one change that
// weakens nothing and still locks people out is said as a warning (ADR 0025).

const LOCKS_OUT =
  'switches off the texted code as the second step (mfa.smsCode: off in the file, or left out of it): users whose only second step is a texted code cannot sign in until it is on again or an administrator resets their two-step verification'

function plan(
  settings: NonNullable<EnvironmentConfigInput['settings']>,
  change: (server: EnvironmentSettings) => void
): Plan {
  const environment = defineConfig({ environments: { dev: { settings } } }).environments.dev
  if (!environment) {
    throw new Error('fixture')
  }
  const server = structuredClone(DEFAULT_ENVIRONMENT_SETTINGS)
  change(server)
  return buildPlan({ revision: 1, settings: server, managedBy: null, providers: [] }, environment, {
    configHash: `sha256:${'0'.repeat(64)}`,
  })
}

function rendered(result: Plan): string {
  let text = ''
  const sink = { write: (chunk: string) => (text += chunk) }
  renderPlan(
    createOutput(sink, sink, {}),
    { environment: 'dev', apiUrl: 'https://a.example' },
    result
  )
  return text
}

describe('a plan’s words about a texted second step', () => {
  test.each([
    ['leaves it out', { mfa: { policy: 'required' } }],
    ['leaves the whole section out', {}],
    ['writes it off', { mfa: { policy: 'required', smsCode: { enabled: false } } }],
  ] as [string, NonNullable<EnvironmentConfigInput['settings']>][])(
    'a file that %s where the server has it on says who is locked out',
    (_name, settings) => {
      const result = plan(settings, (server) => {
        server.mfa = { policy: 'required', smsCode: { enabled: true } }
      })
      // Nothing gets weaker by it: the contract does not list it, and `--yes` applies it.
      expect(result.weakened.filter((path) => path.startsWith('mfa.smsCode'))).toEqual([])
      expect(planWarnings(result)).toContain(LOCKS_OUT)
      expect(rendered(result)).toContain(`  ! ${LOCKS_OUT}`)
    }
  )

  test.each([
    [
      'keeps it on',
      { mfa: { policy: 'required', smsCode: { enabled: true } } },
      { policy: 'required', smsCode: { enabled: true } },
    ],
    [
      'switches it on',
      { mfa: { policy: 'optional', smsCode: { enabled: true } } },
      { policy: 'optional', smsCode: { enabled: false } },
    ],
    ['leaves it out where it is off', {}, { policy: 'optional', smsCode: { enabled: false } }],
  ] as [string, NonNullable<EnvironmentConfigInput['settings']>, EnvironmentSettings['mfa']][])(
    'a file that %s says nothing of a lock-out',
    (_name, settings, mfa) => {
      const result = plan(settings, (server) => {
        server.mfa = mfa
      })
      expect(planWarnings(result).join('\n')).not.toContain('cannot sign in')
    }
  )
})

// Taking a country out, or switching text messages off, weakens nothing either and stops
// codes reaching people: said in the same words as the switch above.
describe('a plan’s words about where text messages stop going', () => {
  const sms = (enabled: boolean, allowedCountries: string[]) => ({
    enabled,
    allowedCountries,
    dailyMessageLimit: 500,
    templates: {},
  })
  const STOPS = 'users whose number is there can no longer receive a code'
  const LOCKED =
    'those whose only second step is a texted code cannot sign in until it is back or an administrator resets their two-step verification'

  test.each([
    ['takes one country out', { sms: sms(true, ['US']) }, ['DE', 'US'], 'DE'],
    ['takes two out', { sms: sms(true, ['US']) }, ['FR', 'US', 'DE'], 'DE, FR'],
    ['empties the list', { sms: sms(true, []) }, ['DE', 'US'], 'DE, US'],
    ['leaves the section out', {}, ['US'], 'US'],
    ['swaps one for another', { sms: sms(true, ['FR']) }, ['DE'], 'DE'],
  ] as [string, NonNullable<EnvironmentConfigInput['settings']>, string[], string][])(
    'a file that %s names the countries and who is locked out',
    (_name, settings, server, codes) => {
      const result = plan(settings, (document) => {
        document.sms = sms(true, server)
      })
      expect(result.weakened).toEqual([])
      const warning = planWarnings(result).find((line) => line.includes('sms.allowedCountries'))
      expect(warning).toBe(
        `stops text messages to ${codes} (taken out of sms.allowedCountries): ${STOPS}, unless a country that stays shares its prefix, and ${LOCKED}`
      )
      expect(rendered(result)).toContain(`  ! ${warning}`)
    }
  )

  test.each([
    ['writes it off', { sms: sms(false, ['US']) }],
    ['leaves it out', { sms: { allowedCountries: ['US'] } }],
  ] as [string, NonNullable<EnvironmentConfigInput['settings']>][])(
    'a file that %s where text messages are on says nobody receives a code',
    (_name, settings) => {
      const result = plan(settings, (document) => {
        document.sms = sms(true, ['US'])
      })
      expect(result.weakened).toEqual([])
      const warning = `switches text messages off (sms.enabled: off in the file, or left out of it): no user can receive a code any more, and ${LOCKED}`
      expect(planWarnings(result)).toContain(warning)
      expect(rendered(result)).toContain(`  ! ${warning}`)
      // The list did not change: only the switch is said.
      expect(planWarnings(result).join('\n')).not.toContain('sms.allowedCountries')
    }
  )

  test.each([
    ['reorders the list', sms(true, ['US', 'DE']), ['DE', 'US']],
    ['writes the same list', sms(true, ['DE', 'US']), ['DE', 'US']],
    ['adds a country', sms(true, ['DE', 'US', 'FR']), ['DE', 'US']],
    ['only lowers the limit', { ...sms(true, ['DE']), dailyMessageLimit: 10 }, ['DE']],
  ] as [string, EnvironmentSettings['sms'], string[]][])(
    'a file that %s says nothing of it',
    (_name, file, server) => {
      const result = plan({ sms: file }, (document) => {
        document.sms = sms(true, server)
      })
      const words = planWarnings(result).join('\n')
      expect(words).not.toContain('receive a code')
      expect(words).not.toContain('stops text messages')
    }
  )

  test('a file that switches text messages on where they were off says nothing of it', () => {
    const result = plan({ sms: sms(true, ['US']) }, (document) => {
      document.sms = sms(false, ['US'])
    })
    expect(planWarnings(result).join('\n')).not.toContain('receive a code')
  })

  test('what the server calls a country is printed so that it can be seen', () => {
    const result = plan({ sms: sms(true, ['US']) }, (document) => {
      document.sms = sms(true, ['US', 'D\u{202E}E'])
    })
    const words = planWarnings(result).join('\n')
    expect(words).toContain('stops text messages to DE (taken out')
    expect(words).not.toContain('\u{202E}')
  })
})
