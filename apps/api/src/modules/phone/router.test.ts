import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  type ClientConfig,
  type CurrentUser,
  DEFAULT_ENVIRONMENT_SETTINGS,
  type EnvironmentSettings,
  type FlowAttempt,
  type PhoneCodeSent,
  type HybridSessionTokens as SessionTokens,
  type User,
} from '@tula/contract'
import { createApp } from '~/index'
import { sha256Hex } from '~/lib/crypto'
import * as logger from '~/lib/logger'
import * as Notices from '~/modules/notice/service'
import * as Phone from '~/modules/phone/service'
import { createTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'

const PK = 'tula_pk_dev_publishable0000000000000000000'
const SK = 'tula_sk_dev_secret000000000000000000000000'
const PK_B = 'tula_pk_dev_publishableb000000000000000000'
const TENANT_B = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.productionEnvironmentId,
}
const EMAIL = 'maya@northline.app'
const OTHER_EMAIL = 'sam@northline.app'
const PASSWORD = 'correct horse battery staple'
const ORIGIN = 'https://app.northline.test'
const NUMBER = '+14155550142'
const GERMAN = '+4915112345678'

let deps: TestDeps
let app: ReturnType<typeof createApp>
let revision = 0

function configure(
  sms: EnvironmentSettings['sms'] = { enabled: true, allowedCountries: ['US', 'DE'] },
  environmentId: string = TEST_TENANT.environmentId
) {
  revision += 1
  deps.environmentSettings.seed(environmentId, {
    revision,
    settings: {
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      signIn: {
        methods: {
          password: { enabled: true },
          emailCode: { enabled: true },
          emailLink: { enabled: false },
          passkey: { enabled: false },
        },
      },
      urls: { allowedOrigins: [ORIGIN], allowedRedirectUrls: [] },
      sms,
    },
  })
}

beforeEach(async () => {
  deps = createTestDeps()
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
  configure()
  configure(undefined, TENANT_B.environmentId)
  app = createApp(deps)
})

interface CallOptions {
  token?: string
  key?: string | null
  secret?: string
}

