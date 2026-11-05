import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { Tenant } from '~/dependencies'
import * as Flows from '~/modules/flow/service'
import * as Sso from '~/modules/sso/service'
import { createTestDeps, TEST_TENANT, type TestDeps } from '~/testing'

const tenant: Tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const web: Flows.ClientContext = {
  client: 'web',
  userAgent: 'Mozilla/5.0',
  ipAddress: '203.0.113.7',
  originAllowed: true,
}
let deps: TestDeps

beforeEach(() => {
  deps = createTestDeps()
  for (const [id, kind] of [
    [TEST_TENANT.environmentId, 'development'],
    [TEST_TENANT.productionEnvironmentId, 'production'],
  ] as const) {
    deps.environments.add({
      id,
      projectId: TEST_TENANT.projectId,
      kind,
      createdAt: deps.clock.now(),
    })
  }
})

describe('password reset lookups (H-078)', () => {
  test('an unknown address goes through the same enforced-SSO lookup as a real one', async () => {
    const refuses = spyOn(Sso, 'refuses')
    try {
      await Flows.startPasswordReset(deps, tenant, { email: 'nobody@northline.app' }, web)
      expect(refuses).toHaveBeenCalledTimes(1)
    } finally {
      refuses.mockRestore()
    }
  })
})
