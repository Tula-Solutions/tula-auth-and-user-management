import { describe, expect, test } from 'bun:test'
import { createApp } from '../../../apps/api/src/index'
import { createTestDeps, seedApiKey, TEST_TENANT } from '../../../apps/api/src/testing'
import {
  type AdminFetch,
  createAdminClient,
  createAgentClient,
  isTulaAdminError,
  type TulaAdminError,
} from './index'

// The agent's client (ADR 0053) against the real server in process: what an agent key may
// do through `@tula-tech/admin`, and what it may not.

const SECRET_KEY = 'tula_sk_dev_agentclient000000000000000000000'
const AGENT_KEY = 'tula_ak_dev_agentclient000000000000000000000'
const BASE_URL = 'http://localhost:3003'

async function world() {
  const deps = createTestDeps()
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  await seedApiKey(deps, SECRET_KEY)
  await seedApiKey(deps, AGENT_KEY)
  const app = createApp(deps)
  const requests: Array<{ line: string; authorization: string | null }> = []
  const fetch: AdminFetch = async (url, init) => {
    requests.push({
      line: `${init?.method ?? 'GET'} ${url.slice(BASE_URL.length)}`,
      authorization: new Headers(init?.headers).get('authorization'),
    })
    return app.request(url, init)
  }
  return {
    deps,
    requests,
    admin: createAdminClient({ baseUrl: BASE_URL, secretKey: SECRET_KEY, fetch }),
    agent: createAgentClient({ baseUrl: BASE_URL, agentKey: AGENT_KEY, fetch }),
  }
}

async function failure(promise: Promise<unknown>): Promise<TulaAdminError> {
  try {
    await promise
  } catch (error) {
    if (isTulaAdminError(error)) {
      return error
    }
    throw error
  }
  throw new Error('expected the call to fail')
}

function refusal(build: () => unknown): TulaAdminError {
  try {
    build()
  } catch (error) {
    if (isTulaAdminError(error)) {
      return error
    }
    throw error
  }
  throw new Error('expected the client to be refused')
}

describe('createAgentClient', () => {
  test.each([
    ['a secret key', SECRET_KEY],
    ['a publishable key', 'tula_pk_dev_agentclient000000000000000000000'],
    ['an empty key', ''],
    ['something that is not a key', 'hunter2-not-a-key'],
    ['a key with a line break', 'tula_ak_dev_abcdefghijklmnop\r\nx-evil: 1'],
    ['a key too short to be one', 'tula_ak_dev_abc'],
  ])('refuses %s without echoing it or sending anything', (_name, key) => {
    const sent: string[] = []
    const error = refusal(() =>
      createAgentClient({
        baseUrl: BASE_URL,
        agentKey: key,
        fetch: async (url) => {
          sent.push(url)
          return new Response(null)
        },
      })
    )
    expect(error.code).toBe('client.invalid_agent_key')
    expect(error.status).toBe(0)
    if (key !== '') {
      expect(error.message).not.toContain(key)
      expect(JSON.stringify(error)).not.toContain(key)
    }
    expect(sent).toEqual([])
  })

  test('refuses a plain http address that is not this machine, as the admin client does', () => {
    const error = refusal(() =>
      createAgentClient({ baseUrl: 'http://auth.example.com', agentKey: AGENT_KEY })
    )
    expect(error.code).toBe('client.invalid_url')
  })

  test('the key is in no property of the client, and not in what it serializes to', async () => {
    const { agent } = await world()
    expect(JSON.stringify(agent)).not.toContain('tula_ak_')
    expect(Object.values(agent).every((value) => typeof value === 'function')).toBe(true)
  })
})

describe('an agent’s client against the API', () => {
  test('reads, proposes, and is refused everything that changes something', async () => {
    const { admin, agent, requests } = await world()
    const { data: user } = await admin.call('createUser', {
      body: { email: 'maya@northline.app', password: 'correct horse battery staple' },
    })

    // It reads what a secret key reads.
    const read = await agent.call('getUser', { params: { userId: user.id } })
    expect(read.data.id).toBe(user.id)

    // It proposes, and nothing happens.
    const proposed = await agent.call('createProposal', {
      body: { operation: 'ban_user', target: { type: 'user', id: user.id } },
    })
    expect(proposed.status).toBe(201)
    expect(proposed.data).toMatchObject({ status: 'pending', operation: 'ban_user' })
    expect((await admin.call('getUser', { params: { userId: user.id } })).data.bannedAt).toBeNull()

    // It cannot do what it proposed, and it cannot approve it.
    const ban = await failure(agent.call('banUser', { params: { userId: user.id } }))
    expect(ban).toMatchObject({ code: 'auth.invalid_key', status: 401 })
    const approve = await failure(
      agent.call('approveProposal', {
        params: { id: proposed.data.id },
        body: { operation: 'ban_user', target: { type: 'user', id: user.id } },
      })
    )
    expect(approve).toMatchObject({ code: 'auth.invalid_key', status: 401 })
    expect((await admin.call('getUser', { params: { userId: user.id } })).data.bannedAt).toBeNull()

    // A human's key approves, and then it has happened.
    const approved = await admin.call('approveProposal', {
      params: { id: proposed.data.id },
      body: { operation: proposed.data.operation, target: proposed.data.target },
    })
    expect(approved.data.status).toBe('executed')
    expect(
      (await admin.call('getUser', { params: { userId: user.id } })).data.bannedAt
    ).not.toBeNull()

    // Each client sent its own credential, on every request.
    const agentLines = requests.filter((one) => one.authorization === `Bearer ${AGENT_KEY}`)
    expect(agentLines.map((one) => one.line)).toEqual([
      `GET /v1/admin/users/${user.id}`,
      'POST /v1/agent/proposals',
      `POST /v1/admin/users/${user.id}/ban`,
      `POST /v1/admin/proposals/${proposed.data.id}/approve`,
    ])
  })

  test('a secret key cannot propose: a human makes a change, an agent asks for one', async () => {
    const { admin } = await world()
    const error = await failure(
      admin.call('createProposal', {
        body: {
          operation: 'ban_user',
          target: { type: 'user', id: '00000000-0000-7000-8000-00000000cafe' },
        },
      })
    )
    expect(error).toMatchObject({ code: 'auth.invalid_key', status: 401 })
  })

  test('an error of the agent’s client never carries its key', async () => {
    const { agent } = await world()
    const error = await failure(
      agent.call('banUser', { params: { userId: '00000000-0000-7000-8000-00000000cafe' } })
    )
    expect(JSON.stringify(error)).not.toContain('tula_ak_')
    expect(String(error)).not.toContain('tula_ak_')
  })
})
