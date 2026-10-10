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
