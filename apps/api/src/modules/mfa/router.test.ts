import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  type AccessTokenClaims,
  type BackupCodes,
  type Factors,
  FLOW_ATTEMPT_HEADER,
  type FlowAttempt,
  type HybridSessionTokens as SessionTokens,
  type TotpEnrolment,
} from '@tula/contract'
import { decodeJwt } from 'jose'
import { createApp } from '~/index'
import * as logger from '~/lib/logger'
import { base32Decode, totp } from '~/lib/totp'
import { MFA_RATE_LIMIT } from '~/modules/mfa/router'
import * as Notices from '~/modules/notice/service'
import { createTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'

const PK = 'tula_pk_dev_publishable0000000000000000000'
const SK = 'tula_sk_dev_secret000000000000000000000000'
const EMAIL = 'maya@northline.app'
const PASSWORD = 'correct horse battery staple'
let deps: TestDeps
let app: ReturnType<typeof createApp>
let secrets: Map<string, string>

beforeEach(async () => {
  secrets = new Map()
  deps = createTestDeps()
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  await seedApiKey(deps, PK)
  await seedApiKey(deps, SK)
  app = createApp(deps)
})

const ATTEMPT_PATH = /^\/(?:sign-ups|sign-ins|password-resets)\/([^/]+)\//

/** A native client (tokens in the body) that remembers each attempt's secret. */
async function call(method: string, path: string, body?: unknown, accessToken?: string) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-tula-publishable-key': PK,
    'x-tula-client': 'ios',
  }
  if (accessToken) {
    headers.authorization = `Bearer ${accessToken}`
  }
  const secret = secrets.get(ATTEMPT_PATH.exec(path)?.[1] ?? '')
  if (secret) {
    headers[FLOW_ATTEMPT_HEADER] = secret
  }
  const res = await app.request(`/v1/client${path}`, {
    method,
    headers,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
  const started = (await res
    .clone()
    .json()
    .catch(() => null)) as Partial<FlowAttempt> | null
  if (started?.id && started.attemptSecret) {
    secrets.set(started.id, started.attemptSecret)
  }
  return res
}

const post = (path: string, body: unknown = {}, accessToken?: string) =>
  call('POST', path, body, accessToken)
const json = async <T>(res: Response) => (await res.json()) as T
const errorOf = async (res: Response) =>
  json<{ status: number; code: string; params?: Record<string, unknown> }>(res)
const sentCode = () => /\b(\d{6})\b/.exec(deps.mailer.last().text)?.[1] ?? ''
const claimsOf = (token: string) => decodeJwt(token) as unknown as AccessTokenClaims
/** The code an authenticator app holding `secret` shows at the test clock's time. */
const codeFor = (secret: string) => totp(base32Decode(secret), deps.clock.now())

async function signUp(): Promise<FlowAttempt> {
  const started = await json<FlowAttempt>(
    await post('/sign-ups', { email: EMAIL, password: PASSWORD })
  )
  return json<FlowAttempt>(await post(`/sign-ups/${started.id}/verify-email`, { code: sentCode() }))
}

/** Sign in with the password; the answer is `complete` or `needs_second_factor`. */
async function signIn(): Promise<FlowAttempt> {
  const started = await json<FlowAttempt>(await post('/sign-ins', { identifier: EMAIL }))
  return json<FlowAttempt>(await post(`/sign-ins/${started.id}/password`, { password: PASSWORD }))
}

/** A signed-up user who has turned two-step verification on. */
async function enrolled() {
  const session = (await signUp()).session as SessionTokens
  const enrolment = await json<TotpEnrolment>(
    await post('/me/factors/totp', {}, session.accessToken)
  )
  const confirmed = await post(
    '/me/factors/totp/confirm',
    { code: codeFor(enrolment.secret) },
    session.accessToken
  )
  expect(confirmed.status).toBe(200)
  const { codes } = await json<BackupCodes>(confirmed)
  // The notice is sent in the background: let it land before a test reads the outbox.
  await Notices.settled()
  // The code that confirmed the enrolment is spent: the next sign-in needs the next step's.
  deps.clock.advance('30s')
  return { session, secret: enrolment.secret, codes }
}

describe('enrolling an authenticator over HTTP', () => {
  test('start returns the secret and URI once; confirm turns it on and returns ten backup codes', async () => {
    const session = (await signUp()).session as SessionTokens
    expect(
      await json<Factors>(await call('GET', '/me/factors', undefined, session.accessToken))
    ).toEqual({
      totp: { enabled: false, confirmedAt: null },
      backupCodes: { remaining: 0 },
    })

    const started = await post('/me/factors/totp', {}, session.accessToken)
    expect(started.status).toBe(200)
    expect(started.headers.get('cache-control')).toBe('no-store')
    const enrolment = await json<TotpEnrolment>(started)
    expect(enrolment.secret).toMatch(/^[A-Z2-7]{32}$/)
    expect(enrolment.uri).toBe(
      `otpauth://totp/Tula:maya%40northline.app?secret=${enrolment.secret}` +
        '&issuer=Tula&algorithm=SHA1&digits=6&period=30'
    )
    // Pending: it does not count, and a sign-in is not asked for it.
    expect(
      (await json<Factors>(await call('GET', '/me/factors', undefined, session.accessToken))).totp
    ).toEqual({ enabled: false, confirmedAt: null })
    expect((await signIn()).step.status).toBe('complete')

    const wrong = await post('/me/factors/totp/confirm', { code: '000000' }, session.accessToken)
    expect(await errorOf(wrong)).toMatchObject({ status: 422, code: 'mfa.invalid_code' })

    const confirmed = await post(
      '/me/factors/totp/confirm',
      { code: codeFor(enrolment.secret) },
      session.accessToken
    )
    expect(confirmed.status).toBe(200)
    const { codes } = await json<BackupCodes>(confirmed)
    expect(codes).toHaveLength(10)
    expect(new Set(codes).size).toBe(10)
    for (const code of codes) {
      expect(code).toMatch(/^[2-9a-hjkmnp-z]{5}-[2-9a-hjkmnp-z]{5}$/)
    }
    expect(
      await json<Factors>(await call('GET', '/me/factors', undefined, session.accessToken))
    ).toEqual({
      totp: { enabled: true, confirmedAt: deps.clock.now().toISOString() },
      backupCodes: { remaining: 10 },
    })
    expect(deps.activityLog.ofType('user.mfa_enabled')).toHaveLength(1)
    await Notices.settled()
    expect(deps.mailer.last().subject).toBe(
      'Two-step verification was turned on for your Tula account'
    )
  })

  test('a signed-out caller is refused on every route', async () => {
    for (const [method, path] of [
      ['GET', '/me/factors'],
      ['POST', '/me/factors/totp'],
      ['POST', '/me/factors/totp/confirm'],
      ['DELETE', '/me/factors/totp'],
      ['POST', '/me/factors/backup-codes'],
      ['POST', '/sessions/step-up'],
      ['POST', '/sessions/step-up/email-code'],
    ] as const) {
      const res = await call(method, path, method === 'POST' ? { code: '123456' } : undefined)
      expect([path, res.status]).toEqual([path, 401])
    }
  })
})

describe('signing in with a second factor over HTTP', () => {
  test('the password alone yields needs_second_factor and no tokens; a TOTP code completes', async () => {
    const { secret } = await enrolled()
    const waiting = await signIn()
    expect(waiting.step).toEqual({
      status: 'needs_second_factor',
      options: ['totp', 'backup_code'],
    })
    expect(waiting).not.toHaveProperty('session')

    const wrong = await post(`/sign-ins/${waiting.id}/second-factor`, {
      method: 'totp',
      code: '000000',
    })
    expect(await errorOf(wrong)).toMatchObject({ status: 422, code: 'mfa.invalid_code' })

    const done = await json<FlowAttempt>(
      await post(`/sign-ins/${waiting.id}/second-factor`, { method: 'totp', code: codeFor(secret) })
    )
    expect(done.step.status).toBe('complete')
    const claims = claimsOf((done.session as SessionTokens).accessToken)
    expect(claims.amr).toEqual(['pwd', 'otp', 'mfa'])
    expect(claims.auth_time).toBe(Math.floor(deps.clock.now().getTime() / 1000))
  })

  test('a code that signed someone in is refused a second time, until the next step', async () => {
    const { secret } = await enrolled()
    const code = codeFor(secret)
    const first = await signIn()
    expect(
      (await post(`/sign-ins/${first.id}/second-factor`, { method: 'totp', code })).status
    ).toBe(200)
    const again = await signIn()
    expect(
      await errorOf(await post(`/sign-ins/${again.id}/second-factor`, { method: 'totp', code }))
    ).toMatchObject({ code: 'mfa.invalid_code' })
    deps.clock.advance('30s')
    expect(
      (
        await post(`/sign-ins/${again.id}/second-factor`, {
          method: 'totp',
          code: codeFor(secret),
        })
      ).status
    ).toBe(200)
  })

  test('a backup code works once, however it is typed, and says how many are left', async () => {
    const { codes } = await enrolled()
    const waiting = await signIn()
    const typed = ` ${(codes[0] as string).toUpperCase().replace('-', ' ')} `
    const done = await json<FlowAttempt>(
      await post(`/sign-ins/${waiting.id}/second-factor`, { method: 'backup_code', code: typed })
    )
    expect(done.step.status).toBe('complete')
    expect(done.backupCodesRemaining).toBe(9)
    expect(claimsOf((done.session as SessionTokens).accessToken).amr).toEqual([
      'pwd',
      'backup_code',
      'mfa',
    ])
    expect(deps.activityLog.ofType('user.backup_code_used')).toHaveLength(1)

    const again = await signIn()
    expect(
      await errorOf(
        await post(`/sign-ins/${again.id}/second-factor`, { method: 'backup_code', code: codes[0] })
      )
    ).toMatchObject({ code: 'mfa.invalid_code' })
  })

  test('a password reset stops at the second factor too', async () => {
    const { secret } = await enrolled()
    // Past the one-email-a-minute limit of the address the sign-up code went to.
    deps.clock.advance('2m')
    const started = await json<FlowAttempt>(await post('/password-resets', { email: EMAIL }))
    const waiting = await json<FlowAttempt>(
      await post(`/password-resets/${started.id}/password`, {
        code: sentCode(),
        password: 'a brand new passphrase 42',
      })
    )
    expect(waiting.step.status).toBe('needs_second_factor')
    expect(waiting).not.toHaveProperty('session')
    const done = await json<FlowAttempt>(
      await post(`/password-resets/${started.id}/second-factor`, {
        method: 'totp',
        code: codeFor(secret),
      })
    )
    expect(done.step.status).toBe('complete')
    expect(claimsOf((done.session as SessionTokens).accessToken).amr).toEqual([
      'email',
      'otp',
      'mfa',
    ])
  })
})

describe('step-up over HTTP', () => {
  test('a stale session is asked to step up, and the fresh token is accepted', async () => {
    const session = (await signUp()).session as SessionTokens
    deps.clock.advance('11m')
    const fresh = await json<SessionTokens>(
      await post('/sessions/refresh', { refreshToken: session.refreshToken })
    )
    // Refreshing does not make the sign-in recent.
    expect(claimsOf(fresh.accessToken).auth_time).toBe(claimsOf(session.accessToken).auth_time)
    const refused = await post('/me/factors/totp', {}, fresh.accessToken)
    expect(await errorOf(refused)).toEqual({
      status: 403,
      code: 'auth.step_up_required',
      detail: 'Confirm it is you to continue.',
      params: { methods: 'password,email_code' },
    } as never)

    const wrong = await post(
      '/sessions/step-up',
      { method: 'password', password: 'not the password' },
      fresh.accessToken
    )
    expect(await errorOf(wrong)).toMatchObject({ status: 401, code: 'auth.invalid_credentials' })

    const stepped = await post(
      '/sessions/step-up',
      { method: 'password', password: PASSWORD },
      fresh.accessToken
    )
    expect(stepped.status).toBe(200)
    const tokens = await json<SessionTokens>(stepped)
    expect(tokens).not.toHaveProperty('refreshToken')
    expect(claimsOf(tokens.accessToken).auth_time).toBe(
      Math.floor(deps.clock.now().getTime() / 1000)
    )
    expect((await post('/me/factors/totp', {}, tokens.accessToken)).status).toBe(200)
    expect(deps.activityLog.ofType('session.stepped_up')).toHaveLength(1)
  })

  test('a user with a second factor cannot step up with the password alone', async () => {
    const { secret } = await enrolled()
    const waiting = await signIn()
    const done = await json<FlowAttempt>(
      await post(`/sign-ins/${waiting.id}/second-factor`, { method: 'totp', code: codeFor(secret) })
    )
    deps.clock.advance('11m')
    const { accessToken } = await json<SessionTokens>(
      await post('/sessions/refresh', { refreshToken: done.session?.refreshToken })
    )
    const refused = await call('DELETE', '/me/factors/totp', undefined, accessToken)
    expect(await errorOf(refused)).toMatchObject({
      code: 'auth.step_up_required',
      params: { methods: 'totp,backup_code' },
    })
    expect(
      await errorOf(
        await post('/sessions/step-up', { method: 'password', password: PASSWORD }, accessToken)
      )
    ).toMatchObject({ status: 403, code: 'auth.step_up_required' })
    // An MFA user's password change needs the recent second factor as well.
    expect(
      await errorOf(
        await post(
          '/me/password',
          { currentPassword: PASSWORD, newPassword: 'a brand new passphrase 42' },
          accessToken
        )
      )
    ).toMatchObject({ code: 'auth.step_up_required' })

    const stepped = await json<SessionTokens>(
      await post('/sessions/step-up', { method: 'totp', code: codeFor(secret) }, accessToken)
    )
    const turnedOff = await call('DELETE', '/me/factors/totp', undefined, stepped.accessToken)
    expect(turnedOff.status).toBe(204)
    expect(deps.activityLog.ofType('user.mfa_disabled').at(-1)?.data).toEqual({ method: 'self' })
    expect((await signIn()).step.status).toBe('complete')
  })
})

describe('step-up by emailed code over HTTP', () => {
  /** A stale session of a signed-up user: its access token no longer counts as recent. */
  async function stale() {
    const session = (await signUp()).session as SessionTokens
    deps.clock.advance('11m')
    return json<SessionTokens>(
      await post('/sessions/refresh', { refreshToken: session.refreshToken })
    )
  }
  const codeInSubject = () => /^(\d{6}) /.exec(deps.mailer.last().subject)?.[1] ?? ''

  test('asks for a code, steps up with it, and the fresh token is accepted', async () => {
    const { accessToken } = await stale()
    const asked = await post('/sessions/step-up/email-code', undefined, accessToken)
    expect(asked.status).toBe(200)
    expect(asked.headers.get('cache-control')).toBe('no-store')
    const receipt = await json<Record<string, unknown>>(asked)
    expect(receipt).toEqual({
      method: 'email_code',
      destination: 'm***@northline.app',
      expiresAt: new Date(deps.clock.now().getTime() + 600_000).toISOString(),
    })
    const code = codeInSubject()
    expect(code).toMatch(/^\d{6}$/)
    expect(JSON.stringify(receipt)).not.toContain(code)

    const wrong = await post(
      '/sessions/step-up',
      { method: 'email_code', code: code === '000000' ? '111111' : '000000' },
      accessToken
    )
    expect(await errorOf(wrong)).toMatchObject({
      status: 422,
      code: 'verification.invalid_code',
      params: { attemptsRemaining: 4 },
    })

    const stepped = await post('/sessions/step-up', { method: 'email_code', code }, accessToken)
    expect(stepped.status).toBe(200)
    expect(stepped.headers.get('cache-control')).toBe('no-store')
    const tokens = await json<SessionTokens>(stepped)
    expect(tokens).not.toHaveProperty('refreshToken')
    expect(claimsOf(tokens.accessToken).auth_time).toBe(
      Math.floor(deps.clock.now().getTime() / 1000)
    )
    expect(claimsOf(tokens.accessToken).amr).toContain('email')
    expect((await post('/me/factors/totp', {}, tokens.accessToken)).status).toBe(200)
  })

  test('asking twice in a minute is rate limited with a retry time', async () => {
    const { accessToken } = await stale()
    expect((await post('/sessions/step-up/email-code', undefined, accessToken)).status).toBe(200)
    const again = await post('/sessions/step-up/email-code', undefined, accessToken)
    expect(again.status).toBe(429)
    expect(Number(again.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await errorOf(again)).toMatchObject({ code: 'rate_limited' })
  })

  test('a user with a second factor is refused a code and told what to use', async () => {
    const { session } = await enrolled()
    const sent = deps.mailer.outbox.length
    const res = await post('/sessions/step-up/email-code', undefined, session.accessToken)
    expect(await errorOf(res)).toMatchObject({
      status: 403,
      code: 'auth.step_up_required',
      params: { methods: 'totp,backup_code' },
    })
    expect(deps.mailer.outbox).toHaveLength(sent)
    expect(
      await errorOf(
        await post(
          '/sessions/step-up',
          { method: 'email_code', code: '123456' },
          session.accessToken
        )
      )
    ).toMatchObject({ status: 403, code: 'auth.step_up_required' })
  })

  test('a malformed code is a validation error and counts for nothing', async () => {
    const { accessToken } = await stale()
    await post('/sessions/step-up/email-code', undefined, accessToken)
    for (const code of ['12345', '1234567', 'abcdef', '']) {
      const res = await post('/sessions/step-up', { method: 'email_code', code }, accessToken)
      expect([code, res.status]).toEqual([code, 422])
    }
    const stepped = await post(
      '/sessions/step-up',
      { method: 'email_code', code: codeInSubject() },
      accessToken
    )
    expect(stepped.status).toBe(200)
  })

  test('the route is limited per IP', async () => {
    const { accessToken } = await stale()
    let last = 200
    for (let i = 0; i < 12 && last !== 429; i++) {
      deps.clock.advance('1s')
      last = (await post('/sessions/step-up/email-code', undefined, accessToken)).status
    }
    expect(last).toBe(429)
    // Only the first was sent: the others met the cooldown or the route's limit.
    expect(
      deps.mailer.outbox.filter((message) => message.subject.includes('confirmation code'))
    ).toHaveLength(1)
  })
})

describe('admin reset over HTTP', () => {
  test('removes the factor and the codes, ends every session and is recorded with the admin', async () => {
    const { session } = await enrolled()
    const userId = claimsOf(session.accessToken).sub
    const res = await app.request(`/v1/admin/users/${userId}/factors`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${SK}` },
    })
    expect(res.status).toBe(204)
    expect(deps.activityLog.ofType('user.mfa_disabled').at(-1)).toMatchObject({
      actor: { type: 'admin' },
      data: { method: 'admin_reset' },
    })
    expect(
      await deps.sessions.listActiveByUser(TEST_TENANT.environmentId, userId, deps.clock.now())
    ).toEqual([])
    expect((await call('GET', '/me/factors', undefined, session.accessToken)).status).toBe(401)
    expect((await signIn()).step.status).toBe('complete')
  })

  test('a publishable key cannot reset anyone, and an unknown user is 404', async () => {
    const { session } = await enrolled()
    const userId = claimsOf(session.accessToken).sub
    const asClient = await app.request(`/v1/admin/users/${userId}/factors`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${PK}` },
    })
    expect(asClient.status).toBe(401)
    const unknown = await app.request(
      '/v1/admin/users/00000000-0000-7000-8000-0000000000ff/factors',
      { method: 'DELETE', headers: { authorization: `Bearer ${SK}` } }
    )
    expect(unknown.status).toBe(404)
  })
})

