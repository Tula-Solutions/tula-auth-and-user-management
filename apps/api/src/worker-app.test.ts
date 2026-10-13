import { describe, expect, spyOn, test } from 'bun:test'
import { FixedClock } from '~/adapters/memory/clock'
import * as logger from '~/lib/logger'
import type { HealthProbe } from '~/ports/health-probe'
import { createWorkerApp, WORKER_READY_REUSE_MS } from '~/worker-app'
import { version } from '../package.json'

// What a worker process listens for: liveness and readiness, for the orchestrator and the
// image's HEALTHCHECK, and nothing else. It is handed a clock and its probes: it cannot reach
// a store, a key or a session even by mistake.

function probe(name: string, check: () => Promise<void>): HealthProbe & { calls: number } {
  const counted = {
    name,
    calls: 0,
    check: () => {
      counted.calls += 1
      return check()
    },
  }
  return counted
}

const get = (app: ReturnType<typeof createWorkerApp>, path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://worker.internal${path}`, init))

describe('the worker’s health endpoint', () => {
  test('liveness answers 200 with the version and touches no dependency', async () => {
    const database = probe('database', async () => undefined)
    const app = createWorkerApp({ clock: new FixedClock(), probes: [database] })
    const res = await get(app, '/v1/status')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok', version })
    expect(database.calls).toBe(0)
  })

  test('readiness is the API’s own answer: 200 when the database answers, 503 when it does not', async () => {
    const up = createWorkerApp({
      clock: new FixedClock(),
      probes: [probe('database', async () => undefined)],
    })
    const ready = await get(up, '/v1/ready')
    expect(ready.status).toBe(200)
    expect(await ready.json()).toEqual({ status: 'ready', checks: { database: 'ok' } })

    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      const down = createWorkerApp({
        clock: new FixedClock(),
        probes: [
          probe('database', async () => {
            throw new Error('connect ECONNREFUSED postgres://tula_api:canary-password@db:5432')
          }),
        ],
      })
      const res = await get(down, '/v1/ready')
      expect(res.status).toBe(503)
      const text = await res.text()
      expect(JSON.parse(text)).toEqual({ status: 'not_ready', checks: { database: 'fail' } })
      // The reason is the log's, never the answer's.
      expect(text).not.toContain('canary-password')
    } finally {
      warn.mockRestore()
    }
  })

  test('however often it is asked, the database is probed at most once a second', async () => {
    const clock = new FixedClock()
    const database = probe('database', async () => undefined)
    const app = createWorkerApp({ clock, probes: [database] })
    // The route is public and has no rate limiter behind it (a worker shares none).
    await Promise.all(Array.from({ length: 50 }, () => get(app, '/v1/ready')))
    expect(database.calls).toBe(1)
    clock.advance(WORKER_READY_REUSE_MS - 1)
    expect((await get(app, '/v1/ready')).status).toBe(200)
    expect(database.calls).toBe(1)
    clock.advance(1)
    await get(app, '/v1/ready')
    expect(database.calls).toBe(2)
    expect(WORKER_READY_REUSE_MS).toBe(1000)
  })

  test('an answer is not kept past its second: a database that went away is noticed', async () => {
    const clock = new FixedClock()
    let healthy = true
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      const app = createWorkerApp({
        clock,
        probes: [
          probe('database', async () => {
            if (!healthy) {
              throw new Error('gone')
            }
          }),
        ],
      })
      expect((await get(app, '/v1/ready')).status).toBe(200)
      healthy = false
      clock.advance(WORKER_READY_REUSE_MS)
      expect((await get(app, '/v1/ready')).status).toBe(503)
    } finally {
      warn.mockRestore()
    }
  })

  // The worker takes no sign-in traffic: none of the API exists on its port.
  test.each([
    ['POST', '/v1/client/sign-ins'],
    ['POST', '/v1/client/sign-ups'],
    ['POST', '/v1/client/sessions/refresh'],
    ['GET', '/v1/client/config'],
    ['GET', '/v1/admin/users'],
    ['GET', '/v1/admin/webhook-endpoints'],
    ['POST', '/v1/admin/webhook-endpoints/00000000-0000-7000-8000-000000000001/test'],
    ['GET', '/v1/instance/diagnostics'],
    ['POST', '/v1/instance/session'],
    ['GET', '/v1/environments/00000000-0000-7000-8000-000000000001/.well-known/jwks.json'],
    ['GET', '/v1/openapi.json'],
    ['GET', '/v1/docs'],
    ['GET', '/dashboard'],
    ['GET', '/dashboard/'],
    ['GET', '/'],
    ['GET', '/v1'],
    ['GET', '/v1/status/'],
    ['GET', '/v1/ready/x'],
    ['GET', '//v1/status'],
    ['POST', '/v1/status'],
    ['POST', '/v1/ready'],
    ['DELETE', '/v1/ready'],
    ['OPTIONS', '/v1/client/sign-ins'],
  ])('%s %s does not exist', async (method, path) => {
    const database = probe('database', async () => undefined)
    const app = createWorkerApp({ clock: new FixedClock(), probes: [database] })
    const res = await get(app, path, {
      method,
      headers: {
        authorization: 'Bearer tula_sk_dev_admin000000000000000000000000000000',
        origin: 'http://localhost:3003',
      },
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      status: 404,
      code: 'resource.not_found',
      detail: 'The requested resource does not exist.',
    })
    // Nothing was looked up for it, and no page may read the answer from another origin.
    expect(database.calls).toBe(0)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  test('every answer is JSON that is not sniffed or cached', async () => {
    const app = createWorkerApp({
      clock: new FixedClock(),
      probes: [probe('database', async () => undefined)],
    })
    for (const path of ['/v1/status', '/v1/ready', '/nowhere']) {
      const res = await get(app, path)
      expect(res.headers.get('content-type')).toBe('application/json')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('cache-control')).toBe('no-store')
    }
  })

  test('HEAD is answered like GET, for health checkers that send it', async () => {
    const app = createWorkerApp({
      clock: new FixedClock(),
      probes: [probe('database', async () => undefined)],
    })
    expect((await get(app, '/v1/status', { method: 'HEAD' })).status).toBe(200)
    expect((await get(app, '/v1/ready', { method: 'HEAD' })).status).toBe(200)
  })
})
