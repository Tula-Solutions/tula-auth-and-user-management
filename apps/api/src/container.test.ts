import { describe, expect, test } from 'bun:test'
import { createContainer } from '~/container'
import { parseEnv } from '~/env'

describe('createContainer', () => {
  test('wires production adapters from env without connecting', async () => {
    const env = parseEnv({
      ENVIRONMENT: 'dev',
      // Nothing listens here: building the container must not open a connection.
      DATABASE_URL: 'postgres://tula_api:tula_api@127.0.0.1:1/tula',
      TULA_MASTER_KEY: 'a'.repeat(64),
      CORS_ORIGINS: 'https://app.test',
      TRUST_PROXY: 'true',
    })
    const { deps, close } = createContainer(env)
    expect(deps.config).toEqual({
      tier: 'dev',
      publicUrl: 'http://localhost:3003',
      corsOrigins: ['https://app.test'],
      trustProxy: true,
    })
    expect(deps.probes.map((probe) => probe.name)).toEqual(['database'])
    expect(deps.ids.next()).toMatch(/^[0-9a-f-]{36}$/)
    await close()
  })
})