async function call(method: string, path: string, body?: unknown, options: CallOptions = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-tula-client': 'ios',
    origin: ORIGIN,
  }
  if (options.key !== null) {
    headers['x-tula-publishable-key'] = options.key ?? PK
  }
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`
  }
  if (options.secret) {
    headers['x-tula-attempt'] = options.secret
  }
  return app.request(`/v1/client${path}`, {
    method,
    headers,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
}

const post = (path: string, body: unknown = {}, options: CallOptions = {}) =>
  call('POST', path, body, options)
const json = async <T>(res: Response) => (await res.json()) as T
const errorOf = async (res: Response) =>
  json<{ status: number; code: string; detail?: string; params?: Record<string, unknown> }>(res)
const codeOf = async (res: Response) => (await errorOf(res)).code
const emailedCode = () =>
  /^(\d{6}) /.exec(
    deps.mailer.outbox.findLast((mail) => /^\d{6} /.test(mail.subject))?.subject ?? ''
  )?.[1] ?? ''
/** The code in the newest text message to a number: the digits after `code is`. */
const textedCode = (to: string = NUMBER) =>
  /code is (\d{6})\./.exec(deps.sms.messages(to).at(-1)?.text ?? '')?.[1] ?? ''
/** A six-digit code that is not the one given. */
const wrong = (code: string) => (code === '000000' ? '000001' : '000000')
const auditTypes = async (environmentId: string = TEST_TENANT.environmentId) =>
  (await deps.activityLog.listAudit(environmentId, { page: 1, size: 200 })).entries.map(
    (entry) => entry.type
  )
const me = async (token: string) =>
  json<CurrentUser>(await call('GET', '/me', undefined, { token }))
const latestToken = async (userId: string) =>
  deps.verificationTokens.findLatest(TEST_TENANT.environmentId, 'phone_verification', { userId })

async function signUp(
  email = EMAIL,
  key: string = PK
): Promise<SessionTokens & { userId: string }> {
  const started = await json<FlowAttempt>(
    await post('/sign-ups', { email, password: PASSWORD }, { key })
  )
  const done = await json<FlowAttempt>(
    await post(
      `/sign-ups/${started.id}/verify-email`,
      { code: emailedCode() },
      { key, secret: started.attemptSecret }
    )
  )
  const session = done.session as SessionTokens
  const user = await json<CurrentUser>(
    await call('GET', '/me', undefined, { token: session.accessToken, key })
  )
  return { ...session, userId: user.id }
}

/** Ask for a code and return the answer; the caller reads the code with `textedCode`. */
const ask = (token: string, phoneNumber: string = NUMBER, options: CallOptions = {}) =>
  post('/me/phone', { phoneNumber }, { token, ...options })
const confirm = (token: string, code: string, options: CallOptions = {}) =>
  post('/me/phone/verify', { code }, { token, ...options })

describe('adding a phone number', () => {
  test('a code is texted to the number, and the right code makes it the account’s', async () => {
    const session = await signUp()
    const asked = await ask(session.accessToken, '+1 (415) 555-0142')
    expect(asked.status).toBe(200)
    expect(asked.headers.get('cache-control')).toBe('no-store')
    const expiresAt = new Date(deps.clock.now().getTime() + 10 * 60_000).toISOString()
    expect(await json<PhoneCodeSent>(asked)).toEqual({ destination: '***42', expiresAt })

    // One message, to the number in E.164 form, in the documented words.
    expect(deps.sms.outbox).toHaveLength(1)
    const code = textedCode()
    expect(code).toMatch(/^\d{6}$/)
    expect(deps.sms.last()).toEqual({
      to: NUMBER,
      text: `Your Tula verification code is ${code}.\n\n@app.northline.test #${code}`,
      sentAt: deps.clock.now(),
    })

    // Pending is not the account's number.
    expect(await me(session.accessToken)).toMatchObject({
      phoneNumber: null,
      phoneNumberVerifiedAt: null,
    })
    expect(await auditTypes()).not.toContain('user.phone_number_added')

    const confirmed = await confirm(session.accessToken, code)
    expect(confirmed.status).toBe(200)
    expect(confirmed.headers.get('cache-control')).toBe('no-store')
    const verifiedAt = deps.clock.now().toISOString()
    expect(await json<CurrentUser>(confirmed)).toMatchObject({
      id: session.userId,
      phoneNumber: NUMBER,
      phoneNumberVerifiedAt: verifiedAt,
      hasPassword: true,
    })
    expect(await me(session.accessToken)).toMatchObject({
      phoneNumber: NUMBER,
      phoneNumberVerifiedAt: verifiedAt,
    })
    expect((await auditTypes()).filter((type) => type.startsWith('user.phone'))).toEqual([
      'user.phone_number_added',
    ])
  })

  test('the audit entry names the user and holds nothing of the number', async () => {
    const session = await signUp()
    await ask(session.accessToken)
    await confirm(session.accessToken, textedCode())
    const { entries } = await deps.activityLog.listAudit(TEST_TENANT.environmentId, {
      action: 'user.phone_number_added',
      page: 1,
      size: 10,
    })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      type: 'user.phone_number_added',
      actor: { type: 'user', id: session.userId },
      target: { type: 'user', id: session.userId },
    })
    expect(entries[0]?.data).toEqual({})
    const event = deps.activityLog.events.find((e) => e.type === 'user.phone_number_added')
    expect(event?.data).toEqual({})
  })

  test('the code is stored as a keyed hash, with the number as the pending number', async () => {
    const session = await signUp()
    await ask(session.accessToken)
    const code = textedCode()
    const token = await latestToken(session.userId)
    expect(token).toMatchObject({
      purpose: 'phone_verification',
      userId: session.userId,
      flowAttemptId: null,
      destination: NUMBER,
      linkTokenHash: null,
      attempts: 0,
      maxAttempts: 5,
      consumedAt: null,
    })
    expect(token?.codeHash).toMatch(/^[0-9a-f]{64}$/)
    // Not the code, and not a plain hash of it or of anything an attacker can build.
    for (const guess of [
      code,
      `${token?.id}:${code}`,
      `${token?.id}:${session.userId}:${NUMBER}:${code}`,
    ]) {
      expect(token?.codeHash).not.toBe(guess)
      expect(token?.codeHash).not.toBe(sha256Hex(guess))
    }
    // The key matters: the same input under the test key is what is stored.
    expect(token?.codeHash).toBe(
      await deps.keyedHash.hmac(
        'verification-codes',
        `${token?.id}:${session.userId}:${NUMBER}:${code}`
      )
    )
  })

  test('a second number replaces the first only once it is confirmed', async () => {
    const session = await signUp()
    await ask(session.accessToken)
    await confirm(session.accessToken, textedCode())
    deps.clock.advance('1m')
    const fresh = await json<SessionTokens>(
      await post('/sessions/refresh', { refreshToken: session.refreshToken })
    )
    expect((await ask(fresh.accessToken, GERMAN)).status).toBe(200)
    expect((await me(fresh.accessToken)).phoneNumber).toBe(NUMBER)
    expect((await confirm(fresh.accessToken, textedCode(GERMAN))).status).toBe(200)
    expect(await me(fresh.accessToken)).toMatchObject({
      phoneNumber: GERMAN,
      phoneNumberVerifiedAt: deps.clock.now().toISOString(),
    })
  })

  test('two accounts may hold the same number', async () => {
    const maya = await signUp()
    const sam = await signUp(OTHER_EMAIL)
    await ask(maya.accessToken)
    await confirm(maya.accessToken, textedCode())
    deps.clock.advance('1m')
    const fresh = await json<SessionTokens>(
      await post('/sessions/refresh', { refreshToken: sam.refreshToken })
    )
    expect((await ask(fresh.accessToken)).status).toBe(200)
    expect((await confirm(fresh.accessToken, textedCode())).status).toBe(200)
    expect((await me(fresh.accessToken)).phoneNumber).toBe(NUMBER)
  })

  test.each([
    ['no country code', '0171 5550100'],
    ['no plus', '14155550142'],
    ['too short', '+1234567'],
    ['too long', '+1234567890123456'],
    ['letters', '+1415555CALL'],
    ['an extension', '+14155550142;ext=1'],
    ['empty', ''],
  ])('a number with %s is phone.invalid, and nothing is sent or counted', async (_name, input) => {
    const session = await signUp()
    const hit = spyOn(deps.rateLimiter, 'hit')
    const before = hit.mock.calls.length
    const res = await ask(session.accessToken, input)
    expect(await errorOf(res)).toMatchObject({ status: 422, code: 'phone.invalid' })
    expect(deps.sms.outbox).toEqual([])
    expect(await latestToken(session.userId)).toBeNull()
    // Only the route's own per-IP limit and the client ceiling counted: no send limit.
    const keys = hit.mock.calls.slice(before).map(([key]) => key)
    expect(keys.filter((key) => key.startsWith('phone_code') && !key.includes('request'))).toEqual(
      []
    )
  })

  test('a body without a number, or with one that is not a string, is a validation error', async () => {
    const session = await signUp()
    for (const body of [{}, { phoneNumber: 14155550142 }, { phoneNumber: 'x'.repeat(65) }]) {
      const res = await post('/me/phone', body, { token: session.accessToken })
      expect(res.status).toBe(422)
    }
    for (const body of [
      {},
      { code: 123456 },
      { code: '12345' },
      { code: '1234567' },
      { code: 'abcdef' },
    ]) {
      const res = await post('/me/phone/verify', body, { token: session.accessToken })
      expect(res.status).toBe(422)
    }
    expect(deps.sms.outbox).toEqual([])
  })
})

