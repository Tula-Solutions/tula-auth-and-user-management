import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ApiError } from '~/api/errors'
import { dashboardFetch } from '~/api/mutator'
import { useScope } from '~/state/scope'
import { useSession } from '~/state/session'

const ENVIRONMENT = '00000000-0000-7000-8000-00000000e001'
const realFetch = globalThis.fetch
let calls: { url: string; init: RequestInit }[] = []

beforeEach(() => {
  calls = []
  useScope.getState().set({ workspaceId: 'w', projectId: 'p', environmentId: ENVIRONMENT })
  useSession.getState().signedIn('2030-01-01T00:00:00.000Z')
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
})

describe('dashboardFetch: the admin prefix is judged on the normalised path (H-195)', () => {
  test.each([
    '/v1/instance/../admin/users',
    '/v1/instance/%2e%2e/admin/users',
    '/v1/admin/users?x=/../',
  ])('%s is an admin call: it needs an environment', async (url) => {
    const error = await dashboardFetch(url, { method: 'GET' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe('client.no_environment')
    expect(calls).toHaveLength(0)
  })

  test('a path that leaves the admin prefix carries no environment', async () => {
    await dashboardFetch('/v1/admin/../instance/workspaces', {
      method: 'GET',
      headers: { 'x-tula-environment': ENVIRONMENT },
    })
    expect(new Headers(calls[0]?.init.headers).has('x-tula-environment')).toBe(false)
  })
})
