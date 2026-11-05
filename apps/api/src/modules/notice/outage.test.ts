import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import * as logger from '~/lib/logger'
import * as Notices from '~/modules/notice/service'
import { createTestDeps, TEST_TENANT } from '~/testing'

// H-206: a limiter that cannot count suppresses the notice (documented, ADR 0023); the outage
// must be loud enough for an operator to alert on, and name no address.
const tenant = { ...TEST_TENANT, apiKeyId: 'key_1' }

afterEach(() => {
  spyOn(logger, 'error').mockRestore()
})

describe('a notice suppressed by a limiter outage', () => {
  test('is logged at error level, with the notice kind and no address', async () => {
    const deps = createTestDeps()
    const errors = spyOn(logger, 'error').mockImplementation(() => {})
    spyOn(logger, 'warn').mockImplementation(() => {})
    deps.rateLimiter = {
      hit: async () => {
        throw new Error('connect ECONNREFUSED redis:6379')
      },
    } as unknown as typeof deps.rateLimiter
    Notices.passwordChanged(
      deps,
      tenant,
      { id: 'user_1', email: 'maya@northline.app' },
      { by: 'self', added: false, at: deps.clock.now() }
    )
    await Notices.settled()

    expect(errors).toHaveBeenCalledTimes(1)
    const line = JSON.stringify(errors.mock.calls)
    expect(line).toContain('security notice suppressed')
    expect(line).toContain('password_changed')
    expect(line).not.toContain('northline')
  })
})