describe('what the environment allows', () => {
  test.each([
    ['off (the default)', DEFAULT_ENVIRONMENT_SETTINGS.sms, 403, 'sms.disabled'],
    [
      'off with countries listed',
      { enabled: false, allowedCountries: ['US'] },
      403,
      'sms.disabled',
    ],
    ['on with no country', { enabled: true, allowedCountries: [] }, 403, 'sms.disabled'],
    [
      'on for another country',
      { enabled: true, allowedCountries: ['DE'] },
      422,
      'sms.country_not_allowed',
    ],
  ] as const)('SMS %s: nothing is sent, stored or counted', async (_name, sms, status, code) => {
    const session = await signUp()
    configure({ enabled: sms.enabled, allowedCountries: [...sms.allowedCountries] })
    const hit = spyOn(deps.rateLimiter, 'hit')
    const before = hit.mock.calls.length
    expect(await errorOf(await ask(session.accessToken))).toMatchObject({ status, code })
    expect(deps.sms.outbox).toEqual([])
    expect(await latestToken(session.userId)).toBeNull()
    expect(
      hit.mock.calls
        .slice(before)
        .map(([key]) => key)
        .filter((key) => /^phone_code(_number)?(_cooldown)?:/.test(key))
    ).toEqual([])
    // So a refusal did not start the cooldown: allowed, the very next request sends.
    configure()
    expect((await ask(session.accessToken)).status).toBe(200)
  })

  test('the longest prefix decides: a Bahamian number is not let through by US', async () => {
    const session = await signUp()
    expect(await codeOf(await ask(session.accessToken, '+12425550100'))).toBe(
      'sms.country_not_allowed'
    )
    expect(deps.sms.outbox).toEqual([])
  })

  test('a calling code no country has is not allowed by any list', async () => {
    const session = await signUp()
    expect(await codeOf(await ask(session.accessToken, '+99912345678'))).toBe(
      'sms.country_not_allowed'
    )
  })

  test('with SMS off, confirming says so even when nothing is pending', async () => {
    const session = await signUp()
    configure({ enabled: false, allowedCountries: ['US'] })
    expect(await errorOf(await confirm(session.accessToken, '123456'))).toMatchObject({
      status: 403,
      code: 'sms.disabled',
    })
  })

  test('SMS switched off between asking and confirming: refused, and nothing is used up', async () => {
    const session = await signUp()
    await ask(session.accessToken)
    const code = textedCode()
    configure({ enabled: false, allowedCountries: ['US'] })
    const attempt = spyOn(deps.lockout, 'attempt')
    expect(await errorOf(await confirm(session.accessToken, code))).toMatchObject({
      status: 403,
      code: 'sms.disabled',
    })
    expect(attempt).not.toHaveBeenCalled()
    expect((await latestToken(session.userId))?.attempts).toBe(0)
    expect((await me(session.accessToken)).phoneNumber).toBeNull()
    // Back on: the same code still works.
    configure()
    expect((await confirm(session.accessToken, code)).status).toBe(200)
  })

  test('the country removed between asking and confirming: refused, and nothing is used up', async () => {
    const session = await signUp()
    await ask(session.accessToken)
    const code = textedCode()
    configure({ enabled: true, allowedCountries: ['DE'] })
    const attempt = spyOn(deps.lockout, 'attempt')
    expect(await errorOf(await confirm(session.accessToken, code))).toMatchObject({
      status: 422,
      code: 'sms.country_not_allowed',
    })
    expect(attempt).not.toHaveBeenCalled()
    expect((await latestToken(session.userId))?.attempts).toBe(0)
    expect((await me(session.accessToken)).phoneNumber).toBeNull()
    configure()
    expect((await confirm(session.accessToken, code)).status).toBe(200)
  })

  test('the client config says whether a number can be added, and not which countries', async () => {
    const config = async () => json<ClientConfig>(await call('GET', '/config'))
    expect((await config()).phone).toEqual({ enabled: true })
    expect(JSON.stringify(await config())).not.toContain('allowedCountries')
    configure({ enabled: true, allowedCountries: [] })
    expect((await config()).phone).toEqual({ enabled: false })
    configure({ enabled: false, allowedCountries: ['US'] })
    expect((await config()).phone).toEqual({ enabled: false })
  })
})

