import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type {
  CurrentUser,
  EmailCodeSent,
  FlowAttempt,
  OAuthStart,
  UserAuthentication,
} from '@tula/contract'
import { mockOAuthProviders } from '~/adapters/oauth/mock'
import { createApp } from '~/index'
import * as Crypto from '~/lib/crypto'
import * as logger from '~/lib/logger'
import * as Audit from '~/modules/audit/service'
import * as EmailAddress from '~/modules/email-address/service'
import * as Notices from '~/modules/notice/service'
import * as Verification from '~/modules/verification/service'
import { createTestDeps, seedApiKey, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

// An email address for an account that has none (ADR 0059), from the routes to the store:
// the account is made by a real first sign-in with X through the mock provider.

const PK = 'tula_pk_dev_publishable0000000000000000000'
const SK = 'tula_sk_dev_secret000000000000000000000000'
const PK_B = 'tula_pk_dev_publishableb000000000000000000'
const TENANT_B = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.productionEnvironmentId,
}
const REDIRECT = 'http://localhost:5174/oauth/callback'
const ADDRESS = 'nelly@northline.app'
const TAKEN = 'maya@northline.app'

let deps: TestDeps
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  deps = createTestDeps()
  deps.config = { ...deps.config, oauthMock: true }
  Object.assign(deps, {
    oauth: mockOAuthProviders({
      secretBox: deps.secretBox,
      clock: deps.clock,
      publicUrl: deps.config.publicUrl,
    }),
  })
  for (const [id, kind] of [
    [TEST_TENANT.environmentId, 'development'],
    [TENANT_B.environmentId, 'production'],
  ] as const) {
    deps.environments.add({
      id,
      projectId: TEST_TENANT.projectId,
      kind,
      createdAt: deps.clock.now(),
    })
  }
  await seedApiKey(deps, PK)
  await seedApiKey(deps, SK)
  await seedApiKey(deps, PK_B, TENANT_B)
  app = createApp(deps)
  const configured = await app.request('/v1/admin/oauth-providers/x', {
    method: 'PUT',
    headers: { authorization: `Bearer ${SK}`, 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'mock-client', clientSecret: 'mock-secret' }),
  })
  expect(configured.status).toBe(200)
})

interface Signed {
  userId: string
  accessToken: string
  refreshToken: string
}

const pathOf = (url: string) => url.slice(new URL(url).origin.length)

/** A sign-in with X through the mock provider: a first one makes an account with no address. */
async function signIn(subject: string): Promise<Signed> {
  const startedRes = await app.request('/v1/client/sign-ins/oauth', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tula-publishable-key': PK,
      'x-tula-client': 'ios',
    },
    body: JSON.stringify({ provider: 'x', redirectUrl: REDIRECT }),
  })
  const started = (await startedRes.json()) as OAuthStart
  const consented = await app.request('/v1/dev/oauth/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', host: 'localhost' },
    body: new URLSearchParams({
      ...Object.fromEntries(new URL(started.authorizationUrl).searchParams),
      subject,
    }),
  })
  const callback = await app.request(pathOf(consented.headers.get('location') as string))
  const fragment = new URLSearchParams((callback.headers.get('location') as string).split('#')[1])
  const res = await app.request('/v1/client/sign-ins/oauth/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tula-publishable-key': PK },
    body: JSON.stringify({
      ticket: fragment.get('tula_ticket'),
      attemptId: fragment.get('tula_attempt'),
      binding: started.binding,
    }),
  })
  const body = (await res.json()) as FlowAttempt
  const step = body.step as { userId: string }
  return {
    userId: step.userId,
    accessToken: body.session?.accessToken as string,
    refreshToken: body.session?.refreshToken as string,
  }
}

