import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { SessionTokens } from '@tula/contract'
import { createApp } from '~/index'
import { base32Decode, totp } from '~/lib/totp'
import { PUBLISHABLE_KEY_HEADER, publishableKey } from '~/middleware/publishable-key'
import { requireRecentAuth } from '~/middleware/recent-auth'
import { sessionAuth } from '~/middleware/session-auth'
import * as Mfa from '~/modules/mfa/service'
import * as Notices from '~/modules/notice/service'
import * as Sessions from '~/modules/session/service'
import { createTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'

const PK = 'tula_pk_dev_publishable0000000000000000000'
const tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
let deps: TestDeps
let app: ReturnType<typeof createApp>
let userId: string

beforeEach(async () => {
  deps = createTestDeps()
  deps.environments.add({
    id: tenant.environmentId,
    projectId: tenant.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  await seedApiKey(deps, PK)
  userId = deps.ids.next()
  await deps.users.create({
    id: userId,
    projectId: tenant.projectId,
    environmentId: tenant.environmentId,
    email: 'maya@northline.app',
    emailNormalized: 'maya@northline.app',
    emailVerifiedAt: deps.clock.now(),
    firstName: null,
    lastName: null,
    createdAt: deps.clock.now(),
    identityId: deps.ids.next(),
    credentialId: deps.ids.next(),
    // A password hash that is never verified here: only its presence matters.
    passwordHash: '$argon2id$placeholder',
  })
  app = createApp(deps)
  const ok = (c: { json: (body: unknown) => Response }) => c.json({ ok: true })
  app.get('/test/default', publishableKey(), sessionAuth(), requireRecentAuth(), ok)
  app.get(
    '/test/one-minute',
    publishableKey(),
    sessionAuth(),
    requireRecentAuth({ maxAgeSeconds: 60 }),
    ok
  )
  app.get(
    '/test/second-factor-only',
    publishableKey(),
    sessionAuth(),
    requireRecentAuth({ onlyWithSecondFactor: true }),
    ok
  )
})

afterEach(() => Notices.settled())

const call = (path: string, accessToken?: string) =>
  app.request(`/test/${path}`, {
    headers: {
      [PUBLISHABLE_KEY_HEADER]: PK,
      ...(accessToken && { authorization: `Bearer ${accessToken}` }),
    },
  })

const signIn = (authMethods: string[]) =>
  Sessions.create(deps, tenant, { userId, client: 'ios', authMethods })

/** Let `duration` pass and return the session's next access token (they live a minute). */
async function later(duration: string, tokens: SessionTokens): Promise<SessionTokens> {
  deps.clock.advance(duration)
  return Sessions.refresh(deps, tenant, tokens.refreshToken as string)
}

async function enrol() {
  const { secret } = await Mfa.startTotp(deps, tenant, userId)
  await Mfa.confirmTotp(deps, tenant, { userId }, totp(base32Decode(secret), deps.clock.now()), {
    type: 'user',
    id: userId,
    ipAddress: null,
    userAgent: null,
  })
}

const STEP_UP = {
  status: 403,
  code: 'auth.step_up_required',
  detail: 'Confirm it is you to continue.',
}

describe('requireRecentAuth', () => {
  test('lets a session through for ten minutes after its sign-in, then asks for a step-up', async () => {
    const tokens = await signIn(['pwd'])
    expect((await call('default', tokens.accessToken)).status).toBe(200)
    const stillRecent = await later('10m', tokens)
    expect((await call('default', stillRecent.accessToken)).status).toBe(200)
    const stale = await later('1s', stillRecent)
    const res = await call('default', stale.accessToken)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ...STEP_UP, params: { methods: 'password,email_code' } })
  })

  test('a route may ask for a shorter age', async () => {
    const tokens = await signIn(['pwd'])
    deps.clock.advance('59s')
    expect((await call('one-minute', tokens.accessToken)).status).toBe(200)
    const stale = await later('2s', tokens)
    expect((await call('one-minute', stale.accessToken)).status).toBe(403)
    // The default route still accepts the same token.
    expect((await call('default', stale.accessToken)).status).toBe(200)
  })

  test('a user with a second factor needs a session that proved it', async () => {
    await enrol()
    const withPassword = await signIn(['pwd'])
    const res = await call('default', withPassword.accessToken)
    expect(await res.json()).toEqual({ ...STEP_UP, params: { methods: 'totp,backup_code' } })
    const withFactor = await signIn(['pwd', 'otp', 'mfa'])
    expect((await call('default', withFactor.accessToken)).status).toBe(200)
  })

  test('onlyWithSecondFactor asks nothing of a user without one, however old the sign-in', async () => {
    const tokens = await later('3h', await signIn(['pwd']))
    expect((await call('second-factor-only', tokens.accessToken)).status).toBe(200)
    expect((await call('default', tokens.accessToken)).status).toBe(403)

    await enrol()
    // Enrolling ended that session; a new one without the factor is held to it.
    const fresh = await signIn(['pwd'])
    expect((await call('second-factor-only', fresh.accessToken)).status).toBe(403)
    const proven = await signIn(['pwd', 'otp', 'mfa'])
    expect((await call('second-factor-only', proven.accessToken)).status).toBe(200)
    expect(
      (await call('second-factor-only', (await later('11m', proven)).accessToken)).status
    ).toBe(403)
  })

  test('runs after sessionAuth: without a token the answer is 401, never a step-up', async () => {
    const res = await call('default')
    expect(res.status).toBe(401)
    expect(((await res.json()) as { code: string }).code).toBe('auth.unauthenticated')
  })
})