describe('a code that does not confirm', () => {
  test('a wrong code is counted before it is looked at, and the right one still works', async () => {
    const session = await signUp()
    await ask(session.accessToken)
    const code = textedCode()
    const attempt = spyOn(deps.lockout, 'attempt')
    const clear = spyOn(deps.lockout, 'clear')
    const key = Phone.codeLockKey(TEST_TENANT.environmentId, session.userId)
    expect(key).toBe(`phone_code:${TEST_TENANT.environmentId}:${session.userId}`)

    const res = await confirm(session.accessToken, wrong(code))
    expect(await errorOf(res)).toMatchObject({
      status: 422,
      code: 'verification.invalid_code',
      params: { attemptsRemaining: 4 },
    })
    expect(attempt.mock.calls.map(([k]) => k)).toEqual([key])
    expect(clear).not.toHaveBeenCalled()
    expect((await latestToken(session.userId))?.attempts).toBe(1)
    expect((await me(session.accessToken)).phoneNumber).toBeNull()

    expect((await confirm(session.accessToken, code)).status).toBe(200)
    expect(clear.mock.calls.map(([k]) => k)).toEqual([key])
  })

  test('the guess is counted even when the lockout would be the only thing to stop it', async () => {
    const session = await signUp()
    await ask(session.accessToken)
    const order: string[] = []
    const attempt = deps.lockout.attempt.bind(deps.lockout)
    spyOn(deps.lockout, 'attempt').mockImplementation(async (...args) => {
      order.push('lockout')
      return attempt(...args)
    })
    const record = deps.verificationTokens.recordAttempt.bind(deps.verificationTokens)
    spyOn(deps.verificationTokens, 'recordAttempt').mockImplementation(async (...args) => {
      order.push('token')
      return record(...args)
    })
    await confirm(session.accessToken, wrong(textedCode()))
    expect(order).toEqual(['lockout', 'token'])
  })

  test('five wrong guesses use the code up: the right one is then refused', async () => {
    const session = await signUp()
    await ask(session.accessToken)
    const code = textedCode()
    for (let n = 0; n < 5; n += 1) {
      expect(await codeOf(await confirm(session.accessToken, wrong(code)))).toBe(
        'verification.invalid_code'
      )
    }
    expect(await errorOf(await confirm(session.accessToken, code))).toMatchObject({
      status: 429,
      code: 'verification.too_many_attempts',
    })
    expect((await me(session.accessToken)).phoneNumber).toBeNull()
  })

  test('past the lockout’s free guesses the user waits, and the wait spends no guess of the code', async () => {
    const session = await signUp()
    await ask(session.accessToken)
    // Six counted guesses: five free, the sixth imposes the first wait.
    for (let n = 0; n < 6; n += 1) {
      await confirm(session.accessToken, wrong(textedCode()))
    }
    const attemptsBefore = (await latestToken(session.userId))?.attempts
    const res = await confirm(session.accessToken, textedCode())
    expect(await errorOf(res)).toMatchObject({ status: 429, code: 'rate_limited' })
    expect((await latestToken(session.userId))?.attempts).toBe(attemptsBefore)
    expect((await me(session.accessToken)).phoneNumber).toBeNull()
  })

  test('an expired code is refused, one millisecond before it still works', async () => {
    const session = await signUp()
    await ask(session.accessToken)
    const code = textedCode()
    // The access token lives a minute: check the code at the service, on the clock alone.
    const scope = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }
    deps.clock.advance(10 * 60_000)
    await expect(
      Phone.verify(deps, scope, { userId: session.userId }, { code })
    ).rejects.toMatchObject({ code: 'verification.expired' })
    deps.clock.advance(-1)
    expect(
      (await Phone.verify(deps, scope, { userId: session.userId }, { code })).phoneNumber
    ).toBe(NUMBER)
  })

  test('a code works once', async () => {
    const session = await signUp()
    await ask(session.accessToken)
    const code = textedCode()
    expect((await confirm(session.accessToken, code)).status).toBe(200)
    expect(await errorOf(await confirm(session.accessToken, code))).toMatchObject({
      status: 410,
      code: 'verification.expired',
    })
    expect((await auditTypes()).filter((type) => type === 'user.phone_number_added')).toHaveLength(
      1
    )
  })

  test('with nothing pending there is nothing to guess at: expired, and not counted', async () => {
    const session = await signUp()
    const attempt = spyOn(deps.lockout, 'attempt')
    expect(await errorOf(await confirm(session.accessToken, '123456'))).toMatchObject({
      status: 410,
      code: 'verification.expired',
    })
    expect(attempt).not.toHaveBeenCalled()
  })

  test('an earlier code does not confirm the number asked for after it', async () => {
    const session = await signUp()
    await ask(session.accessToken)
    const first = textedCode()
    deps.clock.advance('1m')
    const fresh = await json<SessionTokens>(
      await post('/sessions/refresh', { refreshToken: session.refreshToken })
    )
    expect((await ask(fresh.accessToken, GERMAN)).status).toBe(200)
    const second = textedCode(GERMAN)
    if (first !== second) {
      expect(await codeOf(await confirm(fresh.accessToken, first))).toBe(
        'verification.invalid_code'
      )
    }
    expect((await me(fresh.accessToken)).phoneNumber).toBeNull()
    // And the number that is confirmed is the one the newest code was sent to.
    expect((await json<CurrentUser>(await confirm(fresh.accessToken, second))).phoneNumber).toBe(
      GERMAN
    )
  })

  test('another user’s code confirms nothing for me', async () => {
    const maya = await signUp()
    const sam = await signUp(OTHER_EMAIL)
    await ask(sam.accessToken)
    const samsCode = textedCode()
    // Maya has nothing pending.
    expect(await codeOf(await confirm(maya.accessToken, samsCode))).toBe('verification.expired')
    // And with a number of her own pending, Sam's code is just a wrong guess.
    await ask(maya.accessToken, GERMAN)
    const mayasCode = textedCode(GERMAN)
    if (mayasCode !== samsCode) {
      expect(await codeOf(await confirm(maya.accessToken, samsCode))).toBe(
        'verification.invalid_code'
      )
    }
    expect((await me(maya.accessToken)).phoneNumber).toBeNull()
    // Sam's own code is untouched by all of it.
    expect((await json<CurrentUser>(await confirm(sam.accessToken, samsCode))).phoneNumber).toBe(
      NUMBER
    )
  })

  test('a stored row whose number was changed no longer confirms: the hash covers the number', async () => {
    const maya = await signUp()
    await ask(maya.accessToken)
    const code = textedCode()
    // What the store hands back says another number, as a rewritten row would.
    const findLatest = deps.verificationTokens.findLatest.bind(deps.verificationTokens)
    spyOn(deps.verificationTokens, 'findLatest').mockImplementation(async (...args) => {
      const token = await findLatest(...args)
      return token && { ...token, destination: GERMAN }
    })
    const recordAttempt = deps.verificationTokens.recordAttempt.bind(deps.verificationTokens)
    spyOn(deps.verificationTokens, 'recordAttempt').mockImplementation(async (...args) => {
      const token = await recordAttempt(...args)
      return token && { ...token, destination: GERMAN }
    })
    expect(await codeOf(await confirm(maya.accessToken, code))).toBe('verification.invalid_code')
    expect((await me(maya.accessToken)).phoneNumber).toBeNull()
  })

  test('a stored row moved to another user no longer confirms: the hash covers the user', async () => {
    const maya = await signUp()
    const sam = await signUp(OTHER_EMAIL)
    await ask(maya.accessToken)
    const code = textedCode()
    // Sam's lookups find Maya's token, as if its `user_id` had been rewritten to his.
    const findLatest = deps.verificationTokens.findLatest.bind(deps.verificationTokens)
    spyOn(deps.verificationTokens, 'findLatest').mockImplementation(
      async (environmentId, purpose, subject) => {
        const moved = 'userId' in subject && subject.userId === sam.userId
        const token = await findLatest(
          environmentId,
          purpose,
          moved ? { userId: maya.userId } : subject
        )
        return token && moved ? { ...token, userId: sam.userId } : token
      }
    )
    expect(await codeOf(await confirm(sam.accessToken, code))).toBe('verification.invalid_code')
    expect((await me(sam.accessToken)).phoneNumber).toBeNull()
  })

  test('a code of another purpose confirms no number, and a phone code steps nothing up', async () => {
    const session = await signUp()
    // A step-up code by email, for the same user.
    expect(
      (
        await post(
          '/sessions/step-up/email-code',
          { method: 'email_code' },
          { token: session.accessToken }
        )
      ).status
    ).toBe(200)
    const stepUpCode = emailedCode()
    // Nothing of purpose `phone_verification` is pending: the step-up code finds no token.
    expect(await codeOf(await confirm(session.accessToken, stepUpCode))).toBe(
      'verification.expired'
    )
    // With a phone code pending it is a wrong guess (unless the two happen to be equal).
    await ask(session.accessToken)
    const phoneCode = textedCode()
    if (phoneCode !== stepUpCode) {
      expect(await codeOf(await confirm(session.accessToken, stepUpCode))).toBe(
        'verification.invalid_code'
      )
      // The other way round: the texted code is not a step-up code.
      expect(
        await codeOf(
          await post(
            '/sessions/step-up',
            { method: 'email_code', code: phoneCode },
            { token: session.accessToken }
          )
        )
      ).toBe('verification.invalid_code')
    }
    expect((await me(session.accessToken)).phoneNumber).toBeNull()
  })

  test('another environment’s key and session confirm nothing here', async () => {
    const here = await signUp()
    await ask(here.accessToken)
    const code = textedCode()
    const there = await signUp(EMAIL, PK_B)
    // Their session, their key: nothing pending for that user in that environment.
    expect(await codeOf(await confirm(there.accessToken, code, { key: PK_B }))).toBe(
      'verification.expired'
    )
    // Our session with their key is no session at all.
    expect((await confirm(here.accessToken, code, { key: PK_B })).status).toBe(401)
    expect(await auditTypes(TENANT_B.environmentId)).not.toContain('user.phone_number_added')
  })
})