function client(path: string, token: string | null, body?: unknown, key: string | null = PK) {
  return app.request(`/v1/client/me${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key !== null && { 'x-tula-publishable-key': key }),
      ...(token !== null && { authorization: `Bearer ${token}` }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
}

const ask = (token: string | null, email: string = ADDRESS, key: string | null = PK) =>
  client('/email', token, { email }, key)
const confirm = (token: string | null, code: string, key: string | null = PK) =>
  client('/email/verify', token, { code }, key)
const errorOf = async (res: Response) =>
  (await res.json()) as { code: string; params?: Record<string, unknown> }
const codeOf = async (res: Response) => (await errorOf(res)).code
/** The code in the newest email whose subject leads with one. */
const emailedCode = () =>
  /^(\d{6}) /.exec(
    deps.mailer.outbox.findLast((mail) => /^\d{6} /.test(mail.subject))?.subject ?? ''
  )?.[1] ?? ''
const wrong = (code: string) => (code === '000000' ? '000001' : '000000')
const stored = (userId: string) => deps.users.findById(TEST_TENANT.environmentId, userId)
const added = () => deps.activityLog.entries.filter((entry) => entry.type === 'user.email_added')
const pending = (userId: string) =>
  deps.verificationTokens.findLatest(TEST_TENANT.environmentId, 'email_addition', { userId })

/** An account that has an address (and a password), made as an administrator makes one. */
async function account(email: string, environmentId: string = TEST_TENANT.environmentId) {
  const id = deps.ids.next()
  await deps.users.create(
    {
      id,
      projectId: TEST_TENANT.projectId,
      environmentId,
      email,
      emailNormalized: email,
      emailVerifiedAt: deps.clock.now(),
      firstName: null,
      lastName: null,
      createdAt: deps.clock.now(),
      identityId: deps.ids.next(),
      credentialId: deps.ids.next(),
      passwordHash: '$argon2id$hash',
    },
    Audit.none('fixture')
  )
  return id
}

describe('adding an address', () => {
  test('emails a code, stores nothing until it is confirmed, then the address is verified', async () => {
    const session = await signIn('2244994945')
    deps.mailer.outbox.length = 0

    const asked = await ask(session.accessToken, ' Nelly@Northline.app ')
    expect(asked.status).toBe(200)
    expect(asked.headers.get('cache-control')).toBe('no-store')
    const sent = (await asked.json()) as EmailCodeSent
    expect(Object.keys(sent).sort()).toEqual(['destination', 'expiresAt'])
    expect(sent.destination).not.toContain('nelly')
    expect(deps.mailer.outbox.map((mail) => mail.to)).toEqual(['Nelly@Northline.app'])
    // Pending: on the token, not on the user.
    expect(await stored(session.userId)).toMatchObject({ email: null, emailVerifiedAt: null })
    expect(added()).toEqual([])

    const res = await confirm(session.accessToken, emailedCode())
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect((await res.json()) as CurrentUser).toMatchObject({
      id: session.userId,
      email: ADDRESS,
      hasPassword: false,
    })
    const user = await stored(session.userId)
    expect(user).toMatchObject({ email: ADDRESS, emailNormalized: ADDRESS })
    expect(user?.emailVerifiedAt).toEqual(deps.clock.now())
    expect(await deps.users.findByEmail(TEST_TENANT.environmentId, ADDRESS)).toMatchObject({
      id: session.userId,
    })
    const identities = await deps.users.listIdentities(TEST_TENANT.environmentId, session.userId)
    // The provider's identity is untouched (the address's own row is the store's business:
    // the shared repository suite holds it).
    expect(identities.map((identity) => identity.provider)).toEqual(['x'])

    // Recorded once, by the user, with no address in it.
    expect(added()).toHaveLength(1)
    expect(added()[0]).toMatchObject({
      actor: { type: 'user', id: session.userId },
      target: { type: 'user', id: session.userId },
      data: { method: 'self', verified: true },
    })
    expect(JSON.stringify(added())).not.toContain('northline')

    // And announced, to the address the account now has.
    await Notices.settled()
    const notice = deps.mailer.last()
    expect(notice.to).toBe(ADDRESS)
    expect(notice.subject).not.toMatch(/^\d/)
    expect(notice.text).not.toMatch(/\d{6}/)
  })

  test('makes the account one that can sign in without its provider', async () => {
    const session = await signIn('2244994945')
    await ask(session.accessToken)
    expect((await confirm(session.accessToken, emailedCode())).status).toBe(200)
    const means = (await (
      await app.request(`/v1/admin/users/${session.userId}/authentication`, {
        headers: { authorization: `Bearer ${SK}` },
      })
    ).json()) as UserAuthentication
    expect(means).toMatchObject({ hasPassword: false, emailVerified: true })
  })

  test('the newest address asked for is the pending one', async () => {
    const session = await signIn('2244994945')
    await ask(session.accessToken, 'first@northline.app')
    const first = emailedCode()
    deps.clock.advance('61s')
    const fresh = await signIn('2244994945')
    await ask(fresh.accessToken, 'second@northline.app')
    const second = emailedCode()
    // The replaced code proves nothing, not even its own address.
    if (first !== second) {
      expect(await codeOf(await confirm(fresh.accessToken, first))).toBe(
        'verification.invalid_code'
      )
    }
    expect((await confirm(fresh.accessToken, second)).status).toBe(200)
    expect(await stored(session.userId)).toMatchObject({ email: 'second@northline.app' })
  })
})

describe('who may ask', () => {
  test('nobody without a publishable key or a session', async () => {
    const session = await signIn('2244994945')
    for (const send of [ask, confirm]) {
      expect((await send(session.accessToken, ADDRESS, null)).status).toBe(401)
      expect((await send(null, ADDRESS)).status).toBe(401)
      // Another environment's key: the token is not that environment's.
      expect((await send(session.accessToken, ADDRESS, PK_B)).status).toBe(401)
    }
    expect(deps.mailer.outbox.filter((mail) => mail.to === ADDRESS)).toEqual([])
  })

  test('a session whose sign-in is older than ten minutes steps up first, and has nothing to step up with', async () => {
    const session = await signIn('2244994945')
    deps.clock.advance('11m')
    const refreshed = (await (
      await app.request('/v1/client/sessions/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tula-publishable-key': PK },
        body: JSON.stringify({ refreshToken: session.refreshToken }),
      })
    ).json()) as { accessToken: string }
    deps.mailer.outbox.length = 0
    for (const res of [
      await ask(refreshed.accessToken),
      await confirm(refreshed.accessToken, '123456'),
    ]) {
      expect(res.status).toBe(403)
      // No password, no address, no passkey, no second factor: the user signs in again.
      expect(await errorOf(res)).toMatchObject({
        code: 'auth.step_up_required',
        params: { methods: '' },
      })
    }
    expect(deps.mailer.outbox).toEqual([])

    // Signing in again with the provider is the recent authentication.
    const again = await signIn('2244994945')
    expect(again.userId).toBe(session.userId)
    expect((await ask(again.accessToken)).status).toBe(200)
  })

  test('what is not an address is refused, and nothing is sent', async () => {
    const session = await signIn('2244994945')
    deps.mailer.outbox.length = 0
    const res = await ask(session.accessToken, 'not an address')
    expect(res.status).toBe(422)
    expect(deps.mailer.outbox).toEqual([])
    expect(await pending(session.userId)).toBeNull()
  })

  test('an account that has an address is refused on both routes, before anything is sent or counted', async () => {
    const userId = await account(TAKEN)
    const hit = spyOn(deps.rateLimiter, 'hit')
    const attempt = spyOn(deps.lockout, 'attempt')
    await expect(
      EmailAddress.request(deps, TEST_TENANT, { userId }, { email: ADDRESS })
    ).rejects.toMatchObject({ code: 'email.already_set', status: 409 })
    await expect(
      EmailAddress.verify(deps, TEST_TENANT, { userId }, { code: '123456' })
    ).rejects.toMatchObject({ code: 'email.already_set' })
    expect(hit).not.toHaveBeenCalled()
    expect(attempt).not.toHaveBeenCalled()
    expect(deps.mailer.outbox).toEqual([])
    expect(await stored(userId)).toMatchObject({ email: TAKEN })
  })

  test('once added, the address cannot be changed by asking again', async () => {
    const session = await signIn('2244994945')
    await ask(session.accessToken)
    const code = emailedCode()
    expect((await confirm(session.accessToken, code)).status).toBe(200)
    // The same code again, and a new request: the account has its address.
    expect(await codeOf(await confirm(session.accessToken, code))).toBe('email.already_set')
    const again = await ask(session.accessToken, 'other@northline.app')
    expect(again.status).toBe(409)
    expect(await codeOf(again)).toBe('email.already_set')
    expect(await stored(session.userId)).toMatchObject({ email: ADDRESS })
    expect(added()).toHaveLength(1)
  })

  test('a banned user is refused', async () => {
    const session = await signIn('2244994945')
    await ask(session.accessToken)
    const code = emailedCode()
    await deps.users.setBanned(
      TEST_TENANT.environmentId,
      session.userId,
      deps.clock.now(),
      deps.clock.now(),
      Audit.none('fixture')
    )
    const self = { userId: session.userId }
    await expect(
      EmailAddress.request(deps, TEST_TENANT, self, { email: 'other@northline.app' })
    ).rejects.toMatchObject({ code: 'auth.user_banned' })
    await expect(EmailAddress.verify(deps, TEST_TENANT, self, { code })).rejects.toMatchObject({
      code: 'auth.user_banned',
    })
    expect(await stored(session.userId)).toMatchObject({ email: null })
  })

  test('a user of another environment, and one that is gone, is not found', async () => {
    const session = await signIn('2244994945')
    await ask(session.accessToken)
    const code = emailedCode()
    const self = { userId: session.userId }
    await expect(
      EmailAddress.request(deps, TENANT_B, self, { email: ADDRESS })
    ).rejects.toMatchObject({ status: 404 })
    await expect(EmailAddress.verify(deps, TENANT_B, self, { code })).rejects.toMatchObject({
      status: 404,
    })
    await deps.users.delete(TEST_TENANT.environmentId, session.userId, Audit.none('fixture'))
    await expect(EmailAddress.verify(deps, TEST_TENANT, self, { code })).rejects.toMatchObject({
      status: 404,
    })
  })
})

describe('the code', () => {
  test('a wrong one is refused and counted before it is looked at; the right one still works', async () => {
    const session = await signIn('2244994945')
    await ask(session.accessToken)
    const code = emailedCode()
    const attempt = spyOn(deps.lockout, 'attempt')
    const res = await confirm(session.accessToken, wrong(code))
    expect(res.status).toBe(422)
    expect(await codeOf(res)).toBe('verification.invalid_code')
    expect(attempt.mock.calls.map((call) => call[0])).toEqual([
      EmailAddress.codeLockKey(TEST_TENANT.environmentId, session.userId),
    ])
    expect(await stored(session.userId)).toMatchObject({ email: null })
    expect((await confirm(session.accessToken, code)).status).toBe(200)
  })

  test('with nothing pending there is nothing to guess at, and nothing is counted', async () => {
    const session = await signIn('2244994945')
    const attempt = spyOn(deps.lockout, 'attempt')
    const res = await confirm(session.accessToken, '123456')
    expect(res.status).toBe(410)
    expect(await codeOf(res)).toBe('verification.expired')
    expect(attempt).not.toHaveBeenCalled()
  })

  test('expires after ten minutes', async () => {
    const session = await signIn('2244994945')
    await ask(session.accessToken)
    const code = emailedCode()
    deps.clock.advance('10m')
    await expect(
      EmailAddress.verify(deps, TEST_TENANT, { userId: session.userId }, { code })
    ).rejects.toMatchObject({ code: 'verification.expired' })
    expect(await stored(session.userId)).toMatchObject({ email: null })
  })

  test('has five guesses: after them the right code is worth nothing', async () => {
    const session = await signIn('2244994945')
    await ask(session.accessToken)
    const code = emailedCode()
    const codes: string[] = []
    for (let guess = 0; guess < 5; guess += 1) {
      codes.push(await codeOf(await confirm(session.accessToken, wrong(code))))
    }
    expect(codes.slice(0, 4)).toEqual(Array(4).fill('verification.invalid_code'))
    const after = await confirm(session.accessToken, code)
    expect(after.status).not.toBe(200)
    expect(['verification.too_many_attempts', 'verification.expired', 'rate_limited']).toContain(
      await codeOf(after)
    )
    expect(await stored(session.userId)).toMatchObject({ email: null })
    expect(added()).toEqual([])
  })

  test('repeated wrong codes lock the user out, under a key of its own', async () => {
    const session = await signIn('2244994945')
    const self = { userId: session.userId }
    let locked: unknown
    // Each code has five guesses; a new code does not reset the user's own count.
    for (let round = 0; round < 3 && !locked; round += 1) {
      await EmailAddress.request(deps, TEST_TENANT, self, { email: ADDRESS })
      const code = emailedCode()
      for (let guess = 0; guess < 4 && !locked; guess += 1) {
        const error = await EmailAddress.verify(deps, TEST_TENANT, self, {
          code: wrong(code),
        }).catch((caught: unknown) => caught)
        if ((error as { code?: string }).code === 'rate_limited') {
          locked = error
        }
      }
      if (!locked) {
        deps.clock.advance('61s')
      }
    }
    expect(locked).toMatchObject({ code: 'rate_limited', status: 429 })
    // While locked out the right code is not looked at either.
    await expect(
      EmailAddress.verify(deps, TEST_TENANT, self, { code: emailedCode() })
    ).rejects.toMatchObject({ code: 'rate_limited' })
    expect(await stored(session.userId)).toMatchObject({ email: null })
  })

  test("another user's code proves nothing", async () => {
    const nelly = await signIn('2244994945')
    const omar = await signIn('1111111111')
    await ask(nelly.accessToken, 'nelly@northline.app')
    await ask(omar.accessToken, 'omar@northline.app')
    const omars = emailedCode()
    const res = await confirm(nelly.accessToken, omars)
    // Six digits can coincide; what must never happen is Omar's address on Nelly's account.
    if (res.status === 200) {
      expect(await stored(nelly.userId)).toMatchObject({ email: 'nelly@northline.app' })
    } else {
      expect(await codeOf(res)).toBe('verification.invalid_code')
      expect(await stored(nelly.userId)).toMatchObject({ email: null })
    }
    expect(await stored(omar.userId)).toMatchObject({ email: null })
  })

  test('a token of another purpose is not honoured here', async () => {
    const session = await signIn('2244994945')
    const self = { userId: session.userId }
    let code = ''
    for (const purpose of ['email_verification', 'password_reset', 'sign_in', 'step_up'] as const) {
      await Verification.issue(deps, TEST_TENANT, {
        purpose,
        destination: ADDRESS,
        userId: session.userId,
        deliver: async (delivery) => {
          code = delivery.code
        },
      })
      await expect(EmailAddress.verify(deps, TEST_TENANT, self, { code })).rejects.toMatchObject({
        code: 'verification.expired',
      })
      deps.clock.advance('61s')
    }
    expect(await stored(session.userId)).toMatchObject({ email: null })
  })

  test('is honoured for no other purpose', async () => {
    const session = await signIn('2244994945')
    const self = { userId: session.userId }
    await EmailAddress.request(deps, TEST_TENANT, self, { email: ADDRESS })
    const own = emailedCode()
    for (const purpose of ['email_verification', 'password_reset', 'sign_in', 'step_up'] as const) {
      await expect(
        Verification.verifyCode(deps, TEST_TENANT, { purpose, subject: self, code: own })
      ).rejects.toMatchObject({ code: 'verification.expired' })
    }
    // Untouched by those: it still does what it was issued for.
    expect((await EmailAddress.verify(deps, TEST_TENANT, self, { code: own })).email).toBe(ADDRESS)
  })

  test('is stored as a keyed hash that covers the user and the address', async () => {
    const session = await signIn('2244994945')
    await ask(session.accessToken)
    const code = emailedCode()
    const token = await pending(session.userId)
    expect(token).toMatchObject({ destination: ADDRESS, userId: session.userId })
    expect(JSON.stringify(token)).not.toContain(code)
    // The same code without the binding, as every other purpose would check it.
    await expect(
      Verification.verifyCode(deps, TEST_TENANT, {
        purpose: 'email_addition',
        subject: { userId: session.userId },
        code,
      })
    ).rejects.toMatchObject({ code: 'verification.invalid_code' })
  })
})

describe('an address another account has', () => {
  test('is answered like a free one, sent a notice with no code, and never confirmed', async () => {
    await account(TAKEN)
    const nelly = await signIn('2244994945')
    const omar = await signIn('1111111111')
    deps.mailer.outbox.length = 0
    const hit = spyOn(deps.rateLimiter, 'hit')

    const free = await ask(nelly.accessToken, 'free@northline.app')
    const freeKeys = hit.mock.calls.map((call) => [call[1], call[2]])
    hit.mockClear()
    const taken = await ask(omar.accessToken, TAKEN)
    const takenKeys = hit.mock.calls.map((call) => [call[1], call[2]])

    // The same status, headers that matter and shape; the same limiter rows in the same order.
    expect(taken.status).toBe(free.status)
    expect(taken.headers.get('cache-control')).toBe(free.headers.get('cache-control'))
    const [freeBody, takenBody] = [
      (await free.json()) as EmailCodeSent,
      (await taken.json()) as EmailCodeSent,
    ]
    expect(Object.keys(takenBody)).toEqual(Object.keys(freeBody))
    expect(takenBody.expiresAt).toBe(freeBody.expiresAt)
    expect(takenKeys).toEqual(freeKeys)
    expect(takenKeys.length).toBeGreaterThanOrEqual(3)
    // One email each, one token each.
    expect(deps.mailer.outbox.map((mail) => mail.to)).toEqual(['free@northline.app', TAKEN])
    expect(await pending(omar.userId)).toMatchObject({ destination: TAKEN })

    // The other account's owner is told, with no code and no link.
    const notice = deps.mailer.last()
    expect(notice.subject).not.toMatch(/\d{6}/)
    expect(notice.text).not.toMatch(/\d{6}/)
    expect(notice.text).not.toContain('http')

    // No code confirms it: not a guess, and not the digits the server drew for the token.
    for (let guess = 0; guess < 3; guess += 1) {
      const res = await confirm(omar.accessToken, `00000${guess}`)
      expect(res.status).toBe(422)
      expect(await codeOf(res)).toBe('verification.invalid_code')
    }
    expect(await stored(omar.userId)).toMatchObject({ email: null })
    expect(await deps.users.findByEmail(TEST_TENANT.environmentId, TAKEN)).not.toMatchObject({
      id: omar.userId,
    })
    expect(added()).toEqual([])
  })

  test("the digits drawn for a taken address's token do not confirm it", async () => {
    await account(TAKEN)
    const omar = await signIn('1111111111')
    const nelly = await signIn('2244994945')
    // The server draws 424242 for both tokens; only the free address's can be confirmed.
    const drawn = spyOn(Crypto, 'randomDigits').mockReturnValue('424242')
    await ask(omar.accessToken, TAKEN)
    await ask(nelly.accessToken, 'free@northline.app')
    drawn.mockRestore()
    const refused = await confirm(omar.accessToken, '424242')
    expect(refused.status).toBe(422)
    expect(await codeOf(refused)).toBe('verification.invalid_code')
    expect(await stored(omar.userId)).toMatchObject({ email: null })
    expect((await confirm(nelly.accessToken, '424242')).status).toBe(200)
  })

  test('taken between the code and its confirmation: nothing is stored, and the code is spent', async () => {
    const session = await signIn('2244994945')
    await ask(session.accessToken)
    const code = emailedCode()
    const other = await account(ADDRESS)
    const info = spyOn(logger, 'info')

    const res = await confirm(session.accessToken, code)
    expect(res.status).toBe(410)
    expect(await codeOf(res)).toBe('verification.expired')
    expect(await stored(session.userId)).toMatchObject({ email: null, emailVerifiedAt: null })
    expect(await deps.users.findByEmail(TEST_TENANT.environmentId, ADDRESS)).toMatchObject({
      id: other,
    })
    expect(added()).toEqual([])
    const identities = await deps.users.listIdentities(TEST_TENANT.environmentId, session.userId)
    expect(identities.map((identity) => identity.provider)).toEqual(['x'])
    // Said in the log by ids only.
    expect(JSON.stringify(info.mock.calls)).not.toContain('northline')
    // Spent: the same code again finds nothing pending.
    expect(await codeOf(await confirm(session.accessToken, code))).toBe('verification.expired')
    info.mockRestore()
  })

  test('an account with that address in another environment does not make it taken', async () => {
    await account(ADDRESS, TENANT_B.environmentId)
    const session = await signIn('2244994945')
    await ask(session.accessToken)
    expect((await confirm(session.accessToken, emailedCode())).status).toBe(200)
    expect(await stored(session.userId)).toMatchObject({ email: ADDRESS })
  })
})

describe('the send limits', () => {
  test('one code a minute and five an hour per user, under keys no other code uses', async () => {
    const session = await signIn('2244994945')
    const self = { userId: session.userId }
    const send = (email: string) =>
      EmailAddress.request(deps, TEST_TENANT, self, { email }).then(
        () => 'sent',
        (error: { code?: string }) => error.code
      )
    expect(await send('a1@northline.app')).toBe('sent')
    expect(await send('a2@northline.app')).toBe('rate_limited')
    for (const email of ['a3', 'a4', 'a5', 'a6']) {
      deps.clock.advance('61s')
      expect(await send(`${email}@northline.app`)).toBe('sent')
    }
    deps.clock.advance('61s')
    expect(await send('a7@northline.app')).toBe('rate_limited')
    // A refused request replaced nothing: the last address sent to is still the pending one.
    expect(await pending(session.userId)).toMatchObject({ destination: 'a6@northline.app' })
  })

  test('five an hour per address, whoever asks', async () => {
    const answers: number[] = []
    for (let asker = 0; asker < 6; asker += 1) {
      const session = await signIn(`22449949${asker}0`)
      answers.push((await ask(session.accessToken)).status)
    }
    expect(answers).toEqual([200, 200, 200, 200, 200, 429])
    expect(deps.mailer.outbox.filter((mail) => mail.to === ADDRESS)).toHaveLength(5)
  })

  // The accepted cost of a limit per address (ADR 0059): the address's budget is spent by
  // whoever names it, so its owner waits. It is a wait and nothing more: see the next test.
  test('one account can spend an address’s hour: its owner, adding it, is refused until the hour is over', async () => {
    const answers: number[] = []
    for (let request = 0; request < 5; request += 1) {
      // An access token lasts a minute and the user's own cooldown is a minute: the same
      // account signs in again for each request.
      const other = await signIn('2244994945')
      answers.push((await ask(other.accessToken)).status)
      deps.clock.advance('61s')
    }
    expect(answers).toEqual([200, 200, 200, 200, 200])
    const sent = () => deps.mailer.outbox.filter((mail) => mail.to === ADDRESS).length
    expect(sent()).toBe(5)

    const owner = await signIn('2244994946')
    const refused = await ask(owner.accessToken)
    expect(refused.status).toBe(429)
    expect(await codeOf(refused)).toBe('rate_limited')
    // Refused before anything was sent or stored for the owner.
    expect(sent()).toBe(5)
    expect(await pending(owner.userId)).toBeNull()

    // The window is the first request's hour: past it the owner is sent a code and adds it.
    deps.clock.advance('56m')
    const again = await signIn('2244994946')
    expect((await ask(again.accessToken)).status).toBe(200)
    expect((await confirm(again.accessToken, emailedCode())).status).toBe(200)
    expect((await stored(owner.userId))?.email).toBe(ADDRESS)
  })

  test('do not use up what a stranger may ask the address for', async () => {
    const session = await signIn('2244994945')
    await ask(session.accessToken)
    // The address's own budget of sign-in and reset codes is untouched: a code of another
    // purpose goes out to it in the same minute.
    let delivered = false
    await Verification.issue(deps, TEST_TENANT, {
      purpose: 'password_reset',
      destination: ADDRESS,
      userId: session.userId,
      deliver: async () => {
        delivered = true
      },
    })
    expect(delivered).toBe(true)
  })

  test('a limiter that cannot count sends nothing', async () => {
    const session = await signIn('2244994945')
    deps.mailer.outbox.length = 0
    const { ServiceUnavailableError } = await import('~/exceptions')
    const hit = spyOn(deps.rateLimiter, 'hit').mockRejectedValue(new ServiceUnavailableError())
    await expect(
      EmailAddress.request(deps, TEST_TENANT, { userId: session.userId }, { email: ADDRESS })
    ).rejects.toMatchObject({ status: 503 })
    hit.mockRestore()
    expect(deps.mailer.outbox).toEqual([])
    expect(await pending(session.userId)).toBeNull()
  })

  test('a relay that fails stores no token: an earlier code keeps working', async () => {
    const session = await signIn('2244994945')
    await ask(session.accessToken)
    const code = emailedCode()
    deps.clock.advance('61s')
    deps.mailer.failing = true
    const again = await signIn('2244994945')
    expect((await ask(again.accessToken, 'other@northline.app')).status).toBe(500)
    deps.mailer.failing = false
    expect((await confirm(again.accessToken, code)).status).toBe(200)
    expect(await stored(session.userId)).toMatchObject({ email: ADDRESS })
  })
})

describe('what is written down', () => {
  test('no address and no code in a log line, an audit entry or a limiter or lockout key', async () => {
    await account(TAKEN)
    const session = await signIn('2244994945')
    const lines = [
      spyOn(logger, 'info'),
      spyOn(logger, 'warn'),
      spyOn(logger, 'error'),
      spyOn(logger, 'debug'),
    ]
    const hit = spyOn(deps.rateLimiter, 'hit')
    const attempt = spyOn(deps.lockout, 'attempt')
    await ask(session.accessToken, TAKEN)
    await confirm(session.accessToken, '000000')
    deps.clock.advance('61s')
    const again = await signIn('2244994945')
    await ask(again.accessToken)
    const code = emailedCode()
    await confirm(again.accessToken, wrong(code))
    expect((await confirm(again.accessToken, code)).status).toBe(200)
    await Notices.settled()

    const written = JSON.stringify([
      lines.map((line) => line.mock.calls),
      hit.mock.calls.map((call) => call[0]),
      attempt.mock.calls.map((call) => call[0]),
      deps.activityLog.entries,
    ])
    for (const secret of ['northline', 'nelly', 'maya', code]) {
      expect(written).not.toContain(secret)
    }
    for (const line of lines) {
      line.mockRestore()
    }
  })

  test('the actor of the entry is the user, with where the request came from', async () => {
    const session = await signIn('2244994945')
    await ask(session.accessToken)
    await EmailAddress.verify(
      deps,
      TEST_TENANT,
      { userId: session.userId },
      { code: emailedCode() },
      { ipAddress: TEST_ACTOR.ipAddress }
    )
    expect(added()[0]?.actor).toMatchObject({ type: 'user', id: session.userId })
    expect(JSON.stringify(added()[0])).toContain(TEST_ACTOR.ipAddress as string)
  })
})
