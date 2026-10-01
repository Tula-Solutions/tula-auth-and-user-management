import { describe, expect, test } from 'bun:test'
import { PASSWORD_POLICY_PRESETS } from '@tula/contract'
import { HibpBreachChecker } from '~/adapters/breach/hibp'
import { offlineBreachChecker } from '~/adapters/breach/offline'
import { createContainer } from '~/container'
import { parseEnv } from '~/env'

const base = {
  ENVIRONMENT: 'dev',
  // Nothing listens here: building the container must not open a connection.
  DATABASE_URL: 'postgres://tula_api:tula_api@127.0.0.1:1/tula',
  TULA_MASTER_KEY: 'a'.repeat(64),
}

describe('createContainer', () => {
  test('wires production adapters from env without connecting', async () => {
    const env = parseEnv({
      ...base,
      CORS_ORIGINS: 'https://app.test',
      TRUST_PROXY: 'true',
      PASSWORD_POLICY: 'strict',
      BREACH_CHECK: 'hibp',
    })
    const { deps, close } = createContainer(env)
    expect(deps.config).toEqual({
      tier: 'dev',
      publicUrl: 'http://localhost:3003',
      corsOrigins: ['https://app.test'],
      trustProxy: true,
      passwordPolicy: PASSWORD_POLICY_PRESETS.strict,
    })
    expect(deps.breachChecker).toBeInstanceOf(HibpBreachChecker)
    expect(deps.probes.map((probe) => probe.name)).toEqual(['database'])
    expect(deps.ids.next()).toMatch(/^[0-9a-f-]{36}$/)
    await close()
  })

  test('defaults to the recommended policy and the offline breach list', async () => {
    const { deps, close } = createContainer(parseEnv(base))
    expect(deps.config.passwordPolicy).toEqual(PASSWORD_POLICY_PRESETS.recommended)
    expect(deps.breachChecker).toBe(offlineBreachChecker)
    await close()
  })
})