describe('sending', () => {
  test('a second code within a minute is refused, and the first keeps working', async () => {
    const session = await signUp()
    await ask(session.accessToken)
    const code = textedCode()
    const res = await ask(session.accessToken)
    expect(await errorOf(res)).toMatchObject({ status: 429, code: 'rate_limited' })
    expect(deps.sms.outbox).toHaveLength(1)
    expect((await confirm(session.accessToken, code)).status).toBe(200)
  })

  test('a number is limited whoever asks: a second account within the minute is refused', async () => {
    const maya = await signUp()
    const sam = await signUp(OTHER_EMAIL)
    expect((await ask(maya.accessToken)).status).toBe(200)
    expect(await codeOf(await ask(sam.accessToken))).toBe('rate_limited')
    // The refused send still used Sam's own minute (a user's limits are counted first).
    expect(await codeOf(await ask(sam.accessToken, GERMAN))).toBe('rate_limited')
    // Another user and another number are not affected.
    const kim = await signUp('kim@northline.app')
    expect((await ask(kim.accessToken, GERMAN)).status).toBe(200)
    expect(deps.sms.outbox.map((message) => message.to)).toEqual([NUMBER, GERMAN])
  })

  test('no limiter or lockout key holds the number', async () => {
    const session = await signUp()
    const hit = spyOn(deps.rateLimiter, 'hit')
    const attempt = spyOn(deps.lockout, 'attempt')
    await ask(session.accessToken)
    await confirm(session.accessToken, wrong(textedCode()))
    const keys = [...hit.mock.calls.map(([key]) => key), ...attempt.mock.calls.map(([key]) => key)]
    expect(keys.some((key) => key.startsWith('phone_code_number:'))).toBe(true)
    for (const key of keys) {
      expect(key).not.toContain('4155550142')
      expect(key).not.toContain(sha256Hex(NUMBER))
    }
  })

  test('a limiter that cannot count refuses the send: nothing is texted or stored', async () => {
    const session = await signUp()
    const hit = deps.rateLimiter.hit.bind(deps.rateLimiter)
    const { ServiceUnavailableError } = await import('~/exceptions')
    for (const failing of ['phone_code_cooldown:', 'phone_code_number_cooldown:']) {
      const spy = spyOn(deps.rateLimiter, 'hit').mockImplementation(async (key, ...rest) => {
        if (key.startsWith(failing)) {
          throw new ServiceUnavailableError()
        }
        return hit(key, ...rest)
      })
      expect(await errorOf(await ask(session.accessToken, GERMAN))).toMatchObject({
        status: 503,
        code: 'service.unavailable',
      })
      spy.mockRestore()
    }
    expect(deps.sms.outbox).toEqual([])
    expect(await latestToken(session.userId)).toBeNull()
  })

  test('a lockout that cannot count refuses the guess: the code is not looked at', async () => {
    const session = await signUp()
    await ask(session.accessToken)
    const { ServiceUnavailableError } = await import('~/exceptions')
    const spy = spyOn(deps.lockout, 'attempt').mockRejectedValue(new ServiceUnavailableError())
    expect(await errorOf(await confirm(session.accessToken, textedCode()))).toMatchObject({
      status: 503,
      code: 'service.unavailable',
    })
    spy.mockRestore()
    expect((await latestToken(session.userId))?.attempts).toBe(0)
    expect((await me(session.accessToken)).phoneNumber).toBeNull()
  })

  test('a message the sender does not take is sms.unavailable, and an earlier code keeps working', async () => {
    const session = await signUp()
    await ask(session.accessToken)
    const code = textedCode()
    deps.clock.advance('1m')
    const fresh = await json<SessionTokens>(
      await post('/sessions/refresh', { refreshToken: session.refreshToken })
    )
    deps.sms.failing = true
    const warn = spyOn(logger, 'warn')
    const res = await ask(fresh.accessToken, GERMAN)
    expect(await errorOf(res)).toEqual({
      status: 503,
      code: 'sms.unavailable',
      detail: 'The text message could not be sent. Try again later.',
    })
    // One line for the operator, with the fixed word and no number.
    expect(warn.mock.calls).toEqual([
      ['text message not sent', { environmentId: TEST_TENANT.environmentId, reason: 'failed' }],
    ])
    warn.mockRestore()
    expect(deps.sms.outbox).toHaveLength(1)
    // The pending number is still the first one, and its code still confirms it.
    expect((await latestToken(session.userId))?.destination).toBe(NUMBER)
    expect((await json<CurrentUser>(await confirm(fresh.accessToken, code))).phoneNumber).toBe(
      NUMBER
    )
  })

  // Review finding: with no sender every try was a 503 that still used the user's and the
  // number's send limits, so the first minute after a sender was configured was refused too.
  test('with no sender, asking is refused before any send limit is counted', async () => {
    const session = await signUp()
    deps.sms.configured = false
    const hit = spyOn(deps.rateLimiter, 'hit')
    expect(await errorOf(await ask(session.accessToken))).toEqual({
      status: 503,
      code: 'sms.unavailable',
      detail: 'The text message could not be sent. Try again later.',
    })
    // The route's own per-IP limit is counted, as for every request; no send limit is.
    expect(
      hit.mock.calls.map(([key]) => key).filter((key) => key.startsWith('phone_code'))
    ).toEqual(['phone_code_request:ip:unknown'])
    hit.mockRestore()
    expect(await latestToken(session.userId)).toBeNull()
    // What the environment refuses is still said first: it is the more useful answer.
    expect(await codeOf(await ask(session.accessToken, '+33123456789'))).toBe(
      'sms.country_not_allowed'
    )
    // Nothing was spent: the same user, the same number, at once.
    deps.sms.configured = true
    expect((await ask(session.accessToken)).status).toBe(200)
    expect(deps.sms.outbox).toHaveLength(1)
  })

  test('a deployment with no sender answers sms.unavailable and writes the message nowhere', async () => {
    const { unconfiguredSmsSender } = await import('~/adapters/sms/unconfigured')
    const unconfigured = createTestDeps()
    Object.assign(unconfigured, { sms: unconfiguredSmsSender })
    const levels = (['debug', 'info', 'warn', 'error'] as const).map((level) =>
      spyOn(logger, level)
    )
    try {
      await expect(
        Phone.request(
          unconfigured,
          { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId },
          { userId: 'user' },
          { phoneNumber: NUMBER }
        )
      ).rejects.toMatchObject({ code: 'sms.disabled' })
      unconfigured.environmentSettings.seed(TEST_TENANT.environmentId, {
        revision: 1,
        settings: {
          ...DEFAULT_ENVIRONMENT_SETTINGS,
          sms: { enabled: true, allowedCountries: ['US'] },
        },
      })
      await expect(
        Phone.request(
          unconfigured,
          { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId },
          { userId: 'user' },
          { phoneNumber: NUMBER }
        )
      ).rejects.toMatchObject({ code: 'sms.unavailable', status: 503 })
      // One line, and all of it: the fixed word, the environment, nothing of the message.
      expect(levels.flatMap((spy) => spy.mock.calls)).toEqual([
        [
          'text message not sent',
          { environmentId: TEST_TENANT.environmentId, reason: 'not_configured' },
        ],
      ])
    } finally {
      for (const spy of levels) {
        spy.mockRestore()
      }
    }
  })
})

