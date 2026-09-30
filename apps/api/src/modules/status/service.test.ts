import { describe, expect, test } from 'bun:test'
import * as Status from '~/modules/status/service'
import type { HealthProbe } from '~/ports/health-probe'

const passing: HealthProbe = { name: 'database', check: async () => {} }
const failing: HealthProbe = {
  name: 'cache',
  check: async () => {
    throw new Error('connection refused')
  },
}
const hanging: HealthProbe = { name: 'slow', check: () => new Promise(() => {}) }

describe('status', () => {
  test('reports ok with the package version', () => {
    expect(Status.status()).toEqual({ status: 'ok', version: expect.any(String) })
  })
})

describe('ready', () => {
  test('is ready when every probe passes', async () => {
    expect(await Status.ready({ probes: [passing] })).toEqual({
      status: 'ready',
      checks: { database: 'ok' },
    })
  })

  test('is ready with no probes configured', async () => {
    expect(await Status.ready({ probes: [] })).toEqual({ status: 'ready', checks: {} })
  })

  test('is not ready when any probe fails', async () => {
    expect(await Status.ready({ probes: [passing, failing] })).toEqual({
      status: 'not_ready',
      checks: { database: 'ok', cache: 'fail' },
    })
  })

  test('treats a probe that exceeds the timeout as failed', async () => {
    expect(await Status.ready({ probes: [hanging, passing] }, 10)).toEqual({
      status: 'not_ready',
      checks: { slow: 'fail', database: 'ok' },
    })
  })

  test('counts a non-Error rejection as a failure', async () => {
    const odd: HealthProbe = { name: 'odd', check: () => Promise.reject('nope') }
    expect((await Status.ready({ probes: [odd] })).checks).toEqual({ odd: 'fail' })
  })
})