/** Replace the environment's settings as an operator would. */
async function setPolicy(policy: 'off' | 'optional' | 'required', revision: number) {
  const res = await app.request('/v1/admin/settings', {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${SK}`,
      'if-match': `"${revision}"`,
    },
    body: JSON.stringify({ mfa: { policy } }),
  })
  expect(res.status).toBe(200)
}

describe('the environment policy over HTTP', () => {
  test('required: a sign-in stops at needs_factor_enrolment, enrols inside the attempt and completes with backup codes', async () => {
    await signUp()
    await setPolicy('required', 0)
    const waiting = await signIn()
    expect(waiting.step).toEqual({ status: 'needs_factor_enrolment', methods: ['totp'] })
    expect(waiting).not.toHaveProperty('session')

    const enrolment = await json<TotpEnrolment>(
      await post(`/sign-ins/${waiting.id}/factor-enrolment/totp`)
    )
    const wrong = await post(`/sign-ins/${waiting.id}/factor-enrolment/totp/confirm`, {
      code: '000000',
    })
    expect(await errorOf(wrong)).toMatchObject({ code: 'mfa.invalid_code' })
    const done = await json<FlowAttempt>(
      await post(`/sign-ins/${waiting.id}/factor-enrolment/totp/confirm`, {
        code: codeFor(enrolment.secret),
      })
    )
    expect(done.step.status).toBe('complete')
    expect(done.backupCodes).toHaveLength(10)
    const { accessToken } = done.session as SessionTokens
    expect(claimsOf(accessToken).amr).toEqual(['pwd', 'otp', 'mfa'])

    // It cannot be turned off while the policy requires it.
    expect(
      await errorOf(await call('DELETE', '/me/factors/totp', undefined, accessToken))
    ).toMatchObject({ status: 403, code: 'mfa.required_by_policy' })
    // The next sign-in asks for the factor instead of an enrolment.
    deps.clock.advance('30s')
    expect((await signIn()).step.status).toBe('needs_second_factor')
  })

  test('required: a sign-up enrols before it completes', async () => {
    await setPolicy('required', 0)
    const started = await json<FlowAttempt>(
      await post('/sign-ups', { email: EMAIL, password: PASSWORD })
    )
    const waiting = await json<FlowAttempt>(
      await post(`/sign-ups/${started.id}/verify-email`, { code: sentCode() })
    )
    expect(waiting.step).toEqual({ status: 'needs_factor_enrolment', methods: ['totp'] })
    expect(waiting).not.toHaveProperty('session')
    expect(deps.activityLog.ofType('session.created')).toEqual([])
    const enrolment = await json<TotpEnrolment>(
      await post(`/sign-ups/${started.id}/factor-enrolment/totp`)
    )
    const done = await json<FlowAttempt>(
      await post(`/sign-ups/${started.id}/factor-enrolment/totp/confirm`, {
        code: codeFor(enrolment.secret),
      })
    )
    expect(done.step.status).toBe('complete')
    expect(claimsOf((done.session as SessionTokens).accessToken).amr).toEqual([
      'email',
      'otp',
      'mfa',
    ])
  })

  test('off: nobody can enrol, but a factor a user already has is still asked for', async () => {
    const { session } = await enrolled()
    await setPolicy('off', 0)
    expect((await signIn()).step.status).toBe('needs_second_factor')
    // The enrolling session proved the factor; a refreshed token says so.
    const { accessToken } = await json<SessionTokens>(
      await post('/sessions/refresh', { refreshToken: session.refreshToken })
    )
    expect(claimsOf(accessToken).amr).toEqual(['email', 'otp', 'mfa'])
    expect((await call('DELETE', '/me/factors/totp', undefined, accessToken)).status).toBe(204)
    const fresh = (await signIn()).session as SessionTokens
    expect(await errorOf(await post('/me/factors/totp', {}, fresh.accessToken))).toMatchObject({
      status: 403,
      code: 'mfa.not_available',
    })
  })
})

describe('nothing secret leaves the two responses that return it', () => {
  /** The newest emailed code: notices land in the outbox too, and they carry none. */
  const emailedCode = () => {
    const message = deps.mailer.outbox.findLast((mail) => /^\d{6} /.test(mail.subject))
    return (message ? /^(\d{6}) /.exec(message.subject)?.[1] : undefined) ?? ''
  }

  test('a whole journey: no log line, audit entry, email or error holds a secret, a URI or a code', async () => {
    const levels = (['debug', 'info', 'warn', 'error'] as const).map((level) =>
      spyOn(logger, level)
    )
    /** Every response of the journey, as the client received it. */
    const responses: { path: string; status: number; text: string }[] = []
    const recorded = async (res: Response, path: string) => {
      responses.push({ path, status: res.status, text: await res.clone().text() })
      return res
    }
    const send = async (method: string, path: string, body?: unknown, accessToken?: string) =>
      recorded(await call(method, path, body, accessToken), path)
    /** Everything that must never be seen outside the response that returned it. */
    const secrets: string[] = []
    const backupCodes: string[] = []
    const totpCodes: string[] = []
    /** The current code of an authenticator, remembered as something that must not leak. */
    const shown = (secret: string) => {
      const code = codeFor(secret)
      totpCodes.push(code)
      return code
    }

    try {
      // Sign up, then enrol from the profile.
      const started = await json<FlowAttempt>(
        await send('POST', '/sign-ups', { email: EMAIL, password: PASSWORD })
      )
      const signedUp = await json<FlowAttempt>(
        await send('POST', `/sign-ups/${started.id}/verify-email`, { code: emailedCode() })
      )
      let accessToken = (signedUp.session as SessionTokens).accessToken
      const enrolment = await json<TotpEnrolment>(
        await send('POST', '/me/factors/totp', {}, accessToken)
      )
      secrets.push(enrolment.secret, enrolment.uri)
      for (const wrong of ['000000', '999999']) {
        await send('POST', '/me/factors/totp/confirm', { code: wrong }, accessToken)
      }
      const confirmed = await json<BackupCodes>(
        await send(
          'POST',
          '/me/factors/totp/confirm',
          { code: shown(enrolment.secret) },
          accessToken
        )
      )
      backupCodes.push(...confirmed.codes)
      await Notices.settled()

      // Sign in with the authenticator: a wrong code, then the right one.
      deps.clock.advance('30s')
      const withTotp = await signIn()
      await send('POST', `/sign-ins/${withTotp.id}/second-factor`, {
        method: 'totp',
        code: '000000',
      })
      const signedIn = await json<FlowAttempt>(
        await send('POST', `/sign-ins/${withTotp.id}/second-factor`, {
          method: 'totp',
          code: shown(enrolment.secret),
        })
      )
      accessToken = (signedIn.session as SessionTokens).accessToken

      // Sign in with a backup code: a wrong one, then a right one, then that one again.
      const withBackup = await signIn()
      await send('POST', `/sign-ins/${withBackup.id}/second-factor`, {
        method: 'backup_code',
        code: 'zzzzz-zzzzz',
      })
      await send('POST', `/sign-ins/${withBackup.id}/second-factor`, {
        method: 'backup_code',
        code: confirmed.codes[0],
      })
      const replay = await signIn()
      await send('POST', `/sign-ins/${replay.id}/second-factor`, {
        method: 'backup_code',
        code: (confirmed.codes[0] as string).toUpperCase(),
      })
      await Notices.settled()

      // Step up: the password (refused), a wrong code, the right code.
      deps.clock.advance('11m')
      const refreshed = await json<SessionTokens>(
        await send('POST', '/sessions/refresh', {
          refreshToken: (signedIn.session as SessionTokens).refreshToken,
        })
      )
      await send(
        'POST',
        '/sessions/step-up',
        { method: 'password', password: PASSWORD },
        refreshed.accessToken
      )
      await send(
        'POST',
        '/sessions/step-up',
        { method: 'totp', code: '000000' },
        refreshed.accessToken
      )
      const stepped = await json<SessionTokens>(
        await send(
          'POST',
          '/sessions/step-up',
          { method: 'totp', code: shown(enrolment.secret) },
          refreshed.accessToken
        )
      )
      accessToken = stepped.accessToken

      // New backup codes, then turn it off, turn it on again, and have an admin reset it.
      const regenerated = await json<BackupCodes>(
        await send('POST', '/me/factors/backup-codes', {}, accessToken)
      )
      backupCodes.push(...regenerated.codes)
      await send('GET', '/me/factors', undefined, accessToken)
      await Notices.settled()
      // Past the hourly allowance of notices, so the next changes are announced too; the
      // session then has to prove the factor again before it may turn it off.
      deps.clock.advance('61m')
      const later = await json<SessionTokens>(
        await send('POST', '/sessions/refresh', { refreshToken: refreshed.refreshToken })
      )
      accessToken = (
        await json<SessionTokens>(
          await send(
            'POST',
            '/sessions/step-up',
            { method: 'totp', code: shown(enrolment.secret) },
            later.accessToken
          )
        )
      ).accessToken
      expect((await send('DELETE', '/me/factors/totp', undefined, accessToken)).status).toBe(204)
      const again = await json<TotpEnrolment>(
        await send('POST', '/me/factors/totp', {}, accessToken)
      )
      secrets.push(again.secret, again.uri)
      const reconfirmed = await json<BackupCodes>(
        await send('POST', '/me/factors/totp/confirm', { code: shown(again.secret) }, accessToken)
      )
      backupCodes.push(...reconfirmed.codes)
      await Notices.settled()
      const userId = claimsOf(accessToken).sub
      const reset = await app.request(`/v1/admin/users/${userId}/factors`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${SK}` },
      })
      expect(reset.status).toBe(204)
      await Notices.settled()

      // Where the environment requires it: enrol inside a sign-in.
      await setPolicy('required', 0)
      deps.clock.advance('61m')
      const required = await signIn()
      const inFlow = await json<TotpEnrolment>(
        await send('POST', `/sign-ins/${required.id}/factor-enrolment/totp`)
      )
      secrets.push(inFlow.secret, inFlow.uri)
      await send('POST', `/sign-ins/${required.id}/factor-enrolment/totp/confirm`, {
        code: '000000',
      })
      const completed = await json<FlowAttempt>(
        await send('POST', `/sign-ins/${required.id}/factor-enrolment/totp/confirm`, {
          code: shown(inFlow.secret),
        })
      )
      backupCodes.push(...(completed.backupCodes ?? []))
      await Notices.settled()

      // The journey really did all of that.
      expect(secrets).toHaveLength(6)
      expect(backupCodes).toHaveLength(40)
      expect(totpCodes).toHaveLength(6)
      expect(deps.activityLog.ofType('user.mfa_enabled')).toHaveLength(3)
      expect(deps.activityLog.ofType('user.mfa_disabled')).toHaveLength(2)
      expect(deps.activityLog.ofType('user.backup_code_used')).toHaveLength(1)
      expect(deps.activityLog.ofType('user.backup_codes_regenerated')).toHaveLength(1)
      expect(deps.activityLog.ofType('session.stepped_up').length).toBeGreaterThanOrEqual(2)
      expect(responses.filter((response) => response.status >= 400).length).toBeGreaterThan(6)

      /** Fail if `text` holds anything that must stay secret. */
      const expectClean = (where: string, text: string, allow: readonly string[] = []) => {
        const haystack = text.toLowerCase()
        const leaked: string[] = []
        if (haystack.includes('otpauth') && !allow.includes('secret')) {
          leaked.push('an otpauth URI')
        }
        for (const secret of secrets) {
          if (haystack.includes(secret.toLowerCase()) && !allow.includes('secret')) {
            leaked.push('a TOTP secret')
          }
        }
        for (const code of backupCodes) {
          if (
            (haystack.includes(code) || haystack.includes(code.replace('-', ''))) &&
            !allow.includes('backup')
          ) {
            leaked.push('a backup code')
          }
        }
        for (const code of totpCodes) {
          // As a number of its own: a longer run of digits (a timestamp) is not the code.
          if (new RegExp(`(?<!\\d)${code}(?!\\d)`).test(haystack)) {
            leaked.push('a TOTP code')
          }
        }
        expect({ where, leaked }).toEqual({ where, leaked: [] })
      }

      const lines = levels.flatMap((level) => level.mock.calls.map((call) => JSON.stringify(call)))
      // At least a request line per call, so the check is not vacuous.
      expect(lines.length).toBeGreaterThan(responses.length - 1)
      for (const line of lines) {
        expectClean('a log line', line)
      }
      expect(deps.activityLog.entries.length).toBeGreaterThan(15)
      for (const entry of deps.activityLog.entries) {
        expectClean(`the ${entry.type} audit entry`, JSON.stringify(entry))
      }
      // The sign-up code and seven notices about two-step verification.
      expect(deps.mailer.outbox).toHaveLength(8)
      for (const message of deps.mailer.outbox) {
        expectClean(`the email "${message.subject}"`, JSON.stringify(message))
      }
      // Only the responses that hand a secret or the codes over contain them, and only on
      // success; every other response, and every error, holds none.
      const START = /\/totp$/
      const CODES = /\/totp\/confirm$|\/backup-codes$/
      const returned = { secret: 0, backup: 0 }
      for (const { path, status, text } of responses) {
        const allow =
          status === 200 && START.test(path)
            ? ['secret']
            : status === 200 && CODES.test(path)
              ? ['backup']
              : []
        expectClean(`the ${status} response of ${path}`, text, allow)
        if (allow[0] === 'secret') {
          returned.secret += 1
          expect(secrets.filter((secret) => text.includes(secret))).toHaveLength(2)
          expect(Object.keys(JSON.parse(text)).sort()).toEqual(['secret', 'uri'])
        }
        if (allow[0] === 'backup') {
          returned.backup += 1
          expect(backupCodes.filter((code) => text.includes(code))).toHaveLength(10)
        }
      }
      expect(returned).toEqual({ secret: 3, backup: 4 })
      // The stored attempts hold none of it either.
      for (const attemptId of [withTotp.id, withBackup.id, replay.id, required.id]) {
        expectClean(
          'a stored flow attempt',
          JSON.stringify(await deps.flowAttempts.findById(TEST_TENANT.environmentId, attemptId))
        )
      }
    } finally {
      for (const level of levels) {
        level.mockRestore()
      }
    }
  })
})