describe('removing a phone number', () => {
  test('takes it off the account, once, and records it once', async () => {
    const session = await signUp()
    await ask(session.accessToken)
    await confirm(session.accessToken, textedCode())
    const res = await call('DELETE', '/me/phone', undefined, { token: session.accessToken })
    expect(res.status).toBe(204)
    expect(await me(session.accessToken)).toMatchObject({
      phoneNumber: null,
      phoneNumberVerifiedAt: null,
    })
    // Nothing left to remove: still a success, and nothing more is recorded.
    expect(
      (await call('DELETE', '/me/phone', undefined, { token: session.accessToken })).status
    ).toBe(204)
    expect((await auditTypes()).filter((type) => type.startsWith('user.phone'))).toEqual([
      'user.phone_number_removed',
      'user.phone_number_added',
    ])
    const event = deps.activityLog.events.find((e) => e.type === 'user.phone_number_removed')
    expect(event).toMatchObject({
      actor: { type: 'user', id: session.userId },
      target: { type: 'user', id: session.userId },
      data: {},
    })
  })

  test('does not touch a number that is only pending', async () => {
    const session = await signUp()
    await ask(session.accessToken)
    const code = textedCode()
    await call('DELETE', '/me/phone', undefined, { token: session.accessToken })
    expect(await auditTypes()).not.toContain('user.phone_number_removed')
    expect((await confirm(session.accessToken, code)).status).toBe(200)
  })
})

