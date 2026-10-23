import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { AppEnv } from '~/dependencies'
import { onError } from '~/handlers'
import { createApp } from '~/index'
import { adminActor, agentActor } from '~/lib/actor'
import { agentKey } from '~/middleware/agent-key'
import { secretKey } from '~/middleware/secret-key'
import { createInstanceTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'

// An agent key (ADR 0053) reads what a secret key reads, asks for proposals and, where the
// environment allows it, runs a sign-in test (ADR 0058). This file holds the other half: it
// opens nothing else that changes anything, on any route the app has.

const AGENT_KEY = 'tula_ak_dev_agentkeytests0000000000000000000000000'
const SECRET_KEY = 'tula_sk_dev_agentkeytests0000000000000000000000000'
const SOME_ID = '00000000-0000-7000-8000-00000000cafe'

/** The one route an agent key opens that is not a read. It writes a proposal, and nothing else. */
const PROPOSE = 'POST /v1/agent/proposals'

/**
 * The one route an agent key opens that changes something by itself, for a few seconds: a
 * sign-in test's throwaway user (ADR 0058). Its own tests hold what it may do, where it is
 * allowed and what it leaves (`modules/sign-in-test/router.test.ts`); here it is the second
 * and last name on the list, and a third is a decision in an ADR.
 */
const TEST_SIGN_IN = 'POST /v1/agent/sign-in-tests'
const AGENT_ROUTES = [PROPOSE, TEST_SIGN_IN]

async function setup() {
  const deps = createInstanceTestDeps()
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  const agent = await seedApiKey(deps, AGENT_KEY)
  await seedApiKey(deps, SECRET_KEY)
  return { deps, app: createApp(deps), agent }
}

/** Every route the app has, read from the app itself. */
function routesOf(deps: TestDeps): Array<{ method: string; path: string }> {
  const seen = new Map<string, { method: string; path: string }>()
  for (const route of createApp(deps).routes) {
    if (route.method !== 'ALL' && route.path.startsWith('/v1/')) {
      seen.set(`${route.method} ${route.path}`, { method: route.method, path: route.path })
    }
  }
  return [...seen.values()]
}

function concrete(path: string): string {
  return path.replace(/:provider\b/, 'google').replace(/:[A-Za-z]+/g, SOME_ID)
}

function init(method: string, key: string): RequestInit {
  return {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: '{}' }),
  }
}

async function code(res: Response): Promise<string> {
  return ((await res.json()) as { code: string }).code
}

const routes = routesOf(createInstanceTestDeps())
const reads = routes.filter((route) => route.method === 'GET')
const writes = routes.filter((route) => route.method !== 'GET')

