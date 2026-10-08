import { describe, expect, test } from 'bun:test'
import { createApp } from '~/index'
import {
  createInstanceTestDeps,
  dashboardHeaders,
  dashboardSignIn,
  seedApiKey,
  TEST_ADMIN_TOKEN,
  TEST_TENANT,
  type TestDeps,
} from '~/testing'

const SECRET_KEY = 'tula_sk_dev_dashboardtests0000000000000000000000000'
const OTHER = {
  projectId: '00000000-0000-7000-8000-00000000b001',
  environmentId: '00000000-0000-7000-8000-00000000f001',
} as const
const SOME_ID = '00000000-0000-7000-8000-00000000cafe'

async function setup() {
  const deps = createInstanceTestDeps()
  const now = deps.clock.now()
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: now,
  })
  // An environment of another project (and so, possibly, of another workspace).
  deps.environments.add({
    id: OTHER.environmentId,
    projectId: OTHER.projectId,
    kind: 'development',
    createdAt: now,
  })
  const key = await seedApiKey(deps, SECRET_KEY)
  const app = createApp(deps)
  const cookie = await dashboardSignIn(app)
  return { deps, app, cookie, key }
}

async function code(res: Response): Promise<string> {
  return ((await res.json()) as { code: string }).code
}

/** Every `/v1/admin/*` route the app has, read from the app itself. */
function adminRoutes(deps: TestDeps): Array<{ method: string; path: string }> {
  const seen = new Map<string, { method: string; path: string }>()
  for (const route of createApp(deps).routes) {
    if (route.path.startsWith('/v1/admin/') && route.method !== 'ALL') {
      seen.set(`${route.method} ${route.path}`, { method: route.method, path: route.path })
    }
  }
  return [...seen.values()]
}

function concrete(path: string): string {
  return path.replace(/:provider\b/, 'google').replace(/:[A-Za-z]+/g, SOME_ID)
}

function init(method: string, headers: Record<string, string>): RequestInit {
  return {
    method,
    headers,
    ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }),
  }
}

describe('every admin route takes a dashboard session with an environment', async () => {
  const routes = adminRoutes(createInstanceTestDeps())

  test('the app has admin routes to check, in every family', () => {
    const families = new Set(routes.map((route) => route.path.split('/')[3]))
    for (const family of [
      'api-keys',
      'audit-logs',
      'environments',
      'oauth-providers',
      'sessions',
      'settings',
      'signing-keys',
      'users',
    ]) {
      expect(families).toContain(family)
    }
    expect(routes.length).toBeGreaterThanOrEqual(20)
  })

  for (const { method, path } of routes) {
    test(`${method} ${path}`, async () => {
      const { app, cookie } = await setup()
      const url = concrete(path)
      const withSession = dashboardHeaders(cookie, TEST_TENANT.environmentId)

      // Authorized: whatever the route then says (a 404 for the made-up id, a 422 for the empty
      // body), it is not a refusal of the credential.
      const ok = await app.request(url, init(method, withSession))
      expect([400, 401, 403]).not.toContain(ok.status)
      expect(ok.status).toBeLessThan(500)

      // No cookie.
      const anonymous = await app.request(
        url,
        init(method, dashboardHeaders(undefined, TEST_TENANT.environmentId))
      )
      expect(anonymous.status).toBe(401)
      expect(await code(anonymous)).toBe('auth.unauthenticated')

      // The cookie without the custom header is not a credential.
      const { 'x-tula-dashboard': _dropped, ...noHeader } = withSession
      const ignored = await app.request(url, init(method, noHeader))
      expect([400, 401]).toContain(ignored.status)

      // No environment named.
      const unscoped = await app.request(url, init(method, dashboardHeaders(cookie)))
      expect(unscoped.status).toBe(400)
      expect(await code(unscoped)).toBe('request.malformed')

      // Both credentials at once.
      const mixed = await app.request(
        url,
        init(method, { ...withSession, authorization: `Bearer ${SECRET_KEY}` })
      )
      expect(mixed.status).toBe(400)
      expect(await code(mixed)).toBe('request.malformed')

      // Another site's page.
      const foreign = await app.request(
        url,
        init(method, { ...withSession, origin: 'https://evil.example' })
      )
      expect(foreign.status).toBe(403)
      expect(await code(foreign)).toBe('request.origin_not_allowed')
      const crossSite = await app.request(
        url,
        init(method, { ...withSession, 'sec-fetch-site': 'cross-site' })
      )
      expect(crossSite.status).toBe(403)

      // A change with no Origin is not a page's fetch.
      if (method !== 'GET') {
        const { origin: _origin, ...noOrigin } = withSession
        const res = await app.request(url, init(method, noOrigin))
        expect(res.status).toBe(403)
        expect(await code(res)).toBe('request.origin_not_allowed')
      }

      // The secret key still works by itself.
      const byKey = await app.request(
        url,
        init(method, { authorization: `Bearer ${SECRET_KEY}`, 'content-type': 'application/json' })
      )
      expect([400, 401, 403]).not.toContain(byKey.status)
    })
  }
})