describe('who may call', () => {
  const routes = [
    ['POST', '/me/phone', { phoneNumber: NUMBER }],
    ['POST', '/me/phone/verify', { code: '123456' }],
    ['DELETE', '/me/phone', undefined],
  ] as const

  test('every route needs a publishable key and a session', async () => {
    const session = await signUp()
    for (const [method, path, body] of routes) {
      expect((await call(method, path, body)).status).toBe(401)
      expect(
        (await call(method, path, body, { token: session.accessToken, key: null })).status
      ).toBe(401)
      expect((await call(method, path, body, { token: 'not-a-token' })).status).toBe(401)
    }
    expect(deps.sms.outbox).toEqual([])
  })

  test('every route needs a recent authentication', async () => {
    const session = await signUp()
    await ask(session.accessToken)
    const code = textedCode()
    deps.clock.advance('11m')
    const old = await json<SessionTokens>(
      await post('/sessions/refresh', { refreshToken: session.refreshToken })
    )
    const sent = deps.sms.outbox.length
    for (const [method, path, body] of routes) {
      const res = await call(method, path, body, { token: old.accessToken })
      expect(await errorOf(res)).toMatchObject({
        status: 403,
        code: 'auth.step_up_required',
        params: { methods: 'password,email_code' },
      })
    }
    expect(deps.sms.outbox).toHaveLength(sent)
    expect((await latestToken(session.userId))?.attempts).toBe(0)
    // After a step-up the same session may.
    const stepped = await json<SessionTokens>(
      await post(
        '/sessions/step-up',
        { method: 'password', password: PASSWORD },
        { token: old.accessToken }
      )
    )
    // The code has expired meanwhile (eleven minutes); the route itself is open again.
    expect(await codeOf(await confirm(stepped.accessToken, code))).toBe('verification.expired')
  })

  test('each route has a per-IP limit of its own', async () => {
    const session = await signUp()
    for (const [method, path, body] of routes) {
      let last = 0
      for (let n = 0; n < 11; n += 1) {
        last = (await call(method, path, body, { token: session.accessToken })).status
      }
      expect(last).toBe(429)
    }
  })
})

describe('an administrator’s view', () => {
  test('the user an admin reads carries the verified number', async () => {
    const session = await signUp()
    await ask(session.accessToken)
    await confirm(session.accessToken, textedCode())
    const res = await app.request(`/v1/admin/users/${session.userId}`, {
      headers: { authorization: `Bearer ${SK}` },
    })
    expect(await json<User>(res)).toMatchObject({
      phoneNumber: NUMBER,
      phoneNumberVerifiedAt: deps.clock.now().toISOString(),
    })
  })
})

describe('the number and the code stay where they belong', () => {
  test('a whole journey: no log line, audit entry, event payload, email or error holds either', async () => {
    const levels = (['debug', 'info', 'warn', 'error'] as const).map((level) =>
      spyOn(logger, level)
    )
    const errors: string[] = []
    const failed = async (res: Response) => {
      expect(res.status).toBeGreaterThanOrEqual(400)
      errors.push(await res.clone().text())
      return res
    }
    const codes: string[] = []
    try {
      const session = await signUp()
      const mailsBefore = deps.mailer.outbox.length
      // Refusals first: a malformed number, then a country that is not allowed.
      await failed(await ask(session.accessToken, `${NUMBER}x`))
      configure({ enabled: true, allowedCountries: ['DE'] })
      await failed(await ask(session.accessToken))
      configure()
      // A send that fails.
      deps.sms.failing = true
      await failed(await ask(session.accessToken))
      deps.sms.failing = false
      deps.clock.advance('1m')
      const renewed = await json<SessionTokens>(
        await post('/sessions/refresh', { refreshToken: session.refreshToken })
      )
      let token = renewed.accessToken
      // A real send, a wrong guess, a refused resend, the right code, a replay, a removal.
      await ask(token)
      codes.push(textedCode())
      await failed(await confirm(token, wrong(textedCode())))
      await failed(await ask(token))
      expect((await confirm(token, textedCode())).status).toBe(200)
      await failed(await confirm(token, textedCode()))
      expect((await call('DELETE', '/me/phone', undefined, { token })).status).toBe(204)
      // And once more for a second number, left pending.
      deps.clock.advance('1m')
      token = (
        await json<SessionTokens>(
          await post('/sessions/refresh', { refreshToken: renewed.refreshToken })
        )
      ).accessToken
      expect((await ask(token, GERMAN)).status).toBe(200)
      codes.push(textedCode(GERMAN))
      for (const code of codes) {
        expect(code).toMatch(/^\d{6}$/)
      }
      await Notices.settled()

      const logged = JSON.stringify(levels.flatMap((spy) => spy.mock.calls))
      const audit = JSON.stringify(
        (await deps.activityLog.listAudit(TEST_TENANT.environmentId, { page: 1, size: 200 }))
          .entries
      )
      const events = JSON.stringify(deps.activityLog.outbox)
      const emails = JSON.stringify(deps.mailer.outbox.slice(mailsBefore))
      const numbers = ['4155550142', '15112345678', NUMBER, GERMAN]
      expect(codes).toHaveLength(2)
      for (const [name, haystack] of [
        ['a log line', logged],
        ['an audit entry', audit],
        ['an event payload', events],
        ['an email', emails],
        ['an error', errors.join('\n')],
      ] as const) {
        for (const secret of [...numbers, ...codes]) {
          const at = haystack.indexOf(secret)
          const found = at === -1 ? 'absent' : haystack.slice(Math.max(0, at - 120), at + 40)
          expect(`${name}: ${found}`).toBe(`${name}: absent`)
        }
      }
      // What is recorded about the journey is there: the canary looked at something.
      expect(audit).toContain('user.phone_number_added')
      expect(events).toContain('user.phone_number_removed')
      expect(logged).toContain('text message not sent')
      expect(errors.length).toBeGreaterThanOrEqual(6)
    } finally {
      for (const spy of levels) {
        spy.mockRestore()
      }
    }
  })
})

