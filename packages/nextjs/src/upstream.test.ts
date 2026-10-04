import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { durationToMs, MIN_REUSE_GRACE_PERIOD } from '@tula/contract'
import {
  REFRESH_RETRY_WINDOW_MS as CORE_REFRESH_RETRY_WINDOW_MS,
  REFRESH_TIMEOUT_MS as CORE_REFRESH_TIMEOUT_MS,
} from '@tula/core'
import { resolveConfig } from './config'
import { APP, createFakeApi } from './testing/keys'
import { REFRESH_RETRY_WINDOW_MS, REFRESH_TIMEOUT_MS, refreshSession } from './upstream'

const REFRESH = 'POST /v1/client/sessions/refresh'
const REFRESH_PATH = '/v1/client/sessions/refresh'

const restore: (() => void)[] = []
afterEach(() => {
  for (const undo of restore.splice(0)) {
    undo()
  }
})

/** An upstream that never answers: the call ends only when its signal is aborted. */
function never(request: Request): Promise<Response> {
  return new Promise((_resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(request.signal.reason))
  })
}

/**
 * Timeouts that pass at once and move the clock by their length, so that a wait of seconds is
 * observed without being sat through.
 *
 * @returns The timeouts asked for, in order.
 */
function instantTimeouts(): number[] {
  const delays: number[] = []
  let now = 1_900_000_000_000
  const clock = spyOn(Date, 'now').mockImplementation(() => now)
  const timeouts = spyOn(AbortSignal, 'timeout').mockImplementation((delay: number) => {
    delays.push(delay)
    const controller = new AbortController()
    queueMicrotask(() => {
      now += delay
      controller.abort(new DOMException('The operation timed out.', 'TimeoutError'))
    })
    return controller.signal
  })
  restore.push(
    () => clock.mockRestore(),
    () => timeouts.mockRestore()
  )
  return delays
}

function refresh(api: ReturnType<typeof createFakeApi>, token = 'r1') {
  return refreshSession(new Request(`${APP}/dashboard`), resolveConfig(api.options), token)
}

describe('the refresh the server side makes', () => {
  test('its timeout stays below the smallest reuse grace window a profile may set', () => {
    // A refresh whose answer is lost may have rotated the token. Presenting it again is
    // forgiven only inside the grace window; giving up later than that ends the session.
    expect(REFRESH_TIMEOUT_MS).toBeLessThan(durationToMs(MIN_REUSE_GRACE_PERIOD))
    expect(REFRESH_RETRY_WINDOW_MS).toBe(durationToMs(MIN_REUSE_GRACE_PERIOD))
    // The browser's client and the server side give up at the same moments.
    expect(REFRESH_TIMEOUT_MS).toBe(CORE_REFRESH_TIMEOUT_MS)
    expect(REFRESH_RETRY_WINDOW_MS).toBe(CORE_REFRESH_RETRY_WINDOW_MS)
  })

  test('an upstream that never answers is given up on before the grace window ends, and retried once inside it', async () => {
    const api = createFakeApi([])
    api.on(REFRESH, never)
    const delays = instantTimeouts()
    const outcome = await refresh(api)
    expect(outcome).toEqual({ status: 'unavailable' })
    // The default call timeout is 15 seconds; a refresh does not get it.
    expect(resolveConfig(api.options).timeoutMs).toBe(15_000)
    expect(delays).toEqual([REFRESH_TIMEOUT_MS, REFRESH_RETRY_WINDOW_MS - REFRESH_TIMEOUT_MS])
    expect(delays[0]).toBeLessThan(durationToMs(MIN_REUSE_GRACE_PERIOD))
    expect(api.count(REFRESH_PATH)).toBe(2)
  })

  test('an app that sets a smaller timeout gets that for refreshes too', async () => {
    const api = createFakeApi([], { timeoutSeconds: 3 })
    api.on(REFRESH, never)
    const delays = instantTimeouts()
    await refresh(api)
    expect(delays).toEqual([3_000, 3_000])
  })

  test('a refresh that got no answer is sent again exactly once, with the same token', async () => {
    const api = createFakeApi([])
    api.on(REFRESH, () => Promise.reject(new TypeError('connection reset')))
    expect(await refresh(api)).toEqual({ status: 'unavailable' })
    expect(api.count(REFRESH_PATH)).toBe(2)
    const cookies = api.requests.map((request) => request.headers.get('cookie'))
    expect(cookies[0]).toContain('r1')
    expect(cookies[1]).toBe(cookies[0])
  })

  test('the repeat’s answer is the refresh’s answer', async () => {
    const api = createFakeApi([])
    let tries = 0
    api.on(REFRESH, () => {
      tries += 1
      return tries === 1
        ? Promise.reject(new TypeError('connection reset'))
        : Response.json({ sessionId: 'sess_1', accessToken: 'a.b.c' })
    })
    const outcome = await refresh(api)
    expect(outcome.status).toBe('refreshed')
    expect(tries).toBe(2)
  })

  test.each([
    ['503', () => new Response(null, { status: 503 }), 'unavailable'],
    ['429', () => new Response(null, { status: 429 }), 'unavailable'],
    [
      'a refusal for the session',
      () => Response.json({ status: 401, code: 'session.revoked' }, { status: 401 }),
      'refused',
    ],
    ['a 200 that is not a session', () => Response.json({ nothing: true }), 'unavailable'],
  ] as const)('an HTTP answer is never repeated: %s', async (_name, respond, status) => {
    const api = createFakeApi([], { onWarning: () => undefined })
    api.on(REFRESH, respond)
    expect((await refresh(api)).status).toBe(status)
    expect(api.count(REFRESH_PATH)).toBe(1)
  })

  test('requests that share a refresh share its repeat: two calls in all', async () => {
    const api = createFakeApi([])
    let tries = 0
    api.on(REFRESH, async () => {
      tries += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      if (tries === 1) {
        throw new TypeError('connection reset')
      }
      return Response.json({ sessionId: 'sess_1', accessToken: 'a.b.c' })
    })
    const outcomes = await Promise.all([refresh(api), refresh(api), refresh(api)])
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      'refreshed',
      'refreshed',
      'refreshed',
    ])
    expect(api.count(REFRESH_PATH)).toBe(2)
  })
})
