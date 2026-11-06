import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test'
import { HOOK_MAX_DEADLINE_MS } from '@tula-tech/contract'
import * as Outbound from '~/lib/outbound'
import * as Hooks from '~/modules/hook/service'
import { createTestDeps, TEST_ACTOR, TEST_TENANT } from '~/testing'

// TULA-157, H-187: saving a hook's address only resolves and judges it (`Outbound.check`); a
// call judges it again (`Outbound.request`), because DNS changes. Neither stands in for the other.

const tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const listener = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: () => Response.json({ decision: 'allow' }),
})
afterAll(() => listener.stop(true))

const spies: { mockRestore(): void }[] = []
afterEach(() => {
  for (const spy of spies.splice(0)) {
    spy.mockRestore()
  }
})

describe('a hook address is judged when saved and again when called', () => {
  test('saving checks the address and sends nothing; a call requests it', async () => {
    const deps = createTestDeps()
    const check = spyOn(Outbound, 'check')
    const request = spyOn(Outbound, 'request')
    spies.push(check, request)

    await Hooks.create(
      deps,
      tenant,
      {
        point: 'before_sign_up',
        url: `http://127.0.0.1:${listener.port}/x`,
        enabled: true,
        deadlineMs: HOOK_MAX_DEADLINE_MS,
        failureMode: 'deny',
      },
      TEST_ACTOR
    )
    expect(check).toHaveBeenCalledTimes(1)
    expect(request).not.toHaveBeenCalled()

    await Hooks.beforeSignUp(deps, tenant, {
      email: 'maya@northline.app',
      method: 'password',
      client: 'web',
      ipAddress: '203.0.113.7',
    })
    expect(request).toHaveBeenCalledTimes(1)
    expect(check).toHaveBeenCalledTimes(1)
  })
})
