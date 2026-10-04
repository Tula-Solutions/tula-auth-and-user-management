import { beforeEach, describe, expect, test } from 'bun:test'
import type { AuditLogList, SessionTokens, User } from '@tula/contract'
import { createApp } from '~/index'
import * as Sessions from '~/modules/session/service'
import { createTestDeps, seedApiKey, TEST_CONFIG, TEST_TENANT, type TestDeps } from '~/testing'

const SK = 'tula_sk_dev_admin000000000000000000000000000000'
const PROD_SK = 'tula_sk_prod_admin00000000000000000000000000000'
const PK = 'tula_pk_dev_publishable0000000000000000000'
const PASSWORD = 'correct horse battery staple'
const ADMIN_IP = '203.0.113.50'
const tenant = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }
let deps: TestDeps
let app: ReturnType<typeof createApp>
let secretKeyId: string

beforeEach(async () => {
  // Behind a proxy, so requests carry a client IP the audit log can record.
  deps = createTestDeps({ config: { ...TEST_CONFIG, trustProxy: true } })
  for (const [id, kind] of [
    [TEST_TENANT.environmentId, 'development'],
    [TEST_TENANT.productionEnvironmentId, 'production'],
  ] as const) {
    deps.environments.add({
      id,
      projectId: TEST_TENANT.projectId,
      kind,
      createdAt: deps.clock.now(),
    })
  }
  secretKeyId = (await seedApiKey(deps, SK)).id
  await seedApiKey(deps, PK)
  await seedApiKey(deps, PROD_SK, { environmentId: TEST_TENANT.productionEnvironmentId })
  app = createApp(deps)
})

