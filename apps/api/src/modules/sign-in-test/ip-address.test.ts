import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { createApp } from '~/index'
import * as Sessions from '~/modules/session/service'
import { createTestDeps, seedApiKey, TEST_TENANT } from '~/testing'

// H-185: a run reaches the flow engine from no network address (ADR 0058). Were an address
// ever passed, the server's own would land in the throwaway session and in the new-device
// and rate-limit buckets as if a person had signed in from there.

const SK = 'tula_sk_dev_admin000000000000000000000000000000'
let create: ReturnType<typeof spyOn<typeof Sessions, 'create'>>

beforeEach(() => {
  create = spyOn(Sessions, 'create')
})
afterEach(() => create.mockRestore())

describe('the flow context of a sign-in test', () => {
  test('carries no IP address into the sessions it creates', async () => {
    const deps = createTestDeps()
    deps.environments.add({
      id: TEST_TENANT.environmentId,
      projectId: TEST_TENANT.projectId,
      kind: 'development',
      createdAt: deps.clock.now(),
    })
    await seedApiKey(deps, SK)
    const res = await createApp(deps).request('/v1/admin/sign-in-tests', {
      method: 'POST',
      headers: { authorization: `Bearer ${SK}`, 'x-forwarded-for': '203.0.113.9' },
    })
    expect(res.status).toBe(200)
    expect(create.mock.calls.length).toBeGreaterThan(0)
    for (const call of create.mock.calls) {
      expect(call[2].ipAddress).toBeNull()
    }
  })
})