describe('the environment of a dashboard request', () => {
  test('an unknown and a malformed environment id get the same 404, and nothing reaches a store', async () => {
    const { app, cookie } = await setup()
    const answers: string[] = []
    for (const id of [
      SOME_ID,
      'not-a-uuid',
      '',
      `${TEST_TENANT.environmentId}0`,
      `${TEST_TENANT.environmentId}/../x`,
      "' or 1=1 --",
      TEST_TENANT.projectId,
    ]) {
      const res = await app.request('/v1/admin/users', {
        headers: { ...dashboardHeaders(cookie), 'x-tula-environment': id },
      })
      expect(res.status).toBe(404)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.code).toBe('resource.not_found')
      answers.push(JSON.stringify({ ...body, requestId: undefined }))
    }
    expect(new Set(answers).size).toBe(1)
  })

  test('without a session, nothing is told about environments', async () => {
    const { app } = await setup()
    for (const id of [TEST_TENANT.environmentId, SOME_ID, 'not-a-uuid']) {
      const res = await app.request('/v1/admin/users', {
        headers: dashboardHeaders(undefined, id),
      })
      expect(res.status).toBe(401)
    }
  })

  test('each environment is its own tenant: the project comes from the environment, never the request', async () => {
    const { deps, app, cookie } = await setup()
    const create = (environmentId: string, email: string) =>
      app.request('/v1/admin/users', {
        method: 'POST',
        headers: dashboardHeaders(cookie, environmentId),
        body: JSON.stringify({ email }),
      })
    expect((await create(TEST_TENANT.environmentId, 'a@example.com')).status).toBe(201)
    expect((await create(OTHER.environmentId, 'b@example.com')).status).toBe(201)

    const list = async (environmentId: string) => {
      const res = await app.request('/v1/admin/users', {
        headers: dashboardHeaders(cookie, environmentId),
      })
      return ((await res.json()) as { data: Array<{ email: string }> }).data.map((u) => u.email)
    }
    expect(await list(TEST_TENANT.environmentId)).toEqual(['a@example.com'])
    expect(await list(OTHER.environmentId)).toEqual(['b@example.com'])
    // The audit entry of the second user is in the other project's environment.
    const created = deps.activityLog.ofType('user.created')
    expect(created.map((entry) => [entry.projectId, entry.environmentId])).toEqual([
      [TEST_TENANT.projectId, TEST_TENANT.environmentId],
      [OTHER.projectId, OTHER.environmentId],
    ])
  })

  test('an upper-case environment id resolves to the same environment', async () => {
    const { app, cookie } = await setup()
    const res = await app.request('/v1/admin/environments', {
      headers: dashboardHeaders(cookie, TEST_TENANT.environmentId.toUpperCase()),
    })
    expect(res.status).toBe(200)
  })
})