function admin(method: string, path: string, body?: unknown, key: string | null = SK) {
  return app.request(`/v1/admin${path}`, {
    method,
    headers: {
      'x-forwarded-for': ADMIN_IP,
      'user-agent': 'acme-backend/2.1',
      ...(key && { authorization: `Bearer ${key}` }),
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function client(method: string, path: string, accessToken?: string, body?: unknown) {
  return app.request(`/v1/client${path}`, {
    method,
    headers: {
      'x-tula-publishable-key': PK,
      'x-forwarded-for': '198.51.100.4',
      'user-agent': 'Mozilla/5.0',
      ...(accessToken && { authorization: `Bearer ${accessToken}` }),
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const json = async <T>(res: Response) => (await res.json()) as T
const log = async (query = '', key = SK) =>
  json<AuditLogList>(await admin('GET', `/audit-logs${query}`, undefined, key))

async function createUser(email = 'maya@northline.app') {
  const res = await admin('POST', '/users', { email, password: PASSWORD })
  expect(res.status).toBe(201)
  return json<User>(res)
}

const signIn = (userId: string): Promise<SessionTokens> =>
  Sessions.create(deps, tenant, {
    userId,
    client: 'ios',
    userAgent: 'TulaSDK/1 iOS',
    ipAddress: '198.51.100.4',
  })

describe('GET /v1/admin/audit-logs', () => {
  test('requires a secret key', async () => {
    expect((await admin('GET', '/audit-logs', undefined, null)).status).toBe(401)
    expect((await admin('GET', '/audit-logs', undefined, PK)).status).toBe(401)
    expect((await admin('GET', '/audit-logs')).status).toBe(200)
  })

  test('an empty environment has an empty log', async () => {
    expect(await log()).toEqual({
      meta: { totalCount: 0, totalPages: 0, page: 1, perPage: 20 },
      data: [],
    })
  })

  test.each([
    '?page=0',
    '?size=101',
    '?size=0',
    '?action=user.exploded',
    '?actorId=not-a-uuid',
    '?targetId=1%27%20or%201=1',
  ])('rejects %s', async (query) => {
    const res = await admin('GET', `/audit-logs${query}`)
    expect(res.status).toBe(422)
    expect(await json<{ code: string }>(res)).toMatchObject({ code: 'validation.failed' })
  })

  test('admin actions are recorded with the key that made them and where it called from', async () => {
    const user = await createUser()
    expect((await admin('POST', `/users/${user.id}/ban`)).status).toBe(200)
    expect((await admin('POST', `/users/${user.id}/unban`)).status).toBe(200)
    expect(
      (await admin('PUT', `/users/${user.id}/password`, { password: 'an entirely new passphrase' }))
        .status
    ).toBe(204)
    expect((await admin('DELETE', `/users/${user.id}`)).status).toBe(204)

    const { meta, data } = await log(`?targetId=${user.id}`)
    expect(meta.totalCount).toBe(5)
    expect(data.map((entry) => entry.action)).toEqual([
      'user.deleted',
      'user.password_changed',
      'user.unbanned',
      'user.banned',
      'user.created',
    ])
    for (const entry of data) {
      expect(entry).toMatchObject({
        actor: { type: 'admin', id: secretKeyId },
        target: { type: 'user', id: user.id },
        ipAddress: ADMIN_IP,
        userAgent: 'acme-backend/2.1',
      })
    }
    expect((await log(`?actorId=${secretKeyId}&action=user.banned`)).data).toHaveLength(1)
  })

  test('key management and key rotation are recorded', async () => {
    const created = await json<{ id: string; key: string }>(
      await admin('POST', '/api-keys', { kind: 'secret', name: 'Worker' })
    )
    expect((await admin('DELETE', `/api-keys/${created.id}`)).status).toBe(200)
    const { data } = await log(`?targetId=${created.id}`)
    expect(data.map((entry) => entry.action)).toEqual(['api_key.revoked', 'api_key.created'])
    expect(data.at(-1)?.metadata).toEqual({ kind: 'secret' })
    expect(JSON.stringify(data)).not.toContain(created.key)
  })

  test('what a signed-in user does is recorded as theirs', async () => {
    const user = await createUser()
    const current = await signIn(user.id)
    const other = await signIn(user.id)
    const res = await client('DELETE', `/sessions/${other.sessionId}`, current.accessToken)
    expect(res.status).toBe(204)
    const { data } = await log(`?targetId=${other.sessionId}`)
    expect(data).toMatchObject([
      {
        action: 'session.revoked',
        actor: { type: 'user', id: user.id },
        target: { type: 'session', id: other.sessionId },
        ipAddress: '198.51.100.4',
        userAgent: 'Mozilla/5.0',
        metadata: { userId: user.id, reason: 'revoked_by_user' },
      },
      { action: 'session.created', actor: { type: 'user', id: user.id } },
    ])
  })

  test('a replayed refresh token shows up as session.reuse_detected', async () => {
    const user = await createUser()
    const first = await signIn(user.id)
    const refresh = (refreshToken: string | undefined) =>
      client('POST', '/sessions/refresh', undefined, { refreshToken })
    expect((await refresh(first.refreshToken)).status).toBe(200)
    deps.clock.advance('11s')
    const replay = await refresh(first.refreshToken)
    expect(await json<{ code: string }>(replay)).toMatchObject({ code: 'session.reuse_detected' })

    const { data } = await log('?action=session.reuse_detected')
    expect(data).toMatchObject([
      {
        actor: { type: 'system', id: null },
        target: { type: 'session', id: first.sessionId },
        ipAddress: '198.51.100.4',
        metadata: { userId: user.id, reason: 'reuse_detected' },
      },
    ])
  })

  test('reads only the secret key’s own environment', async () => {
    await createUser()
    expect((await log()).meta.totalCount).toBe(1)
    expect((await log('', PROD_SK)).meta.totalCount).toBe(0)
  })

  test('pages through the log', async () => {
    for (const email of ['a@northline.app', 'b@northline.app', 'c@northline.app']) {
      deps.clock.advance(1_000)
      await createUser(email)
    }
    const first = await log('?size=2')
    const second = await log('?size=2&page=2')
    expect(first.meta).toEqual({ totalCount: 3, totalPages: 2, page: 1, perPage: 2 })
    expect(first.data).toHaveLength(2)
    expect(second.data).toHaveLength(1)
    const ids = [...first.data, ...second.data].map((entry) => entry.id)
    expect(new Set(ids).size).toBe(3)
  })

  test('the response never contains a password, a token or an email address', async () => {
    const user = await createUser()
    const tokens = await signIn(user.id)
    await client('POST', '/sessions/sign-out', undefined, { refreshToken: tokens.refreshToken })
    const body = JSON.stringify(await log()).toLowerCase()
    for (const secret of [
      PASSWORD,
      'northline',
      tokens.refreshToken ?? 'x',
      tokens.accessToken ?? 'x',
    ]) {
      expect(body).not.toContain(secret.toLowerCase())
    }
  })
})