describe('an agent key changes nothing', () => {
  test('the app has routes of every group to check', () => {
    const groups = new Set(routes.map((route) => route.path.split('/')[2]))
    for (const group of ['admin', 'agent', 'client', 'instance']) {
      expect(groups).toContain(group)
    }
    expect(writes.filter((route) => route.path.startsWith('/v1/admin/')).length).toBeGreaterThan(20)
    expect(writes.map((route) => `${route.method} ${route.path}`)).toContain(PROPOSE)
    // The agent's group holds the proposal and the sign-in test, and nothing else.
    expect(
      routes
        .filter((route) => route.path.startsWith('/v1/agent/'))
        .map((route) => `${route.method} ${route.path}`)
    ).toEqual(AGENT_ROUTES)
  })

  for (const { method, path } of writes.filter(
    (route) => !AGENT_ROUTES.includes(`${route.method} ${route.path}`)
  )) {
    test(`${method} ${path} refuses it`, async () => {
      const { deps, app } = await setup()
      const res = await app.request(concrete(path), init(method, AGENT_KEY))
      if (path.startsWith('/v1/admin/')) {
        // Refused by the one middleware every admin route has, before the route: the answer
        // a wrong key gets, whatever the body or the id.
        expect(res.status).toBe(401)
        expect(await code(res)).toBe('auth.invalid_key')
      } else {
        // Another group's own credential check: an agent key is none of theirs.
        expect([400, 401, 403, 404]).toContain(res.status)
      }
      expect(deps.activityLog.entries).toEqual([])
      expect(res.headers.getSetCookie()).toEqual([])
    })
  }

  test('the refusal of a write does not depend on the key: unknown, revoked and valid alike', async () => {
    const { deps, app, agent } = await setup()
    const lookups: string[] = []
    const find = deps.apiKeys.findByHash.bind(deps.apiKeys)
    deps.apiKeys.findByHash = (hash) => {
      lookups.push(hash)
      return find(hash)
    }
    const answers: string[] = []
    for (const key of [AGENT_KEY, 'tula_ak_dev_nobody00000000000000000000000000000000']) {
      const res = await app.request(`/v1/admin/users/${SOME_ID}/ban`, init('POST', key))
      answers.push(`${res.status} ${await res.text()}`)
    }
    expect(new Set(answers.map((answer) => answer.replace(/"requestId":"[^"]*"/, ''))).size).toBe(1)
    // The method is judged before the key is looked up.
    expect(lookups).toEqual([])
    expect(agent.revokedAt).toBeNull()
  })

  test('every write of the admin API is refused with the dashboard’s environment header too', async () => {
    const { app } = await setup()
    const res = await app.request(`/v1/admin/users/${SOME_ID}/ban`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${AGENT_KEY}`,
        'x-tula-environment': TEST_TENANT.environmentId,
      },
    })
    expect(res.status).toBe(400)
  })
})

describe('an agent key reads what a secret key reads', () => {
  for (const { path } of reads.filter((route) => route.path.startsWith('/v1/admin/'))) {
    test(`GET ${path}`, async () => {
      const { deps, app } = await setup()
      const res = await app.request(concrete(path), init('GET', AGENT_KEY))
      // Authorized: whatever the route then says (a 404 for the made-up id), it is not a
      // refusal of the key.
      // An environment with organizations off answers `organization.disabled` (403) from the
      // service, which the key has reached.
      const body = (await res
        .clone()
        .json()
        .catch(() => ({}))) as { code?: string }
      if (!(res.status === 403 && body.code === 'organization.disabled')) {
        expect([400, 401, 403]).not.toContain(res.status)
      }
      expect(res.status).toBeLessThan(500)
      // A read records nothing and changes nothing.
      expect(deps.activityLog.entries).toEqual([])
    })
  }

  test('a HEAD is a read', async () => {
    const { app } = await setup()
    const res = await app.request('/v1/admin/users', init('HEAD', AGENT_KEY))
    expect(res.status).toBe(200)
  })

  test('it is no credential for the instance routes or the client routes', async () => {
    const { app } = await setup()
    expect((await app.request('/v1/instance/diagnostics', init('GET', AGENT_KEY))).status).toBe(401)
    const client = await app.request('/v1/client/config', {
      headers: { 'x-tula-publishable-key': AGENT_KEY },
    })
    expect(client.status).toBe(401)
  })

  test('a secret key is not an agent key: the agent’s group refuses it', async () => {
    const { app } = await setup()
    const res = await app.request('/v1/agent/proposals', init('POST', SECRET_KEY))
    expect(res.status).toBe(401)
    expect(await code(res)).toBe('auth.invalid_key')
  })
})

describe('the actor of a request made with an agent key', () => {
  function probe(deps: TestDeps) {
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      c.set('deps', deps)
      await next()
    })
    app.onError(onError)
    app.get('/admin', secretKey(), (c) =>
      c.json({ ...adminActor(c), agent: c.get('tenant').agent })
    )
    app.post('/agent', agentKey(), (c) =>
      c.json({ ...agentActor(c), agent: c.get('tenant').agent })
    )
    return app
  }

  test('is an agent, never an admin, on both middlewares', async () => {
    const { deps, agent } = await setup()
    const app = probe(deps)
    for (const [method, path] of [
      ['GET', '/admin'],
      ['POST', '/agent'],
    ] as const) {
      const res = await app.request(path, init(method, AGENT_KEY))
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ type: 'agent', id: agent.id, agent: true })
    }
    const admin = await app.request('/admin', init('GET', SECRET_KEY))
    const body = (await admin.json()) as { type: string; agent?: boolean }
    expect(body.type).toBe('admin')
    expect(body.agent).toBeUndefined()
  })

  test('a key of another kind with the agent prefix in front of it is not one', async () => {
    const { deps } = await setup()
    // Stored as a secret key under an agent key's spelling: the kind decides, not the prefix.
    const disguised = 'tula_ak_dev_disguised000000000000000000000000000000'
    await seedApiKey(deps, disguised, { kind: 'secret' })
    const app = probe(deps)
    expect((await app.request('/admin', init('GET', disguised))).status).toBe(401)
    expect((await app.request('/agent', init('POST', disguised))).status).toBe(401)
  })
})