describe('the development inbox route', () => {
  const inbox = (
    target: ReturnType<typeof createApp>,
    query = '',
    headers: Record<string, string> = {}
  ) =>
    target.request(`/v1/dev/sms/messages${query}`, {
      // What a tool on this machine sends. A `host` of the test's own replaces it.
      headers: { host: 'localhost:3003', ...headers },
    })

  test('does not exist without an inbox', async () => {
    expect((await inbox(app)).status).toBe(404)
  })

  test('with one, in the local tier, it lists the kept messages, by number', async () => {
    const local = createApp({ ...deps, smsInbox: deps.sms })
    await deps.sms.send({ to: NUMBER, text: 'one' })
    await deps.sms.send({ to: GERMAN, text: 'two' })
    const res = await inbox(local)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const sentAt = deps.clock.now().toISOString()
    expect(await res.json()).toEqual({
      messages: [
        { to: NUMBER, text: 'one', sentAt },
        { to: GERMAN, text: 'two', sentAt },
      ],
    })
    expect(await (await inbox(local, `?to=${encodeURIComponent(GERMAN)}`)).json()).toEqual({
      messages: [{ to: GERMAN, text: 'two', sentAt }],
    })
  })

  test.each(['dev', 'staging', 'prod'] as const)(
    'is not mounted in the %s tier, even with an inbox',
    async (tier) => {
      const elsewhere = createApp({
        ...deps,
        config: { ...deps.config, tier },
        smsInbox: deps.sms,
      })
      await deps.sms.send({ to: NUMBER, text: 'one' })
      expect((await inbox(elsewhere)).status).toBe(404)
    }
  )

  test.each([
    ['an Origin', { origin: 'http://localhost:5173' }],
    ['a cross-site fetch', { 'sec-fetch-site': 'cross-site' }],
    ['a same-site fetch', { 'sec-fetch-site': 'same-site' }],
  ])('refuses a request with %s: it is for tools, not pages', async (_name, headers) => {
    const local = createApp({ ...deps, smsInbox: deps.sms })
    await deps.sms.send({ to: NUMBER, text: 'code 123456' })
    const res = await inbox(local, '', headers)
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain('123456')
  })

  // DNS rebinding: a page of attacker.example, re-resolved to this machine, is same-origin
  // with itself. Its GET has no `Origin` and says `same-origin`. What it cannot choose is
  // the `Host` header, which names the attacker's domain.
  test.each([
    ['a rebinding page’s', 'attacker.example'],
    ['a rebinding page’s, with a port', 'attacker.example:3003'],
    ['a name that only starts like loopback', 'localhost.attacker.example'],
    ['a name that only ends like loopback', 'attacker-localhost'],
    ['an address that embeds loopback', '127.0.0.1.attacker.example'],
    ['every interface', '0.0.0.0:3003'],
    ['a LAN address', '192.168.1.10:3003'],
    ['user information before a loopback name', 'attacker.example@localhost'],
    ['a path', 'localhost/attacker.example'],
    ['an empty one', ''],
    ['one that is only a port', ':3003'],
    ['one with a space', 'localhost attacker.example'],
  ])('refuses a Host that is not this machine (%s): 403, an empty body', async (_name, host) => {
    const local = createApp({ ...deps, smsInbox: deps.sms })
    await deps.sms.send({ to: NUMBER, text: 'code 123456' })
    const res = await inbox(local, '', { host, 'sec-fetch-site': 'same-origin' })
    expect(res.status).toBe(403)
    expect(await res.text()).toBe('')
  })

  test('refuses a request with no Host at all', async () => {
    const local = createApp({ ...deps, smsInbox: deps.sms })
    await deps.sms.send({ to: NUMBER, text: 'code 123456' })
    const res = await local.request('/v1/dev/sms/messages')
    expect(res.status).toBe(403)
    expect(await res.text()).toBe('')
  })

  test.each([
    'localhost:3003',
    'localhost',
    'LOCALHOST:3004',
    '127.0.0.1:3003',
    '[::1]:3003',
    'api.localhost:3003',
  ])('answers on a loopback Host, any port: %s', async (host) => {
    const local = createApp({ ...deps, smsInbox: deps.sms })
    await deps.sms.send({ to: NUMBER, text: 'code 123456' })
    const res = await inbox(local, '', { host, 'sec-fetch-site': 'same-origin' })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('123456')
  })

  test('is not in the OpenAPI document', async () => {
    const local = createApp({ ...deps, smsInbox: deps.sms })
    const document = await (await local.request('/v1/openapi.json')).text()
    expect(document).not.toContain('/v1/dev/sms')
    expect(document).toContain('/v1/client/me/phone')
  })
})
