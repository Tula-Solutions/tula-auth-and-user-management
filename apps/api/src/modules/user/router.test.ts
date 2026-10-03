import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { User, UserList } from '@tula/contract'
import { createApp } from '~/index'
import { base32Decode, totp } from '~/lib/totp'
import * as Mfa from '~/modules/mfa/service'
import * as Notices from '~/modules/notice/service'
import * as Passwords from '~/modules/password/service'
import * as Sessions from '~/modules/session/service'
import { createTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'

const SK = 'tula_sk_dev_admin000000000000000000000000000000'
const PROD_SK = 'tula_sk_prod_admin00000000000000000000000000000'
const PK = 'tula_pk_dev_publishable0000000000000000000'
const PASSWORD = 'correct horse battery staple'
const NEW_PASSWORD = 'an entirely new passphrase'
const tenant = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }
let deps: TestDeps
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  deps = createTestDeps()
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
  await seedApiKey(deps, SK)
  await seedApiKey(deps, PK)
  await seedApiKey(deps, PROD_SK, { environmentId: TEST_TENANT.productionEnvironmentId })
  app = createApp(deps)
})

function admin(method: string, path: string, body?: unknown, key: string | null = SK) {
  return app.request(`/v1/admin/users${path}`, {
    method,
    headers: {
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
      ...(accessToken && { authorization: `Bearer ${accessToken}` }),
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const json = async <T>(res: Response) => (await res.json()) as T
const code = async (res: Response) => (await json<{ code: string }>(res)).code

async function createUser(email = 'maya@northline.app', extra: object = {}) {
  const res = await admin('POST', '', { email, password: PASSWORD, ...extra })
  expect(res.status).toBe(201)
  return json<User>(res)
}

const signIn = (userId: string) =>
  Sessions.create(deps, tenant, { userId, client: 'ios', userAgent: null, ipAddress: null })

describe('admin: /v1/admin/users', () => {
  test('creates, gets and lists users', async () => {
    const created = await createUser('maya@northline.app', {
      firstName: 'Maya',
      emailVerified: true,
    })
    expect(created).toMatchObject({
      email: 'maya@northline.app',
      firstName: 'Maya',
      bannedAt: null,
    })
    expect(created.emailVerifiedAt).not.toBeNull()
    expect(JSON.stringify(created)).not.toContain('argon2')

    const got = await admin('GET', `/${created.id}`)
    expect(got.status).toBe(200)
    expect(await json<User>(got)).toEqual(created)

    await createUser('zoe@northline.app')
    const listed = await json<UserList>(await admin('GET', '?size=1&sort=email'))
    expect(listed.meta).toEqual({ totalCount: 2, totalPages: 2, page: 1, perPage: 1 })
    expect(listed.data.map((u) => u.email)).toEqual(['maya@northline.app'])
    const searched = await json<UserList>(await admin('GET', '?q=ZOE'))
    expect(searched.data.map((u) => u.email)).toEqual(['zoe@northline.app'])
  })

  test('validates list parameters', async () => {
    for (const query of ['?size=0', '?size=101', '?page=0', '?sort=passwordHash', '?page=abc']) {
      expect((await admin('GET', query)).status).toBe(422)
    }
  })

  test('reports a taken email and invalid input', async () => {
    await createUser()
    const taken = await admin('POST', '', { email: 'MAYA@northline.app', password: PASSWORD })
    expect(taken.status).toBe(409)
    expect(await code(taken)).toBe('resource.conflict')
    const weak = await admin('POST', '', { email: 'new@northline.app', password: 'short' })
    expect(weak.status).toBe(422)
    expect(await code(weak)).toBe('password.too_short')
    expect((await admin('POST', '', { password: PASSWORD })).status).toBe(422)
  })

  test('creates a user without a password, who then gets one from the admin', async () => {
    const created = await admin('POST', '', { email: 'social@northline.app', emailVerified: true })
    expect(created.status).toBe(201)
    const user = await json<User>(created)
    expect(JSON.stringify(user)).not.toContain('password')
    const lookup = () => deps.users.findByEmailWithPassword(tenant.environmentId, user.email)
    expect((await lookup())?.passwordHash).toBeNull()

    const set = await admin('PUT', `/${user.id}/password`, { password: NEW_PASSWORD })
    expect(set.status).toBe(204)
    expect(await Passwords.verify((await lookup())?.passwordHash ?? null, NEW_PASSWORD)).toBe(true)
  })

  test('bans and unbans a user, ending their sessions', async () => {
    const user = await createUser()
    const tokens = await signIn(user.id)
    const banned = await admin('POST', `/${user.id}/ban`)
    expect(banned.status).toBe(200)
    expect((await json<User>(banned)).bannedAt).not.toBeNull()
    expect(await code(await client('GET', '/me', tokens.accessToken))).toBe('session.revoked')

    const unbanned = await admin('POST', `/${user.id}/unban`)
    expect((await json<User>(unbanned)).bannedAt).toBeNull()
  })

  test('sets a password, ending the user’s sessions', async () => {
    const user = await createUser()
    const tokens = await signIn(user.id)
    const res = await admin('PUT', `/${user.id}/password`, { password: NEW_PASSWORD })
    expect(res.status).toBe(204)
    const found = await deps.users.findByEmailWithPassword(
      tenant.environmentId,
      'maya@northline.app'
    )
    expect(await Passwords.verify(found?.passwordHash ?? null, NEW_PASSWORD)).toBe(true)
    expect(await code(await client('GET', '/me', tokens.accessToken))).toBe('session.revoked')
    expect((await admin('PUT', `/${user.id}/password`, { password: 'short' })).status).toBe(422)
  })

  test('deletes a user', async () => {
    const user = await createUser()
    expect((await admin('DELETE', `/${user.id}`)).status).toBe(204)
    expect((await admin('GET', `/${user.id}`)).status).toBe(404)
    expect((await admin('DELETE', `/${user.id}`)).status).toBe(404)
  })

  test('a key from another environment cannot see or touch the user', async () => {
    const user = await createUser()
    expect((await admin('GET', `/${user.id}`, undefined, PROD_SK)).status).toBe(404)
    expect((await admin('POST', `/${user.id}/ban`, undefined, PROD_SK)).status).toBe(404)
    expect((await admin('DELETE', `/${user.id}`, undefined, PROD_SK)).status).toBe(404)
    expect((await json<UserList>(await admin('GET', '', undefined, PROD_SK))).meta.totalCount).toBe(
      0
    )
    expect((await json<User>(await admin('GET', `/${user.id}`))).bannedAt).toBeNull()
  })

  test('requires a secret key and a well-formed id', async () => {
    expect(await code(await admin('GET', '', undefined, null))).toBe('auth.invalid_key')
    expect(await code(await admin('GET', '', undefined, PK))).toBe('auth.invalid_key')
    expect((await admin('GET', '/not-a-uuid')).status).toBe(422)
  })
})

describe('client: /v1/client/me', () => {
  test('returns the signed-in user', async () => {
    const user = await createUser()
    const tokens = await signIn(user.id)
    const res = await client('GET', '/me', tokens.accessToken)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await json<User>(res)).toEqual(user)
    expect(await code(await client('GET', '/me'))).toBe('auth.unauthenticated')
  })

  test('changes the password, keeping this device signed in and ending the others', async () => {
    const user = await createUser()
    const current = await signIn(user.id)
    const other = await signIn(user.id)
    const res = await client('POST', '/me/password', current.accessToken, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    })
    expect(res.status).toBe(204)
    expect((await client('GET', '/me', current.accessToken)).status).toBe(200)
    expect(await code(await client('GET', '/me', other.accessToken))).toBe('session.revoked')
  })

  test('refuses a wrong current password, a weak new one and an unauthenticated request', async () => {
    const user = await createUser()
    const tokens = await signIn(user.id)
    const wrong = await client('POST', '/me/password', tokens.accessToken, {
      currentPassword: 'not my password',
      newPassword: NEW_PASSWORD,
    })
    expect(wrong.status).toBe(401)
    expect(await code(wrong)).toBe('auth.invalid_credentials')
    const weak = await client('POST', '/me/password', tokens.accessToken, {
      currentPassword: PASSWORD,
      newPassword: 'short',
    })
    expect(await code(weak)).toBe('password.too_short')
    expect((await client('POST', '/me/password', tokens.accessToken, {})).status).toBe(422)
    expect(
      await code(
        await client('POST', '/me/password', undefined, {
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
        })
      )
    ).toBe('auth.unauthenticated')
  })

  test('an account with no password answers 409 password.not_set, only to its own signed-in user', async () => {
    const created = await admin('POST', '', { email: 'social@northline.app', emailVerified: true })
    const user = await json<User>(created)
    const tokens = await signIn(user.id)
    const body = { currentPassword: 'anything', newPassword: NEW_PASSWORD }
    const res = await client('POST', '/me/password', tokens.accessToken, body)
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ status: 409, code: 'password.not_set' })
    expect(
      (await deps.users.findByEmailWithPassword(tenant.environmentId, user.email))?.passwordHash
    ).toBeNull()
    // Without that user's access token the route says nothing about the account.
    expect(await code(await client('POST', '/me/password', undefined, body))).toBe(
      'auth.unauthenticated'
    )
  })
})

