import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  type ClientConfig,
  DEFAULT_ENVIRONMENT_SETTINGS,
  type EnvironmentSettings,
  type FlowAttempt,
  type HybridSessionTokens as SessionTokens,
} from '@tula/contract'
import { createApp } from '~/index'
import { sha256Hex } from '~/lib/crypto'
import * as logger from '~/lib/logger'
import * as Audit from '~/modules/audit/service'
import * as Notices from '~/modules/notice/service'
import * as Phone from '~/modules/phone/service'
import * as Sms from '~/modules/sms/service'
import { CREDENTIAL_LOCKOUT } from '~/ports/lockout'
import { createTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'

// Signing in with a texted code (ADR 0037, TULA-27): the first factor `sms_code`.
//
// What these hold, beyond the path that works: the answer to "text me a code" is the same
// for every identifier, a message goes only to a number exactly one account has proven
// within a year, every failure of the code is the one generic failed sign-in, and a phone
// number alone never chooses an account's second factor nor passes for a recent sign-in.

const PK = 'tula_pk_dev_publishable0000000000000000000'
const ORIGIN = 'https://app.northline.test'
const TODAY = '2026-10-08'
const SCOPE = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }
const EMAIL = 'maya@northline.app'
const PASSWORD = 'correct horse battery staple'
const NUMBER = '+14155550142'
const UNKNOWN = '+14155550177'
const GERMAN = '+4915112345678'

let deps: TestDeps
let app: ReturnType<typeof createApp>
let revision = 0
let serial = 0

interface Switches {
  smsCode?: boolean
  password?: boolean
  sms?: Partial<EnvironmentSettings['sms']>
  mfa?: EnvironmentSettings['mfa']['policy']
}

function configure(switches: Switches = {}) {
  revision += 1
  deps.environmentSettings.seed(SCOPE.environmentId, {
    revision,
    settings: {
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      signIn: {
        methods: {
          password: { enabled: switches.password ?? true },
          emailCode: { enabled: true },
          emailLink: { enabled: false },
          passkey: { enabled: false },
          smsCode: { enabled: switches.smsCode ?? true },
        },
      },
      mfa: { ...DEFAULT_ENVIRONMENT_SETTINGS.mfa, policy: switches.mfa ?? 'optional' },
      urls: { allowedOrigins: [ORIGIN], allowedRedirectUrls: [] },
      sms: {
        enabled: true,
        allowedCountries: ['US', 'DE'],
        dailyMessageLimit: 500,
        ...switches.sms,
      },
    },
  })
}