describe('who the audit log says did it', () => {
  test('a change made through the dashboard is the instance admin’s, with the session id', async () => {
    const { deps, app, cookie } = await setup()
    const res = await app.request('/v1/admin/api-keys', {
      method: 'POST',
      headers: dashboardHeaders(cookie, TEST_TENANT.environmentId),
      body: JSON.stringify({ kind: 'publishable', name: 'From the dashboard' }),
    })
    expect(res.status).toBe(201)
    const [signedIn] = deps.controlPlane.ofType('instance.signed_in')
    const [entry] = deps.activityLog.ofType('api_key.created')
    expect(entry?.actor).toEqual({ type: 'instance_admin', id: signedIn?.actor.id ?? '' })
    expect(entry?.environmentId).toBe(TEST_TENANT.environmentId)

    // And the audit list shows it, filterable by that id.
    const listed = await app.request(`/v1/admin/audit-logs?actorId=${signedIn?.actor.id}`, {
      headers: dashboardHeaders(cookie, TEST_TENANT.environmentId),
    })
    const { data } = (await listed.json()) as { data: Array<{ actor: { type: string } }> }
    expect(data.map((item) => item.actor.type)).toEqual(['instance_admin'])
  })

  test('the same change with a secret key is the key’s, cookie or no cookie', async () => {
    const { deps, app, cookie, key } = await setup()
    for (const headers of [
      { authorization: `Bearer ${SECRET_KEY}`, 'content-type': 'application/json' },
      // A browser attaches the cookie by itself; without the dashboard header it means nothing.
      { authorization: `Bearer ${SECRET_KEY}`, 'content-type': 'application/json', cookie },
    ] as Array<Record<string, string>>) {
      const res = await app.request('/v1/admin/api-keys', {
        method: 'POST',
        headers,
        body: JSON.stringify({ kind: 'publishable', name: 'From a server' }),
      })
      expect(res.status).toBe(201)
    }
    for (const entry of deps.activityLog.ofType('api_key.created')) {
      expect(entry.actor).toEqual({ type: 'admin', id: key.id })
    }
  })

  test('the dashboard can revoke any key of the environment, including the last secret key', async () => {
    const { deps, app, cookie, key } = await setup()
    const res = await app.request(`/v1/admin/api-keys/${key.id}`, {
      method: 'DELETE',
      headers: dashboardHeaders(cookie, TEST_TENANT.environmentId),
    })
    expect(res.status).toBe(200)
    expect(deps.activityLog.ofType('api_key.revoked')[0]?.actor.type).toBe('instance_admin')
  })
})

describe('one meaning per credential', () => {
  test('a secret key with an environment header is refused: a key names its own environment', async () => {
    const { app } = await setup()
    const res = await app.request('/v1/admin/users', {
      headers: {
        authorization: `Bearer ${SECRET_KEY}`,
        'x-tula-environment': OTHER.environmentId,
      },
    })
    expect(res.status).toBe(400)
    expect(await code(res)).toBe('request.malformed')
  })

  test('the instance admin token itself does not open the admin routes', async () => {
    const { app } = await setup()
    for (const headers of [
      { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      {
        authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
        'x-tula-environment': TEST_TENANT.environmentId,
      },
    ] as Array<Record<string, string>>) {
      const res = await app.request('/v1/admin/users', { headers })
      expect([400, 401]).toContain(res.status)
    }
    const res = await app.request('/v1/admin/users', {
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    })
    expect(await code(res)).toBe('auth.invalid_key')
  })

  test('a secret key does not open the instance routes, with or without the dashboard header', async () => {
    const { app } = await setup()
    const bearer = await app.request('/v1/instance/diagnostics', {
      headers: { authorization: `Bearer ${SECRET_KEY}` },
    })
    expect(bearer.status).toBe(401)
    const mixed = await app.request('/v1/instance/diagnostics', {
      headers: { ...dashboardHeaders(), authorization: `Bearer ${SECRET_KEY}` },
    })
    expect(mixed.status).toBe(400)
  })

  test('a deployment without an admin token has no dashboard sessions on the admin routes', async () => {
    const withToken = await setup()
    const { createTestDeps } = await import('~/testing')
    const deps = createTestDeps()
    deps.environments.add({
      id: TEST_TENANT.environmentId,
      projectId: TEST_TENANT.projectId,
      kind: 'development',
      createdAt: deps.clock.now(),
    })
    const res = await createApp(deps).request('/v1/admin/users', {
      headers: dashboardHeaders(withToken.cookie, TEST_TENANT.environmentId),
    })
    expect(res.status).toBe(401)
  })
})

describe('settings through the dashboard', () => {
  test('GET /v1/admin/settings answers `managedBy`, and the dashboard can replace them', async () => {
    const { deps, app, cookie } = await setup()
    const headers = dashboardHeaders(cookie, TEST_TENANT.environmentId)
    const read = await app.request('/v1/admin/settings', { headers })
    expect(read.status).toBe(200)
    const settings = (await read.json()) as { settings: { app: Record<string, unknown> } }
    expect('managedBy' in settings).toBe(true)
    const etag = read.headers.get('etag') ?? ''
    const write = await app.request('/v1/admin/settings', {
      method: 'PUT',
      headers: { ...headers, 'if-match': etag },
      body: JSON.stringify({
        ...settings.settings,
        app: { ...settings.settings.app, name: 'Renamed in the dashboard' },
      }),
    })
    expect(write.status).toBe(200)
    const [entry] = deps.activityLog.ofType('environment.settings_updated')
    expect(entry?.actor.type).toBe('instance_admin')
  })
})
