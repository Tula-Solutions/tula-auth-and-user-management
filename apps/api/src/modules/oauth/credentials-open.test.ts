import { beforeEach, describe, expect, test } from 'bun:test'
import * as Audit from '~/modules/audit/service'
import * as OAuth from '~/modules/oauth/service'
import { createTestDeps, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

const tenant = { ...TEST_TENANT, apiKeyId: 'key' }

describe('H-162: the sealed secret wins over the stored config', () => {
  let deps: TestDeps
  beforeEach(() => {
    deps = createTestDeps()
  })

  test('a config key named like a secret field cannot override the sealed secret', async () => {
    await OAuth.update(
      deps,
      tenant,
      'google',
      { clientId: 'c', clientSecret: 'sealed-secret', enabled: true },
      TEST_ACTOR
    )
    const record = await deps.oauthProviders.find(tenant.environmentId, 'google')
    if (!record) {
      throw new Error('fixture')
    }
    await deps.oauthProviders.upsert(
      { ...record, config: { ...record.config, clientSecret: 'attacker' } as typeof record.config },
      Audit.none('fixture')
    )
    const credentials = await OAuth.credentials(deps, tenant, 'google')
    expect(credentials.clientSecret).toBe('sealed-secret')
  })
})