beforeEach(async () => {
  deps = createTestDeps()
  // Mid-morning, so that minutes forward stay inside one UTC day.
  deps.clock.set(new Date(`${TODAY}T09:00:00.000Z`))
  deps.environments.add({
    id: SCOPE.environmentId,
    projectId: SCOPE.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  await seedApiKey(deps, PK)
  configure()
  app = createApp(deps)
})

interface CallOptions {
  token?: string
  secret?: string
  ip?: string
}

async function call(method: string, path: string, body?: unknown, options: CallOptions = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-tula-client': 'ios',
    'x-tula-publishable-key': PK,
    origin: ORIGIN,
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
const codeOf = async (res: Response) => (await json<{ code: string }>(res)).code

/** The code in the newest text message to a number. */
const textedCode = (to: string = NUMBER) =>
  /code is (\d{6})\./.exec(deps.sms.messages(to).at(-1)?.text ?? '')?.[1] ?? ''
const emailedCode = () =>
  /^(\d{6}) /.exec(
    deps.mailer.outbox.findLast((mail) => /^\d{6} /.test(mail.subject))?.subject ?? ''
  )?.[1] ?? ''
/** A six-digit code that is not the one given. */
const wrong = (code: string) => (code === '000000' ? '000001' : '000000')
const sentToday = () => deps.smsUsage.sentOn(SCOPE.environmentId, TODAY)

interface Seed {
  email?: string | null
  emailVerified?: boolean
  password?: boolean
  phoneNumber?: string | null
  /** How long ago the number was proven. */
  provenAgo?: string
}

/** A user as the stores would hold one: an address, a password and a proven number. */
async function seedUser(seed: Seed = {}): Promise<string> {
  serial += 1
  const id = `0198c0de-0000-7000-8000-${String(serial).padStart(12, '0')}`
  const email = seed.email === undefined ? EMAIL : seed.email
  const now = deps.clock.now()
  await deps.users.create(
    {
      id,
      projectId: SCOPE.projectId,
      environmentId: SCOPE.environmentId,
      email,
      emailNormalized: email,
      emailVerifiedAt: email !== null && (seed.emailVerified ?? true) ? now : null,
      firstName: null,
      lastName: null,
      createdAt: now,
      identityId: email === null ? null : `${id}-identity`,
      credentialId: `${id}-credential`,
      passwordHash:
        email !== null && (seed.password ?? true)
          ? await Bun.password.hash(PASSWORD, { algorithm: 'argon2id', memoryCost: 8, timeCost: 1 })
          : null,
    } as Parameters<typeof deps.users.create>[0],
    Audit.none('fixture')
  )
  const phoneNumber = seed.phoneNumber === undefined ? NUMBER : seed.phoneNumber
  if (phoneNumber !== null) {
    const provenAt = new Date(now.getTime())
    if (seed.provenAgo) {
      deps.clock.advance(0)
      provenAt.setTime(now.getTime() - durationMs(seed.provenAgo))
    }
    await deps.users.setPhoneNumber(
      SCOPE.environmentId,
      id,
      phoneNumber,
      provenAt,
      Audit.none('fixture')
    )
  }
  return id
}

function durationMs(text: string): number {
  const days = /^(\d+)d$/.exec(text)
  if (!days) {
    throw new Error(`unknown duration ${text}`)
  }
  return Number(days[1]) * 86_400_000
}

async function start(identifier: string = NUMBER): Promise<FlowAttempt> {
  const res = await post('/sign-ins', { identifier })
  expect(res.status).toBe(200)
  return json<FlowAttempt>(res)
}

const prepare = (attempt: FlowAttempt) =>
  post(
    `/sign-ins/${attempt.id}/first-factor/prepare`,
    { strategy: 'sms_code' },
    { secret: attempt.attemptSecret }
  )

const submit = (attempt: FlowAttempt, code: string) =>
  post(
    `/sign-ins/${attempt.id}/first-factor/attempt`,
    { strategy: 'sms_code', code },
    { secret: attempt.attemptSecret }
  )

/** Start a sign-in for a number and ask for its code; the message is on its way out. */
async function asked(identifier: string = NUMBER): Promise<FlowAttempt> {
  const attempt = await start(identifier)
  const res = await prepare(attempt)
  expect(res.status).toBe(200)
  await Sms.settled()
  return attempt
}

const claims = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
    amr?: string[]
    sub: string
  }

const latestToken = (attempt: FlowAttempt) =>
  deps.verificationTokens.findLatest(SCOPE.environmentId, 'sms_sign_in', {
    flowAttemptId: attempt.id,
  })

describe('the strategy is offered by the settings alone', () => {
  test('a sign-in is offered `sms_code` where the method and text messages are on', async () => {
    const lookup = spyOn(deps.users, 'findByPhoneNumber')
    const attempt = await start('+1 (415) 555-0142')
    expect(attempt.step).toMatchObject({
      status: 'needs_first_factor',
      strategies: ['password', 'email_code', 'sms_code'],
    })
    // The same for an address: the list never depends on what was typed.
    expect((await start(EMAIL)).step).toMatchObject({
      strategies: ['password', 'email_code', 'sms_code'],
    })
    // Kept in E.164 form, and nothing was looked up.
    const stored = await deps.flowAttempts.findById(SCOPE.environmentId, attempt.id)
    expect(stored?.identifier).toBe(NUMBER)
    expect(lookup).not.toHaveBeenCalled()
  })

  test.each([
    ['the method is off', { smsCode: false }, true],
    ['text messages are off', { sms: { enabled: false } }, true],
    ['no country is allowed', { sms: { allowedCountries: [] } }, true],
    ['the deployment has no sender', {}, false],
  ] as [string, Switches, boolean][])('not offered when %s', async (_name, switches, sender) => {
    configure(switches)
    deps.sms.configured = sender
    const attempt = await start()
    expect(attempt.step).toMatchObject({ strategies: ['password', 'email_code'] })
    const config = await json<ClientConfig>(await call('GET', '/config'))
    expect(config.signIn.methods).not.toContain('smsCode')
    // And a strategy that was not offered is not accepted.
    expect(await codeOf(await prepare(attempt))).toBe('flow.invalid_step')
  })

  test('the client config lists `smsCode` where a code can be had', async () => {
    const config = await json<ClientConfig>(await call('GET', '/config'))
    expect(config.signIn.methods).toContain('smsCode')
  })
})

describe('signing in with a texted code', () => {
  test('the code is texted to the number and signs its one holder in', async () => {
    const userId = await seedUser({ provenAgo: '30d' })
    const attempt = await start()
    const res = await prepare(attempt)
    expect(res.status).toBe(200)
    const prepared = await json<FlowAttempt>(res)
    expect(prepared.step).toEqual({
      status: 'needs_first_factor',
      strategies: ['password', 'email_code', 'sms_code'],
      prepared: { strategy: 'sms_code', destination: '***42' },
    })
    await Sms.settled()
    expect(deps.sms.outbox.map(({ to }) => to)).toEqual([NUMBER])
    const code = textedCode()
    expect(deps.sms.last().text).toBe(
      `Your Tula verification code is ${code}.\n\n@app.northline.test #${code}`
    )

    const done = await submit(attempt, code)
    expect(done.status).toBe(200)
    const body = await json<FlowAttempt>(done)
    expect(body.step.status).toBe('complete')
    const session = body.session as SessionTokens
    // SMS is its own value: not `email`, not `pwd`, and never `mfa`.
    expect(claims(session.accessToken)).toMatchObject({ sub: userId, amr: ['sms'] })

    // It went through `finish`: the session is recorded like any other sign-in's.
    await Notices.settled()
    const created = deps.activityLog.events.filter((event) => event.type === 'session.created')
    expect(created).toHaveLength(1)
    expect(JSON.stringify(created)).not.toContain('4155550142')

    // The number was proven again just now, and the code is counted as used.
    const user = await deps.users.findById(SCOPE.environmentId, userId)
    expect(user?.phoneNumberVerifiedAt?.toISOString()).toBe(deps.clock.now().toISOString())
    expect(await deps.smsUsage.summary(SCOPE.environmentId, TODAY, 10)).toMatchObject({
      sent: 1,
      used: 1,
    })
  })

  test('a code is single use', async () => {
    await seedUser()
    const attempt = await asked()
    const code = textedCode()
    expect((await submit(attempt, code)).status).toBe(200)
    // The attempt is complete, and the code is spent whatever asks.
    const again = await submit(attempt, code)
    expect(again.status).not.toBe(200)
    expect((await latestToken(attempt))?.consumedAt).not.toBeNull()
  })

  test('the code is a keyed hash that covers the attempt and the number', async () => {
    await seedUser()
    const attempt = await asked()
    const code = textedCode()
    const token = await latestToken(attempt)
    expect(token).toMatchObject({
      purpose: 'sms_sign_in',
      flowAttemptId: attempt.id,
      destination: NUMBER,
      linkTokenHash: null,
      attempts: 0,
      maxAttempts: 5,
      consumedAt: null,
    })
    expect(token?.expiresAt.getTime()).toBe(deps.clock.now().getTime() + 10 * 60_000)
    expect(token?.codeHash).not.toBe(sha256Hex(code))
    expect(token?.codeHash).toBe(
      await deps.keyedHash.hmac(
        'verification-codes',
        `${token?.id}:${attempt.id}:${NUMBER}:${code}`
      )
    )
  })

  test('a user with no email address signs in', async () => {
    const userId = await seedUser({ email: null })
    const attempt = await asked()
    const done = await json<FlowAttempt>(await submit(attempt, textedCode()))
    expect(done.step.status).toBe('complete')
    expect(claims((done.session as SessionTokens).accessToken)).toMatchObject({
      sub: userId,
      amr: ['sms'],
    })
  })

  test('an unverified address is proven before the session, and a password on it goes', async () => {
    const userId = await seedUser({ emailVerified: false })
    const attempt = await asked()
    const parked = await json<FlowAttempt>(await submit(attempt, textedCode()))
    expect(parked.step.status).toBe('needs_email_verification')
    expect(parked.session).toBeUndefined()
    const done = await json<FlowAttempt>(
      await post(
        `/sign-ins/${attempt.id}/verify-email`,
        { code: emailedCode() },
        { secret: attempt.attemptSecret }
      )
    )
    expect(done.step.status).toBe('complete')
    expect(new Set(claims((done.session as SessionTokens).accessToken).amr)).toEqual(
      new Set(['sms', 'email'])
    )
    // Nobody proved the password of the still-unverified account (ADR 0024).
    const found = await deps.users.findByEmailWithPassword(SCOPE.environmentId, EMAIL)
    expect(found?.user.id).toBe(userId)
    expect(found?.passwordHash).toBeNull()
    expect(found?.user.emailVerifiedAt).not.toBeNull()
  })

  test('a banned holder is told so only after proving the number', async () => {
    const userId = await seedUser()
    await deps.users.setBanned(
      SCOPE.environmentId,
      userId,
      deps.clock.now(),
      deps.clock.now(),
      Audit.none('fixture')
    )
    const attempt = await asked()
    const code = textedCode()
    expect(code).toMatch(/^\d{6}$/)
    expect(await codeOf(await submit(attempt, wrong(code)))).toBe('auth.invalid_credentials')
    expect(await codeOf(await submit(attempt, code))).toBe('auth.user_banned')
  })
})

describe('asking for a code answers the same for every identifier', () => {
  /** What one prepare did: its answer, the limiter's counters it touched, what was sent. */
  async function observe(identifier: string) {
    const hit = spyOn(deps.rateLimiter, 'hit')
    const before = hit.mock.calls.length
    const sentBefore = deps.sms.outbox.length
    const attempt = await start(identifier)
    const mark = hit.mock.calls.length
    const res = await prepare(attempt)
    const body = await json<FlowAttempt>(res)
    await Sms.settled()
    const counters = hit.mock.calls.slice(mark).map(([key, limit, window]) => ({
      // The hashes differ, as the identifiers do: what must not differ is which counters.
      key: key.replace(/[0-9a-f]{64}/g, '#'),
      limit,
      window,
    }))
    hit.mockRestore()
    return {
      status: res.status,
      headers: [...res.headers.keys()].sort(),
      step: body.step,
      keys: Object.keys(body).sort(),
      started: mark - before,
      counters,
      sent: deps.sms.outbox.length - sentBefore,
    }
  }

  test('a number with one holder and a number nobody holds: same answer, same counters', async () => {
    await seedUser()
    const known = await observe(NUMBER)
    const unknown = await observe(UNKNOWN)
    expect(known.sent).toBe(1)
    expect(unknown.sent).toBe(0)
    expect(unknown.status).toBe(known.status)
    expect(unknown.headers).toEqual(known.headers)
    expect(unknown.keys).toEqual(known.keys)
    expect(unknown.started).toBe(known.started)
    expect(unknown.counters).toEqual(known.counters)
    // The step differs only in the two digits of what was typed.
    expect(known.step).toMatchObject({ prepared: { strategy: 'sms_code', destination: '***42' } })
    expect(unknown.step).toMatchObject({
      prepared: { strategy: 'sms_code', destination: '***77' },
    })
    // Asker, number, address, prefix, environment: every row a message is counted by.
    expect(known.counters.map(({ key }) => key.split(':')[0])).toEqual([
      'client',
      'sign_in_prepare',
      'sms_asker_cooldown',
      'sms_asker',
      'sms_number_cooldown',
      'sms_number',
      'sms_address',
      'sms_prefix',
      'sms_environment',
    ])
    // No message, so none of the day's: the decoy is refused by a spent day, never counted.
    expect(await sentToday()).toBe(1)
  })

  test('an unknown number holds a decoy code nobody was told', async () => {
    const attempt = await asked(UNKNOWN)
    expect(deps.sms.outbox).toHaveLength(0)
    const token = await latestToken(attempt)
    expect(token).toMatchObject({ purpose: 'sms_sign_in', userId: null, destination: UNKNOWN })
    for (const guess of ['000000', '123456', '999999']) {
      expect(await codeOf(await submit(attempt, guess))).toBe('auth.invalid_credentials')
    }
  })

  test('a number two accounts hold signs nobody in, and no message goes', async () => {
    await seedUser({ email: 'one@northline.app' })
    await seedUser({ email: 'two@northline.app' })
    const attempt = await asked()
    expect(deps.sms.outbox).toHaveLength(0)
    expect(await codeOf(await submit(attempt, '123456'))).toBe('auth.invalid_credentials')
  })

  test('a second holder after the code was texted makes the code worthless', async () => {
    await seedUser({ email: 'one@northline.app' })
    const attempt = await asked()
    const code = textedCode()
    await seedUser({ email: 'two@northline.app' })
    expect(await codeOf(await submit(attempt, code))).toBe('auth.invalid_credentials')
  })

  test('a number proven more than a year ago signs nobody in until it is proven again', async () => {
    const userId = await seedUser({ provenAgo: '366d' })
    const attempt = await asked()
    expect(deps.sms.outbox).toHaveLength(0)
    expect(await codeOf(await submit(attempt, '123456'))).toBe('auth.invalid_credentials')
    // Just inside the year it works, and the sign-in moves the proof to now.
    const provenAt = new Date(deps.clock.now().getTime() - durationMs('364d'))
    await deps.users.setPhoneNumber(
      SCOPE.environmentId,
      userId,
      NUMBER,
      provenAt,
      Audit.none('fixture')
    )
    deps.clock.advance('2m')
    const second = await asked()
    expect((await submit(second, textedCode())).status).toBe(200)
    const user = await deps.users.findById(SCOPE.environmentId, userId)
    expect(user?.phoneNumberVerifiedAt?.toISOString()).toBe(deps.clock.now().toISOString())
  })

  test('an email address asked for a texted code is an unknown number', async () => {
    await seedUser()
    const attempt = await start(EMAIL)
    const res = await prepare(attempt)
    expect(res.status).toBe(200)
    expect((await json<FlowAttempt>(res)).step).toMatchObject({
      prepared: { strategy: 'sms_code', destination: '***' },
    })
    await Sms.settled()
    expect(deps.sms.outbox).toHaveLength(0)
    expect(await codeOf(await submit(attempt, '123456'))).toBe('auth.invalid_credentials')
  })

  test('a phone number given another strategy fails like an unknown address', async () => {
    await seedUser()
    const attempt = await start()
    const res = await post(
      `/sign-ins/${attempt.id}/password`,
      { password: PASSWORD },
      { secret: attempt.attemptSecret }
    )
    expect(await codeOf(res)).toBe('auth.invalid_credentials')
  })

  test.each([
    ['refuses', true, 0],
    ['loses the answer', 'unconfirmed', 1],
  ] as const)('a sender that %s changes nothing of the answer', async (_name, failing, kept) => {
    await seedUser()
    deps.sms.failing = failing
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined)
    const attempt = await start()
    const res = await prepare(attempt)
    expect(res.status).toBe(200)
    expect((await json<FlowAttempt>(res)).step).toMatchObject({
      prepared: { strategy: 'sms_code', destination: '***42' },
    })
    await Sms.settled()
    expect(deps.sms.outbox).toHaveLength(0)
    // Said in the log, never with the number; a refusal is taken back out of the day, a
    // lost answer stays in it (the message may have gone out).
    expect(warn.mock.calls.some(([message]) => message === 'text message not sent')).toBe(true)
    expect(JSON.stringify(warn.mock.calls)).not.toContain('4155550142')
    expect(await sentToday()).toBe(kept)
    warn.mockRestore()
  })

  test('a spent day refuses a known and an unknown number alike', async () => {
    await seedUser()
    configure({ sms: { dailyMessageLimit: 40 } })
    for (let i = 0; i < 40; i += 1) {
      await deps.smsUsage.takeFromDay(SCOPE, TODAY, '+49', 1_000_000, deps.clock.now())
    }
    const info = spyOn(logger, 'warn').mockImplementation(() => undefined)
    for (const identifier of [NUMBER, UNKNOWN]) {
      const res = await prepare(await start(identifier))
      expect(res.status).toBe(429)
      expect(await codeOf(res)).toBe('rate_limited')
    }
    info.mockRestore()
    expect(deps.sms.outbox).toHaveLength(0)
    expect(await sentToday()).toBe(40)
  })

  test('a new attempt is not a new asker: the second one within a minute is refused', async () => {
    await seedUser()
    await asked()
    for (const identifier of [NUMBER]) {
      const res = await prepare(await start(identifier))
      expect(await codeOf(res)).toBe('rate_limited')
    }
    // The same for a number nobody holds.
    await asked(UNKNOWN)
    expect(await codeOf(await prepare(await start(UNKNOWN)))).toBe('rate_limited')
    expect(deps.sms.outbox).toHaveLength(1)
  })

  test('the asker of a sign-in is its identifier, and never counted as a new number', async () => {
    const hit = spyOn(deps.rateLimiter, 'hit')
    const first = await asked(UNKNOWN)
    const keys = hit.mock.calls.map(([key]) => key)
    hit.mockRestore()
    const asker = await Sms.signInAsker(deps, SCOPE.environmentId, UNKNOWN)
    expect(keys).toContain(`sms_asker:${SCOPE.environmentId}:sign_in:${asker.id}`)
    expect(keys.some((key) => key.startsWith('sms_asker_new_number'))).toBe(false)
    // Nothing a caller chooses but the number is in a key: not the attempt, not the number.
    expect(keys.join('\n')).not.toContain(first.id)
    expect(keys.join('\n')).not.toContain('4155550177')
    expect(keys.join('\n')).not.toContain(sha256Hex(UNKNOWN))
  })
})

describe('the code proves one number for one attempt, and nothing else', () => {
  test('a code texted for one attempt is refused on another for the same number', async () => {
    await seedUser()
    const first = await asked()
    const code = textedCode()
    deps.clock.advance('61s')
    const second = await asked()
    const other = textedCode()
    expect(await codeOf(await submit(second, other === code ? wrong(code) : code))).toBe(
      'auth.invalid_credentials'
    )
    // Each still takes its own.
    expect((await submit(first, code)).status).toBe(200)
  })

  test('a code that adds a number to an account is not honoured for a sign-in', async () => {
    const userId = await seedUser()
    const attempt = await asked()
    deps.clock.advance('61s')
    // The holder, signed in another way, asks for a code for the same number.
    const signIn = await start(EMAIL)
    const session = (
      await json<FlowAttempt>(
        await post(
          `/sign-ins/${signIn.id}/password`,
          { password: PASSWORD },
          { secret: signIn.attemptSecret }
        )
      )
    ).session as SessionTokens
    const before = deps.sms.outbox.length
    expect(
      (await post('/me/phone', { phoneNumber: NUMBER }, { token: session.accessToken })).status
    ).toBe(200)
    expect(deps.sms.outbox).toHaveLength(before + 1)
    const phoneCode = textedCode()
    const signInCode = /code is (\d{6})\./.exec(deps.sms.outbox[before - 1]?.text ?? '')?.[1] ?? ''
    if (phoneCode !== signInCode) {
      expect(await codeOf(await submit(attempt, phoneCode))).toBe('auth.invalid_credentials')
      // And the reverse: a sign-in's code adds no number.
      expect(
        await codeOf(
          await post('/me/phone/verify', { code: signInCode }, { token: session.accessToken })
        )
      ).toBe('verification.invalid_code')
    }
    // The stores hold them apart whatever the digits are.
    expect(
      await deps.verificationTokens.findLatest(SCOPE.environmentId, 'phone_verification', {
        flowAttemptId: attempt.id,
      })
    ).toBeNull()
    expect(
      (await deps.verificationTokens.findLatest(SCOPE.environmentId, 'sms_sign_in', { userId }))
        ?.flowAttemptId
    ).toBe(attempt.id)
  })

  test('a guess is counted under the identifier’s lockout before the code is looked at', async () => {
    await seedUser()
    const attempt = await asked()
    const code = textedCode()
    const order: string[] = []
    const lock = spyOn(deps.lockout, 'attempt')
    const realAttempt = lock.getMockImplementation()
    lock.mockImplementation(async (...args) => {
      order.push('lockout')
      return (realAttempt ?? Object.getPrototypeOf(deps.lockout).attempt).apply(deps.lockout, args)
    })
    const find = spyOn(deps.verificationTokens, 'findLatest')
    const realFind = Object.getPrototypeOf(deps.verificationTokens).findLatest
    find.mockImplementation(async (...args) => {
      order.push('token')
      return realFind.apply(deps.verificationTokens, args)
    })
    expect(await codeOf(await submit(attempt, wrong(code)))).toBe('auth.invalid_credentials')
    expect(order.slice(0, 2)).toEqual(['lockout', 'token'])
    const key = lock.mock.calls[0]?.[0] ?? ''
    lock.mockRestore()
    find.mockRestore()
    // A keyed hash of the number: neither the number nor a plain hash anyone could rebuild.
    expect(key).toBe(await Phone.signInLockKey(deps, SCOPE.environmentId, NUMBER))
    expect(key).not.toContain('4155550142')
    expect(key).not.toContain(sha256Hex(NUMBER))
    expect(key).not.toContain(sha256Hex(`${SCOPE.environmentId}:${NUMBER}`))
  })

  test('a locked identifier is the same failed sign-in, even with the right code', async () => {
    await seedUser()
    const attempt = await asked()
    const code = textedCode()
    const key = await Phone.signInLockKey(deps, SCOPE.environmentId, NUMBER)
    for (let i = 0; i <= CREDENTIAL_LOCKOUT.freeAttempts; i += 1) {
      await deps.lockout.attempt(key, CREDENTIAL_LOCKOUT, deps.clock.now())
    }
    const res = await submit(attempt, code)
    expect(res.status).toBe(401)
    expect(await codeOf(res)).toBe('auth.invalid_credentials')
    // The code was not looked at: it is still unspent, with no guess counted against it.
    expect(await latestToken(attempt)).toMatchObject({ attempts: 0, consumedAt: null })
  })

  test('a password guessed for a number counts under the same key, and success clears it', async () => {
    await seedUser()
    const attempt = await asked()
    const key = await Phone.signInLockKey(deps, SCOPE.environmentId, NUMBER)
    const lock = spyOn(deps.lockout, 'attempt')
    await post(
      `/sign-ins/${attempt.id}/password`,
      { password: 'not the password' },
      { secret: attempt.attemptSecret }
    )
    expect(lock.mock.calls.map(([k]) => k)).toEqual([key])
    lock.mockRestore()
    const clear = spyOn(deps.lockout, 'clear')
    expect((await submit(attempt, textedCode())).status).toBe(200)
    expect(clear.mock.calls.map(([k]) => k)).toContain(key)
    clear.mockRestore()
  })

  test('a code out of guesses, an expired one and none asked for are the same failure', async () => {
    await seedUser()
    // None asked for.
    const bare = await start()
    expect(await codeOf(await submit(bare, '123456'))).toBe('auth.invalid_credentials')
    // Replaced by a newer one.
    const attempt = await asked()
    const first = textedCode()
    deps.clock.advance('61s')
    expect((await prepare(attempt)).status).toBe(200)
    await Sms.settled()
    const second = textedCode()
    if (first !== second) {
      const replaced = await submit(attempt, first)
      expect(replaced.status).toBe(401)
      expect(await codeOf(replaced)).toBe('auth.invalid_credentials')
    }
    // Out of guesses: the right code no longer works, and says nothing else.
    const key = await Phone.signInLockKey(deps, SCOPE.environmentId, NUMBER)
    for (let i = 0; i < 5; i += 1) {
      await deps.lockout.clear(key)
      expect(await codeOf(await submit(attempt, wrong(second)))).toBe('auth.invalid_credentials')
    }
    await deps.lockout.clear(key)
    const spent = await submit(attempt, second)
    expect(spent.status).toBe(401)
    expect(await codeOf(spent)).toBe('auth.invalid_credentials')
  })
})

describe('what was on when the code was asked for must still be on', () => {
  test.each([
    ['the method is switched off', { smsCode: false }, true, 'auth.method_disabled'],
    ['text messages are switched off', { sms: { enabled: false } }, true, 'sms.disabled'],
    [
      'the number’s country leaves the list',
      { sms: { allowedCountries: ['DE'] } },
      true,
      'sms.country_not_allowed',
    ],
    ['the sender is gone', {}, false, 'sms.unavailable'],
  ] as [string, Switches, boolean, string][])(
    '%s between the message and the code: refused, nothing counted',
    async (_name, switches, sender, code) => {
      await seedUser()
      const attempt = await asked()
      const texted = textedCode()
      configure(switches)
      deps.sms.configured = sender
      const lock = spyOn(deps.lockout, 'attempt')
      expect(await codeOf(await submit(attempt, texted))).toBe(code)
      expect(lock).not.toHaveBeenCalled()
      lock.mockRestore()
      expect(await latestToken(attempt)).toMatchObject({ attempts: 0, consumedAt: null })
      // And no new code either.
      deps.clock.advance('61s')
      const before = deps.sms.outbox.length
      expect(await codeOf(await prepare(attempt))).toBe(code)
      await Sms.settled()
      expect(deps.sms.outbox).toHaveLength(before)
    }
  )

  test('a number of a country that is not allowed is refused, whoever holds it', async () => {
    configure({ sms: { allowedCountries: ['US'] } })
    const hit = spyOn(deps.rateLimiter, 'hit')
    const attempt = await start(GERMAN)
    const mark = hit.mock.calls.length
    const res = await prepare(attempt)
    expect(await codeOf(res)).toBe('sms.country_not_allowed')
    // Before any send limit: only the route's own per-IP limits were counted.
    expect(hit.mock.calls.slice(mark).map(([key]) => key.split(':')[0])).toEqual([
      'client',
      'sign_in_prepare',
    ])
    hit.mockRestore()
  })

  test('a step parked after the texted code is refused once the method is off', async () => {
    await seedUser({ emailVerified: false })
    const attempt = await asked()
    expect((await json<FlowAttempt>(await submit(attempt, textedCode()))).step.status).toBe(
      'needs_email_verification'
    )
    const code = emailedCode()
    configure({ smsCode: false })
    const res = await post(
      `/sign-ins/${attempt.id}/verify-email`,
      { code },
      { secret: attempt.attemptSecret }
    )
    expect(await codeOf(res)).toBe('auth.method_disabled')
  })
})

describe('a phone number alone is not enough for what protects an account', () => {
  test('where two-step verification is required, a texted code alone does not enrol', async () => {
    const userId = await seedUser()
    configure({ mfa: 'required' })
    const attempt = await asked()
    const code = textedCode()
    const res = await submit(attempt, code)
    expect(res.status).toBe(403)
    expect(await codeOf(res)).toBe('mfa.enrolment_needs_other_sign_in')
    // Nothing was spent or moved: the attempt still waits on its first factor.
    expect(await latestToken(attempt)).toMatchObject({ consumedAt: null })
    const stored = await deps.flowAttempts.findById(SCOPE.environmentId, attempt.id)
    expect(stored).toMatchObject({ status: 'needs_first_factor', userId: null })
    expect(deps.activityLog.events.filter((e) => e.type === 'session.created')).toHaveLength(0)
    const user = await deps.users.findById(SCOPE.environmentId, userId)
    expect(user?.phoneNumberVerifiedAt?.toISOString()).toBe(deps.clock.now().toISOString())
    // No enrolment route opens for it either.
    const enrol = await post(
      `/sign-ins/${attempt.id}/factor-enrolment/totp`,
      {},
      { secret: attempt.attemptSecret }
    )
    expect(await codeOf(enrol)).toBe('flow.invalid_step')
    // Signed in another way, the same person may enrol.
    const other = await start(EMAIL)
    const parked = await json<FlowAttempt>(
      await post(
        `/sign-ins/${other.id}/password`,
        { password: PASSWORD },
        { secret: other.attemptSecret }
      )
    )
    expect(parked.step.status).toBe('needs_factor_enrolment')
  })

  test('a session proven by a texted code alone is not a recent authentication', async () => {
    await seedUser()
    const attempt = await asked()
    const done = await json<FlowAttempt>(await submit(attempt, textedCode()))
    const session = done.session as SessionTokens
    // Seconds old, and still refused: a sensitive change needs more than the phone.
    const res = await post('/me/phone', { phoneNumber: GERMAN }, { token: session.accessToken })
    expect(res.status).toBe(403)
    const body = await json<{ code: string; params?: { methods?: string } }>(res)
    expect(body.code).toBe('auth.step_up_required')
    // SMS is never a way to step up.
    expect(body.params?.methods).toBe('password,email_code')
    expect(deps.sms.messages(GERMAN)).toHaveLength(0)
  })
})

describe('nothing of a number travels', () => {
  test('no log line, event or audit entry of a sign-in holds the number', async () => {
    const lines: unknown[] = []
    const spies = (['info', 'warn', 'error', 'debug'] as const).map((level) =>
      spyOn(logger, level).mockImplementation((...args: unknown[]) => {
        lines.push(args)
      })
    )
    await seedUser()
    const attempt = await asked()
    await submit(attempt, wrong(textedCode()))
    await submit(attempt, textedCode())
    await asked(UNKNOWN)
    await Notices.settled()
    for (const spy of spies) {
      spy.mockRestore()
    }
    const audit = await deps.activityLog.listAudit(SCOPE.environmentId, { page: 1, size: 200 })
    const written = JSON.stringify([lines, deps.activityLog.events, audit.entries])
    for (const number of [NUMBER, UNKNOWN]) {
      expect(written).not.toContain(number)
      expect(written).not.toContain(number.slice(1))
      expect(written).not.toContain(number.slice(2))
    }
  })
})
