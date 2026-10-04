import { describe, expect, test } from 'bun:test'
import { createApp } from '~/index'
import {
  createInstanceTestDeps,
  createTestDeps,
  dashboardHeaders,
  dashboardSignIn,
  TEST_ADMIN_TOKEN,
} from '~/testing'

const MISSING = '00000000-0000-7000-8000-00000000dead'

interface Page<T> {
  meta: { totalCount: number; totalPages: number; page: number; perPage: number }
  data: T[]
}
interface Workspace {
  id: string
  name: string
  createdAt: string
}
interface Project extends Workspace {
  workspaceId: string
  updatedAt: string
}
interface Environment {
  id: string
  projectId: string
  kind: string
}

async function setup() {
  const deps = createInstanceTestDeps()
  const app = createApp(deps)
  const cookie = await dashboardSignIn(app)
  const headers = dashboardHeaders(cookie)
  const call = (method: string, path: string, body?: unknown) =>
    app.request(`/v1/instance${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const [signedIn] = deps.controlPlane.ofType('instance.signed_in')
  return { deps, app, cookie, call, sessionId: signedIn?.actor.id ?? '' }
}

async function workspace(call: Awaited<ReturnType<typeof setup>>['call'], name = 'Acme') {
  const res = await call('POST', '/workspaces', { name })
  expect(res.status).toBe(201)
  return (await res.json()) as Workspace
}

async function project(
  call: Awaited<ReturnType<typeof setup>>['call'],
  workspaceId: string,
  name = 'Web app'
) {
  const res = await call('POST', '/projects', { workspaceId, name })
  expect(res.status).toBe(201)
  return (await res.json()) as { project: Project; environments: Environment[] }
}

const ROUTES: ReadonlyArray<readonly [method: string, path: string]> = [
  ['GET', '/workspaces'],
  ['POST', '/workspaces'],
  ['GET', '/projects'],
  ['POST', '/projects'],
  ['PATCH', `/projects/${MISSING}`],
  ['GET', '/environments'],
  ['POST', `/projects/${MISSING}/environments`],
  ['GET', '/audit-logs'],
]

describe('who may call the instance routes', () => {
  test.each(ROUTES)(
    '%s %s: 404 without TULA_ADMIN_TOKEN, 401 without a credential',
    async (method, path) => {
      const body = method === 'GET' ? {} : { body: '{}' }
      const absent = await createApp(createTestDeps()).request(`/v1/instance${path}`, {
        method,
        headers: dashboardHeaders(),
        ...body,
      })
      expect(absent.status).toBe(404)

      const app = createApp(createInstanceTestDeps())
      const anonymous = await app.request(`/v1/instance${path}`, {
        method,
        headers: dashboardHeaders(),
        ...body,
      })
      expect(anonymous.status).toBe(401)
      const wrong = await app.request(`/v1/instance${path}`, {
        method,
        headers: { authorization: 'Bearer wrong-token-wrong-token-wrong-token' },
        ...body,
      })
      expect(wrong.status).toBe(401)
    }
  )

  test.each(ROUTES)('%s %s: a foreign origin is refused with a session', async (method, path) => {
    const { app, cookie } = await setup()
    const res = await app.request(`/v1/instance${path}`, {
      method,
      headers: { ...dashboardHeaders(cookie), origin: 'https://evil.example' },
      ...(method === 'GET' ? {} : { body: '{}' }),
    })
    expect(res.status).toBe(403)
  })

  test('the admin token itself works too, and its actor has no session id', async () => {
    const deps = createInstanceTestDeps()
    const app = createApp(deps)
    const headers = {
      authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
      'content-type': 'application/json',
    }
    const res = await app.request('/v1/instance/workspaces', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'From the CLI' }),
    })
    expect(res.status).toBe(201)
    expect(deps.controlPlane.ofType('workspace.created')[0]?.actor).toEqual({
      type: 'instance_admin',
      id: null,
    })
    expect((await app.request('/v1/instance/workspaces', { headers })).status).toBe(200)
  })

  test('the session also reads the diagnostics', async () => {
    const { call } = await setup()
    expect((await call('GET', '/diagnostics')).status).toBe(200)
  })
})

describe('workspaces', () => {
  test('created, listed oldest first with paging, and recorded', async () => {
    const { deps, call, sessionId } = await setup()
    const first = await workspace(call, 'First')
    deps.clock.advance('1m')
    const second = await workspace(call, '  Second  ')
    expect(second.name).toBe('Second')

    const res = await call('GET', '/workspaces')
    expect(res.status).toBe(200)
    const page = (await res.json()) as Page<Workspace>
    expect(page.data.map((item) => item.id)).toEqual([first.id, second.id])
    expect(page.meta).toEqual({ totalCount: 2, totalPages: 1, page: 1, perPage: 20 })
    const paged = (await (await call('GET', '/workspaces?page=2&size=1')).json()) as Page<Workspace>
    expect(paged.data.map((item) => item.id)).toEqual([second.id])
    expect(paged.meta).toEqual({ totalCount: 2, totalPages: 2, page: 2, perPage: 1 })

    const entries = deps.controlPlane.ofType('workspace.created')
    expect(entries.map((entry) => entry.target)).toEqual([
      { type: 'workspace', id: first.id },
      { type: 'workspace', id: second.id },
    ])
    expect(entries[0]?.actor).toEqual({ type: 'instance_admin', id: sessionId })
  })

  test.each([
    [{}],
    [{ name: '' }],
    [{ name: '   ' }],
    [{ name: 'x'.repeat(101) }],
    [{ name: 42 }],
    [{ name: 'ok', extra: true }],
    [{ name: 'line\nbreak' }],
  ])('refuses %j and records nothing', async (body) => {
    const { deps, call } = await setup()
    const res = await call('POST', '/workspaces', body)
    expect(res.status).toBe(422)
    expect(deps.controlPlane.ofType('workspace.created')).toEqual([])
  })

  test.each(['?page=0', '?size=0', '?size=101', '?page=x'])(
    'refuses the query %s',
    async (query) => {
      const { call } = await setup()
      expect((await call('GET', `/workspaces${query}`)).status).toBe(422)
    }
  )
})

describe('projects', () => {
  test('a new project has a development and a production environment, each with signing keys', async () => {
    const { deps, app, cookie, call, sessionId } = await setup()
    const owner = await workspace(call)
    const created = await project(call, owner.id, 'Web app')
    expect(created.project).toMatchObject({ workspaceId: owner.id, name: 'Web app' })
    expect(created.environments.map((item) => item.kind)).toEqual(['development', 'production'])
    for (const environment of created.environments) {
      expect(environment.projectId).toBe(created.project.id)
      const keys = await deps.signingKeys.list(environment.id)
      expect(keys.map((key) => key.status).sort()).toEqual(['active', 'next'])
      // The environment works at once: the admin API answers for it.
      const res = await app.request('/v1/admin/signing-keys', {
        headers: dashboardHeaders(cookie, environment.id),
      })
      expect(res.status).toBe(200)
      const jwks = await app.request(`/v1/environments/${environment.id}/.well-known/jwks.json`)
      expect(jwks.status).toBe(200)
    }
    expect(deps.controlPlane.ofType('project.created')).toMatchObject([
      {
        actor: { type: 'instance_admin', id: sessionId },
        target: { type: 'project', id: created.project.id },
        data: { workspaceId: owner.id },
      },
    ])
    expect(
      deps.controlPlane.ofType('environment.created').map((entry) => [entry.target, entry.data])
    ).toEqual(
      created.environments.map((environment) => [
        { type: 'environment', id: environment.id },
        { projectId: created.project.id, kind: environment.kind },
      ])
    )
    // No name in the audit log: it is free text an operator typed.
    expect(JSON.stringify(deps.controlPlane.entries)).not.toContain('Web app')
  })

  test('listed per workspace, and renamed', async () => {
    const { deps, call } = await setup()
    const owner = await workspace(call, 'Owner')
    const other = await workspace(call, 'Other')
    const first = await project(call, owner.id, 'First')
    deps.clock.advance('1m')
    const second = await project(call, owner.id, 'Second')
    await project(call, other.id, 'Elsewhere')

    const listed = (await (
      await call('GET', `/projects?workspaceId=${owner.id}`)
    ).json()) as Page<Project>
    expect(listed.data.map((item) => item.name)).toEqual(['First', 'Second'])
    expect(listed.meta.totalCount).toBe(2)
    const all = (await (await call('GET', '/projects')).json()) as Page<Project>
    expect(all.meta.totalCount).toBe(3)

    deps.clock.advance('1m')
    const res = await call('PATCH', `/projects/${second.project.id}`, { name: 'Renamed' })
    expect(res.status).toBe(200)
    const renamed = (await res.json()) as Project
    expect(renamed).toMatchObject({ id: second.project.id, name: 'Renamed' })
    expect(renamed.updatedAt).not.toBe(second.project.updatedAt)
    expect(renamed.createdAt).toBe(second.project.createdAt)
    expect(deps.controlPlane.ofType('project.renamed')).toMatchObject([
      { target: { type: 'project', id: second.project.id }, data: { changed: ['name'] } },
    ])
    expect(first.project.name).toBe('First')
  })

  test('an unknown workspace or project is a 404 and nothing is created or recorded', async () => {
    const { deps, call } = await setup()
    const create = await call('POST', '/projects', { workspaceId: MISSING, name: 'Orphan' })
    expect(create.status).toBe(404)
    expect((await call('PATCH', `/projects/${MISSING}`, { name: 'Nothing' })).status).toBe(404)
    expect(
      (await call('POST', `/projects/${MISSING}/environments`, { kind: 'production' })).status
    ).toBe(404)
    expect(deps.controlPlane.projects).toEqual([])
    expect(await deps.environments.listAll()).toEqual([])
    expect(deps.controlPlane.entries.map((entry) => entry.type)).toEqual(['instance.signed_in'])
  })

  test.each([
    [{}],
    [{ name: 'No workspace' }],
    [{ workspaceId: 'not-a-uuid', name: 'x' }],
    [{ workspaceId: MISSING, name: '' }],
    [{ workspaceId: MISSING, name: 'x'.repeat(101) }],
    [{ workspaceId: MISSING, name: 'ok', environments: ['staging'] }],
  ])('refuses the project %j', async (body) => {
    const { call } = await setup()
    expect((await call('POST', '/projects', body)).status).toBe(422)
  })

  test('a malformed project id or rename body is a 422', async () => {
    const { call } = await setup()
    expect((await call('PATCH', '/projects/not-a-uuid', { name: 'x' })).status).toBe(422)
    expect((await call('PATCH', `/projects/${MISSING}`, {})).status).toBe(422)
    expect((await call('GET', '/projects?workspaceId=nope')).status).toBe(422)
  })
})

describe('environments', () => {
  test('listed across projects and per project; a second one of a kind is a conflict', async () => {
    const { deps, call } = await setup()
    const owner = await workspace(call)
    const first = await project(call, owner.id, 'First')
    deps.clock.advance('1m')
    const second = await project(call, owner.id, 'Second')

    const all = (await (await call('GET', '/environments')).json()) as Page<Environment>
    expect(all.data.map((item) => [item.projectId, item.kind])).toEqual([
      [first.project.id, 'development'],
      [first.project.id, 'production'],
      [second.project.id, 'development'],
      [second.project.id, 'production'],
    ])
    const one = (await (
      await call('GET', `/environments?projectId=${second.project.id}`)
    ).json()) as Page<Environment>
    expect(one.data.map((item) => item.id)).toEqual(second.environments.map((item) => item.id))

    const before = deps.controlPlane.ofType('environment.created').length
    const res = await call('POST', `/projects/${first.project.id}/environments`, {
      kind: 'production',
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('resource.conflict')
    expect(deps.controlPlane.ofType('environment.created')).toHaveLength(before)
  })

  test('an environment added to a project that lacks one gets its signing keys and an entry', async () => {
    const { deps, call, sessionId } = await setup()
    // A project from before this step, with one environment only.
    const owner = await workspace(call)
    const now = deps.clock.now()
    const projectId = '00000000-0000-7000-8000-00000000aaaa'
    deps.controlPlane.projects.push({
      id: projectId,
      workspaceId: owner.id,
      name: 'Legacy',
      createdAt: now,
      updatedAt: now,
    })
    const res = await call('POST', `/projects/${projectId}/environments`, { kind: 'production' })
    expect(res.status).toBe(201)
    const environment = (await res.json()) as Environment
    expect(environment).toMatchObject({ projectId, kind: 'production' })
    const keys = await deps.signingKeys.list(environment.id)
    expect(keys.map((key) => key.status).sort()).toEqual(['active', 'next'])
    expect(deps.controlPlane.ofType('environment.created')).toMatchObject([
      {
        actor: { type: 'instance_admin', id: sessionId },
        target: { type: 'environment', id: environment.id },
        data: { projectId, kind: 'production' },
      },
    ])
    for (const body of [{}, { kind: 'staging' }, { kind: 'production', extra: 1 }]) {
      expect((await call('POST', `/projects/${projectId}/environments`, body)).status).toBe(422)
    }
  })
})

describe('GET /v1/instance/audit-logs', () => {
  test('newest first, filtered by action, actor, target and time, never with token material', async () => {
    const { deps, app, call, sessionId } = await setup()
    // A failed sign-in from before.
    await app.request('/v1/instance/session', {
      method: 'POST',
      headers: dashboardHeaders(),
      body: JSON.stringify({ token: 'wrong-token-wrong-token-wrong-token' }),
    })
    deps.clock.advance('1m')
    const owner = await workspace(call)
    deps.clock.advance('1m')
    const created = await project(call, owner.id)

    const res = await call('GET', '/audit-logs')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const page = (await res.json()) as Page<{
      action: string
      actor: { type: string; id: string | null }
      target: { type: string; id: string } | null
      ipAddress: string | null
      metadata: Record<string, unknown>
      occurredAt: string
    }>
    expect(page.data.map((entry) => entry.action)).toEqual([
      'environment.created',
      'environment.created',
      'project.created',
      'workspace.created',
      'instance.sign_in_failed',
      'instance.signed_in',
    ])
    expect(page.meta.totalCount).toBe(6)
    expect(JSON.stringify(page)).not.toContain('wrong-token')

    const filter = async (query: string) =>
      ((await (await call('GET', `/audit-logs?${query}`)).json()) as typeof page).data.map(
        (entry) => entry.action
      )
    expect(await filter('action=project.created')).toEqual(['project.created'])
    expect(await filter(`targetId=${created.project.id}`)).toEqual(['project.created'])
    expect(await filter(`actorId=${sessionId}`)).toHaveLength(5)
    const from = encodeURIComponent(new Date(deps.clock.now().getTime() - 60_000).toISOString())
    const to = encodeURIComponent(deps.clock.now().toISOString())
    expect(await filter(`from=${from}&to=${to}`)).toEqual(['workspace.created'])
    expect(await filter('size=2&page=3')).toEqual(['instance.sign_in_failed', 'instance.signed_in'])

    for (const query of ['action=user.created', 'actorId=nope', 'from=yesterday', 'size=500']) {
      expect((await call('GET', `/audit-logs?${query}`)).status).toBe(422)
    }
  })
})
