import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ApiError } from '~/api/errors'
import { dashboardFetch } from '~/api/mutator'
import { useScope } from '~/state/scope'
import { useSession } from '~/state/session'

const ENVIRONMENT = '00000000-0000-7000-8000-00000000e001'
const OTHER = '00000000-0000-7000-8000-00000000e002'
const FOR_ENVIRONMENT = { 'x-tula-environment': ENVIRONMENT }
const realFetch = globalThis.fetch
let calls: { url: string; init: RequestInit }[] = []

function answer(response: Response | (() => Promise<Response>)): void {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return typeof response === 'function' ? response() : response
  }) as unknown as typeof fetch
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

async function failure(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof ApiError) {
      return error
    }
    throw error
  }
  throw new Error('the call did not fail')
}

beforeEach(() => {
  calls = []
  useScope.getState().set({ workspaceId: 'w', projectId: 'p', environmentId: ENVIRONMENT })
  useSession.getState().signedIn('2030-01-01T00:00:00.000Z')
})
afterEach(() => {
  globalThis.fetch = realFetch
})

describe('dashboardFetch', () => {
  test('marks every request as the dashboard’s and sends the cookie', async () => {
    answer(json(200, { ok: true }))
    await dashboardFetch('/v1/instance/workspaces', { method: 'GET' })
    const headers = new Headers(calls[0]?.init.headers)
    expect(headers.get('x-tula-dashboard')).toBe('1')
    expect(calls[0]?.init.credentials).toBe('include')
    expect(headers.has('x-tula-environment')).toBe(false)
  })

  test('an admin call is sent for the environment its caller named', async () => {
    answer(json(200, { data: [] }))
    await dashboardFetch('/v1/admin/users?page=1', { method: 'GET', headers: FOR_ENVIRONMENT })
    expect(new Headers(calls[0]?.init.headers).get('x-tula-environment')).toBe(ENVIRONMENT)
  })

  test('an admin call that names no environment is refused: the selection is never used instead', async () => {
    // An environment is selected; the call still has to say which one it was made for.
    answer(json(200, {}))
    const error = await failure(() => dashboardFetch('/v1/admin/users', { method: 'GET' }))
    expect(error.code).toBe('client.no_environment')
    expect(calls).toHaveLength(0)
  })

  test.each([
    ['another environment is selected now', OTHER],
    ['no environment is selected now', null],
  ])(
    'an admin call made for an environment is refused when %s, before any request',
    async (_name, selected) => {
      useScope.getState().set({ workspaceId: 'w', projectId: 'p', environmentId: selected })
      answer(json(200, {}))
      const error = await failure(() =>
        dashboardFetch('/v1/admin/settings', {
          method: 'PUT',
          headers: { ...FOR_ENVIRONMENT, 'If-Match': '"3"' },
          body: '{}',
        })
      )
      expect(error.code).toBe('client.environment_changed')
      expect(error.status).toBe(0)
      expect(calls).toHaveLength(0)
    }
  )

  test('an instance call never carries an environment', async () => {
    answer(json(200, { data: [] }))
    await dashboardFetch('/v1/instance/workspaces', { method: 'GET', headers: FOR_ENVIRONMENT })
    expect(new Headers(calls[0]?.init.headers).has('x-tula-environment')).toBe(false)
  })

  test('never sends an Authorization header, even when a caller passes one', async () => {
    answer(json(200, {}))
    await dashboardFetch('/v1/instance/session', {
      method: 'GET',
      headers: { Authorization: 'Bearer nope', 'If-Match': '"3"' },
    })
    const headers = new Headers(calls[0]?.init.headers)
    expect(headers.has('authorization')).toBe(false)
    expect(headers.get('if-match')).toBe('"3"')
  })

  test('answers undefined for 204 and hands the response to onResponse', async () => {
    answer(new Response(null, { status: 204, headers: { 'x-tula-can-still-sign-in': 'false' } }))
    let seen: string | null = null
    const result = await dashboardFetch<void>('/v1/admin/users/u/factors', {
      headers: FOR_ENVIRONMENT,
      method: 'DELETE',
      onResponse: (response) => {
        seen = response.headers.get('x-tula-can-still-sign-in')
      },
    })
    expect(result).toBeUndefined()
    expect(seen as string | null).toBe('false')
  })

  test('turns the error envelope into one typed error with its field errors', async () => {
    answer(
      json(422, {
        status: 422,
        code: 'validation.failed',
        detail: 'Invalid.',
        params: { min: 8 },
        errors: [{ field: 'password.minLength', code: 'validation.failed', message: 'Too small' }],
      })
    )
    const error = await failure(() =>
      dashboardFetch('/v1/admin/settings', { method: 'PUT', headers: FOR_ENVIRONMENT })
    )
    expect(error.status).toBe(422)
    expect(error.code).toBe('validation.failed')
    expect(error.detail).toBe('Invalid.')
    expect(error.params).toEqual({ min: 8 })
    expect(error.fieldErrors).toEqual([
      { field: 'password.minLength', code: 'validation.failed', message: 'Too small' },
    ])
    expect(error.retryAfter).toBeNull()
  })

  test('keeps Retry-After of a rate-limited answer', async () => {
    answer(
      json(
        429,
        { status: 429, code: 'rate_limited', detail: 'Slow down.' },
        { 'retry-after': '30' }
      )
    )
    const error = await failure(() => dashboardFetch('/v1/instance/session', { method: 'POST' }))
    expect(error.code).toBe('rate_limited')
    expect(error.retryAfter).toBe(30)
  })

  test('an answer that is not the envelope is response.invalid, without its text', async () => {
    answer(new Response('<html>secret-looking page</html>', { status: 502 }))
    const error = await failure(() => dashboardFetch('/v1/instance/workspaces', { method: 'GET' }))
    expect(error.status).toBe(502)
    expect(error.code).toBe('response.invalid')
    expect(error.message).not.toContain('secret-looking')
  })

  test('a 200 that is not JSON is response.invalid', async () => {
    answer(new Response('<html></html>', { status: 200 }))
    const error = await failure(() => dashboardFetch('/v1/instance/workspaces', { method: 'GET' }))
    expect(error.code).toBe('response.invalid')
  })

  test('a request that got no answer is network.failed and keeps no cause', async () => {
    answer(() => Promise.reject(new TypeError('connect ECONNREFUSED 10.0.0.1')))
    const error = await failure(() => dashboardFetch('/v1/instance/workspaces', { method: 'GET' }))
    expect(error.status).toBe(0)
    expect(error.code).toBe('network.failed')
    expect(error.message).not.toContain('10.0.0.1')
  })

  test('an aborted request stays an abort', async () => {
    answer(() => Promise.reject(new DOMException('Aborted', 'AbortError')))
    await expect(dashboardFetch('/v1/instance/workspaces', { method: 'GET' })).rejects.toThrow(
      'Aborted'
    )
  })

  test('auth.unauthenticated ends the session', async () => {
    answer(json(401, { status: 401, code: 'auth.unauthenticated', detail: 'Sign in.' }))
    await failure(() =>
      dashboardFetch('/v1/admin/users', { method: 'GET', headers: FOR_ENVIRONMENT })
    )
    expect(useSession.getState().status).toBe('signed_out')
  })

  test('another 401 (a wrong token at sign-in) does not end anything', async () => {
    answer(json(401, { status: 401, code: 'auth.invalid_key', detail: 'No.' }))
    await failure(() => dashboardFetch('/v1/instance/session', { method: 'POST' }))
    expect(useSession.getState().status).toBe('signed_in')
  })
})