describe('client: changing a password with two-step verification on', () => {
  const scope = { ...tenant, apiKeyId: 'key_1' }
  const body = { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }
  afterEach(() => Notices.settled())

  const session = (userId: string, authMethods: string[]) =>
    Sessions.create(deps, tenant, { userId, client: 'ios', authMethods })
  const stored = async (email: string) =>
    (await deps.users.findByEmailWithPassword(tenant.environmentId, email))?.passwordHash ?? null

  /** Turn two-step verification on for a user; returns the authenticator's secret. */
  async function enrol(userId: string) {
    const { secret } = await Mfa.startTotp(deps, scope, userId)
    await Mfa.confirmTotp(deps, scope, { userId }, totp(base32Decode(secret), deps.clock.now()), {
      type: 'user',
      id: userId,
      ipAddress: null,
      userAgent: null,
    })
    deps.clock.advance('30s')
    return secret
  }

  test('a session that did not prove the second factor is asked to step up: the password stays', async () => {
    const user = await createUser()
    await enrol(user.id)
    const before = await stored(user.email)
    const tokens = await session(user.id, ['pwd'])
    const res = await client('POST', '/me/password', tokens.accessToken, body)
    expect(res.status).toBe(403)
    expect(await json<unknown>(res)).toEqual({
      status: 403,
      code: 'auth.step_up_required',
      detail: 'Confirm it is you to continue.',
      params: { methods: 'totp,backup_code' },
    })
    expect(await stored(user.email)).toBe(before)
    // Even a wrong current password is not looked at before the step-up.
    const wrong = await client('POST', '/me/password', tokens.accessToken, {
      currentPassword: 'not my password',
      newPassword: NEW_PASSWORD,
    })
    expect(await code(wrong)).toBe('auth.step_up_required')
  })

  test('a session that proved it in the last ten minutes changes the password', async () => {
    const user = await createUser()
    const secret = await enrol(user.id)
    const tokens = await session(user.id, ['pwd'])
    const stepped = await client('POST', '/sessions/step-up', tokens.accessToken, {
      method: 'totp',
      code: totp(base32Decode(secret), deps.clock.now()),
    })
    expect(stepped.status).toBe(200)
    const { accessToken } = await json<{ accessToken: string }>(stepped)
    const res = await client('POST', '/me/password', accessToken, body)
    expect(res.status).toBe(204)
    expect(await Passwords.verify(await stored(user.email), NEW_PASSWORD)).toBe(true)
    // The second factor is still on: changing a password does not remove it.
    expect(await Mfa.status(deps, scope, user.id)).toMatchObject({ totp: { enabled: true } })
  })

  test('a second factor proven more than ten minutes ago is not enough', async () => {
    const user = await createUser()
    await enrol(user.id)
    const tokens = await session(user.id, ['pwd', 'otp', 'mfa'])
    expect((await client('POST', '/me/password', tokens.accessToken, body)).status).toBe(204)

    const again = await session(user.id, ['pwd', 'otp', 'mfa'])
    deps.clock.advance('11m')
    const refreshed = await Sessions.refresh(deps, tenant, again.refreshToken as string)
    const res = await client('POST', '/me/password', refreshed.accessToken, {
      currentPassword: NEW_PASSWORD,
      newPassword: PASSWORD,
    })
    expect(await code(res)).toBe('auth.step_up_required')
    expect(await Passwords.verify(await stored(user.email), NEW_PASSWORD)).toBe(true)
  })

  test('a user without a second factor is not asked to step up, however old the sign-in', async () => {
    const user = await createUser()
    const tokens = await session(user.id, ['pwd'])
    deps.clock.advance('3h')
    const refreshed = await Sessions.refresh(deps, tenant, tokens.refreshToken as string)
    const res = await client('POST', '/me/password', refreshed.accessToken, body)
    expect(res.status).toBe(204)
    expect(await Passwords.verify(await stored(user.email), NEW_PASSWORD)).toBe(true)
  })

  test('a pending enrolment does not make the password change need a step-up', async () => {
    const user = await createUser()
    await Mfa.startTotp(deps, scope, user.id)
    const tokens = await session(user.id, ['pwd'])
    expect((await client('POST', '/me/password', tokens.accessToken, body)).status).toBe(204)
  })
})