describe('the MFA routes: validation, caching and limits', () => {
  test.each<[string, unknown]>([
    ['a five-digit code', { code: '12345' }],
    ['a seven-digit code', { code: '1234567' }],
    ['letters', { code: 'abcdef' }],
    ['a number', { code: 123456 }],
    ['no code', {}],
  ])('confirming with %s is a validation error, and no guess is counted', async (_, body) => {
    const session = (await signUp()).session as SessionTokens
    await post('/me/factors/totp', {}, session.accessToken)
    const counted = spyOn(deps.lockout, 'attempt')
    try {
      const res = await post('/me/factors/totp/confirm', body, session.accessToken)
      expect(await errorOf(res)).toMatchObject({ status: 422, code: 'validation.failed' })
      expect(counted).not.toHaveBeenCalled()
    } finally {
      counted.mockRestore()
    }
  })

  test('confirming with nothing started is 410, and a second confirmation is 409', async () => {
    const session = (await signUp()).session as SessionTokens
    expect(
      await errorOf(await post('/me/factors/totp/confirm', { code: '123456' }, session.accessToken))
    ).toMatchObject({ status: 410, code: 'mfa.enrolment_expired' })
    const enrolment = await json<TotpEnrolment>(
      await post('/me/factors/totp', {}, session.accessToken)
    )
    const code = codeFor(enrolment.secret)
    expect((await post('/me/factors/totp/confirm', { code }, session.accessToken)).status).toBe(200)
    expect(
      await errorOf(await post('/me/factors/totp/confirm', { code }, session.accessToken))
    ).toMatchObject({ status: 409, code: 'mfa.already_enabled' })
    await Notices.settled()
  })

  test('responses that carry a secret, the codes or what is enrolled are never cacheable', async () => {
    const { session } = await enrolled()
    const { accessToken } = await json<SessionTokens>(
      await post('/sessions/refresh', { refreshToken: session.refreshToken })
    )
    const status = await call('GET', '/me/factors', undefined, accessToken)
    expect(status.headers.get('cache-control')).toBe('no-store')
    const regenerated = await post('/me/factors/backup-codes', {}, accessToken)
    expect(regenerated.status).toBe(200)
    expect(regenerated.headers.get('cache-control')).toBe('no-store')
    expect((await json<BackupCodes>(regenerated)).codes).toHaveLength(10)
    expect(deps.activityLog.ofType('user.backup_codes_regenerated')).toHaveLength(1)
    await Notices.settled()
  })

  test('new backup codes and turning it off answer 409 when nothing is on', async () => {
    const session = (await signUp()).session as SessionTokens
    expect(
      await errorOf(await post('/me/factors/backup-codes', {}, session.accessToken))
    ).toMatchObject({ status: 409, code: 'mfa.not_enabled' })
    expect(
      await errorOf(await call('DELETE', '/me/factors/totp', undefined, session.accessToken))
    ).toMatchObject({ status: 409, code: 'mfa.not_enabled' })
  })

  test.each<[string, string]>([
    ['POST', '/me/factors/totp'],
    ['POST', '/me/factors/totp/confirm'],
    ['DELETE', '/me/factors/totp'],
    ['POST', '/me/factors/backup-codes'],
  ])('%s %s is limited per IP, ahead of the token check', async (method, path) => {
    const body = method === 'POST' ? { code: '123456' } : undefined
    for (let index = 0; index < MFA_RATE_LIMIT; index++) {
      expect((await call(method, path, body)).status).toBe(401)
    }
    const limited = await call(method, path, body)
    expect(limited.status).toBe(429)
    expect(await errorOf(limited)).toMatchObject({ code: 'rate_limited' })
    expect(limited.headers.get('retry-after')).not.toBeNull()
    deps.clock.advance('1m')
    expect((await call(method, path, body)).status).toBe(401)
  })

  test('the admin reset validates the user id and needs a secret key of this environment', async () => {
    const malformed = await app.request('/v1/admin/users/not-a-uuid/factors', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${SK}` },
    })
    expect(malformed.status).toBe(422)
    const { session } = await enrolled()
    const userId = claimsOf(session.accessToken).sub
    const keyless = await app.request(`/v1/admin/users/${userId}/factors`, { method: 'DELETE' })
    expect(keyless.status).toBe(401)
    // A signed-in user's access token is not an admin credential.
    const asUser = await app.request(`/v1/admin/users/${userId}/factors`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${session.accessToken}` },
    })
    expect(asUser.status).toBe(401)
    expect(deps.activityLog.ofType('user.mfa_disabled')).toEqual([])
    expect(
      await json<Factors>(await call('GET', '/me/factors', undefined, session.accessToken))
    ).toMatchObject({ totp: { enabled: true } })
  })

  test('one user cannot read or change another’s factors: every route acts on the token’s user', async () => {
    const { session, codes } = await enrolled()
    // A second account, signed up after the first.
    deps.clock.advance('2m')
    const started = await json<FlowAttempt>(
      await post('/sign-ups', { email: 'other@northline.app', password: PASSWORD })
    )
    const other = (
      await json<FlowAttempt>(
        await post(`/sign-ups/${started.id}/verify-email`, {
          code: /^(\d{6}) /.exec(deps.mailer.last().subject)?.[1] ?? '',
        })
      )
    ).session as SessionTokens
    expect(
      await json<Factors>(await call('GET', '/me/factors', undefined, other.accessToken))
    ).toEqual({ totp: { enabled: false, confirmedAt: null }, backupCodes: { remaining: 0 } })
    expect(
      await errorOf(await call('DELETE', '/me/factors/totp', undefined, other.accessToken))
    ).toMatchObject({ code: 'mfa.not_enabled' })
    // The first user's backup code is not a step-up proof for the second.
    expect(
      await errorOf(
        await post(
          '/sessions/step-up',
          { method: 'backup_code', code: codes[0] },
          other.accessToken
        )
      )
    ).toMatchObject({ code: 'auth.step_up_required', params: { methods: 'password,email_code' } })
    const { accessToken } = await json<SessionTokens>(
      await post('/sessions/refresh', { refreshToken: session.refreshToken })
    )
    expect(
      await json<Factors>(await call('GET', '/me/factors', undefined, accessToken))
    ).toMatchObject({ totp: { enabled: true }, backupCodes: { remaining: 10 } })
  })
})
