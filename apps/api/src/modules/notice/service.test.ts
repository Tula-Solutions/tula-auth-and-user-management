import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { DEFAULT_ENVIRONMENT_SETTINGS, type FlowAttempt } from '@tula/contract'
import type { Tenant } from '~/dependencies'
import { ServiceException } from '~/exceptions'
import * as logger from '~/lib/logger'
import * as Factors from '~/modules/factor/service'
import * as Flows from '~/modules/flow/service'
import * as Notices from '~/modules/notice/service'
import * as Sessions from '~/modules/session/service'
import * as Users from '~/modules/user/service'
import * as Verification from '~/modules/verification/service'
import type { MailMessage } from '~/ports/mailer'
import type { RateLimiter } from '~/ports/rate-limiter'
import { createTestDeps, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

const tenant: Tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const EMAIL = 'Maya@Northline.app'
const PASSWORD = 'correct horse battery staple'
const NEW_PASSWORD = 'an entirely new passphrase'
const SIGN_IN_SUBJECT = 'New sign-in to your Tula account'
const CHANGED_SUBJECT = 'Your Tula password was changed'
const ADDED_SUBJECT = 'A password was added to your Tula account'

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const CHROME_WINDOWS_UPDATED = CHROME_WINDOWS.replace('140.0.0.0', '141.0.7000.2')
const FIREFOX_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:130.0) Gecko/20100101 Firefox/130.0'
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
const EDGE_LINUX = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0`
const OPERA_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36 OPR/110.0'

function from(userAgent: string | null, client: Flows.ClientContext['client'] = 'web') {
  return { client, userAgent, ipAddress: '203.0.113.7', originAllowed: true }
}
const home = from(CHROME_WINDOWS)

type Presented = Pick<FlowAttempt, 'id' | 'attemptSecret'>
const ref = (attempt: Presented): Flows.AttemptRef => ({
  id: attempt.id,
  secret: attempt.attemptSecret,
})

let deps: TestDeps
let spies: ReturnType<typeof spyOn>[] = []

function build(overrides: Parameters<typeof createTestDeps>[0] = {}) {
  deps = createTestDeps(overrides)
  deps.environments.add({
    id: tenant.environmentId,
    projectId: tenant.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
}

beforeEach(() => build())
afterEach(async () => {
  await Notices.settled()
  for (const spy of spies) {
    spy.mockRestore()
  }
  spies = []
})

/** Every email sent so far with this subject, once the notices under way have finished. */
async function sent(subject: string): Promise<MailMessage[]> {
  await Notices.settled()
  return deps.mailer.outbox.filter((message) => message.subject === subject)
}

function latestCode(): string {
  const code = deps.mailer.outbox
    .map((message) => /^(\d{6})\b/.exec(message.subject)?.[1])
    .findLast((found) => found !== undefined)
  if (!code) {
    throw new Error('no email with a code was sent')
  }
  return code
}

/** Create a verified user through the real sign-up flow, from the "home" device. */
async function registered(ctx = home) {
  const started = await Flows.signUp(deps, tenant, { email: EMAIL, password: PASSWORD }, ctx)
  const done = await Flows.verifyEmail(
    deps,
    tenant,
    'sign_up',
    ref(started.attempt),
    latestCode(),
    ctx
  )
  deps.clock.advance(Verification.RESEND_COOLDOWN)
  if (done.attempt.step.status !== 'complete' || !done.tokens) {
    throw new Error('sign-up did not complete')
  }
  return { userId: done.attempt.step.userId, sessionId: done.tokens.sessionId }
}

async function signIn(ctx: Flows.ClientContext, password = PASSWORD) {
  const { attempt } = await Flows.signIn(deps, tenant, { identifier: EMAIL }, ctx)
  return Flows.submitPassword(deps, tenant, ref(attempt), password, ctx)
}

async function resetPassword(ctx: Flows.ClientContext, password = NEW_PASSWORD) {
  const { attempt } = await Flows.startPasswordReset(deps, tenant, { email: EMAIL }, ctx)
  return Flows.resetPassword(deps, tenant, ref(attempt), { code: latestCode(), password }, ctx)
}

function settings(notifications: Partial<(typeof DEFAULT_ENVIRONMENT_SETTINGS)['notifications']>) {
  deps.environmentSettings.seed(tenant.environmentId, {
    revision: 1,
    settings: {
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      notifications: { ...DEFAULT_ENVIRONMENT_SETTINGS.notifications, ...notifications },
    },
  })
}

/** A limiter that cannot count notices (Redis is down), and counts everything else. */
function brokenNoticeLimiter(inner: RateLimiter): RateLimiter {
  return {
    hit: async (key, limit, windowMs) => {
      if (key.startsWith('notice_')) {
        throw Object.assign(new Error('connect ECONNREFUSED redis:6379'), { code: 'ECONNREFUSED' })
      }
      return inner.hit(key, limit, windowMs)
    },
  }
}

/** What reaches the log, as one string. */
function logged(...levels: ('warn' | 'info' | 'error')[]) {
  const made = levels.map((level) => spyOn(logger, level).mockImplementation(() => {}))
  spies.push(...made)
  return () => JSON.stringify(made.flatMap((spy) => spy.mock.calls))
}

function expectNothingSensitive(message: MailMessage, userAgent?: string) {
  const everything = `${message.subject}\n${message.text}\n${message.html}`
  expect(everything).not.toContain('tula_')
  expect(everything).not.toMatch(/https?:/)
  expect(message.html).not.toContain('<a ')
  expect(`${message.subject}\n${message.text}`).not.toMatch(/\b\d{6}\b/)
  expect(message.subject).not.toMatch(/^\d/)
  if (userAgent) {
    expect(everything).not.toContain(userAgent)
    expect(everything).not.toContain('Mozilla')
  }
}

describe('new sign-in notice', () => {
  test('a sign-in from a device family the account has not been seen on is announced', async () => {
    await registered()
    const done = await signIn(from(FIREFOX_MAC))
    expect(done.attempt.step.status).toBe('complete')

    const [notice, ...more] = await sent(SIGN_IN_SUBJECT)
    expect(more).toEqual([])
    expect(notice?.to).toBe(EMAIL)
    expect(notice?.text).toContain(
      `Device: Firefox on macOS\nWhen: ${deps.clock.now().toISOString().slice(0, 10)} `
    )
    expect(notice?.text).toMatch(
      /When: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\nIP address: 203\.0\.113\.7\n/
    )
    expect(notice?.text).toContain("If it wasn't you, open Tula and reset your password")
    expectNothingSensitive(notice as MailMessage, FIREFOX_MAC)
  })

  test('the session a sign-up ends in is never announced', async () => {
    await registered()
    expect(await sent(SIGN_IN_SUBJECT)).toEqual([])
    expect(deps.mailer.outbox).toHaveLength(1)
  })

  test('the first-ever session of an account is never announced', async () => {
    await Users.create(
      deps,
      tenant,
      { email: EMAIL, password: PASSWORD, emailVerified: true },
      TEST_ACTOR
    )
    expect((await signIn(from(FIREFOX_MAC))).attempt.step.status).toBe('complete')
    expect(await sent(SIGN_IN_SUBJECT)).toEqual([])
    expect(deps.mailer.outbox).toEqual([])
  })

  test('the same family again is not announced, whatever the browser version', async () => {
    await registered()
    await signIn(from(CHROME_WINDOWS_UPDATED))
    await signIn(home)
    expect(await sent(SIGN_IN_SUBJECT)).toEqual([])
  })

  test('a new family is announced once: the next sign-in from it is known', async () => {
    await registered()
    await signIn(from(FIREFOX_MAC))
    expect(await sent(SIGN_IN_SUBJECT)).toHaveLength(1)
    await signIn(from(FIREFOX_MAC))
    await signIn(from(FIREFOX_MAC.replace('130.0', '131.0')))
    expect(await sent(SIGN_IN_SUBJECT)).toHaveLength(1)
  })

  test('a family seen only on a session that has ended is still known', async () => {
    const { userId } = await registered()
    await Sessions.revokeAllForUser(deps, tenant, userId, 'revoked_by_admin', TEST_ACTOR)
    deps.clock.advance('8d')
    await signIn(home)
    expect(await sent(SIGN_IN_SUBJECT)).toEqual([])
  })

  test.each<[string, Flows.ClientContext, string]>([
    ['a native app', from('NorthlineApp/3.1 CFNetwork/1568 Darwin/24', 'ios'), 'Device: iOS app\n'],
    ['an Android app', from('okhttp/4.12.0', 'android'), 'Device: Android app\n'],
    ['a client that sends no user agent', from(null), 'Device: Unknown device\n'],
    ['a phone browser', from(SAFARI_IPHONE), 'Device: Safari on iPhone\n'],
  ])('%s is named by its family', async (_, ctx, line) => {
    await registered()
    await signIn(ctx)
    const [notice] = await sent(SIGN_IN_SUBJECT)
    expect(notice?.text).toContain(line)
  })

  test('a hostile user agent never reaches the email: only the family derived from it', async () => {
    await registered()
    const hostile =
      'Firefox/1.0 (Macintosh)</p><script>alert(1)</script>\r\nBcc: attacker@evil.test\r\n\r\n<a href="https://evil.test">sign in</a> tula_sk_live_x 123456'
    await signIn(from(hostile))
    const [notice] = await sent(SIGN_IN_SUBJECT)
    expect(notice?.text).toContain('Device: Firefox on macOS\n')
    expect(notice?.subject).toBe(SIGN_IN_SUBJECT)
    for (const part of [notice?.subject, notice?.text, notice?.html]) {
      expect(part).not.toMatch(/script|evil|Bcc|\r/)
    }
    expectNothingSensitive(notice as MailMessage, hostile)
  })

  test('the address is left out when the session has none', async () => {
    await registered()
    await signIn({ ...from(FIREFOX_MAC), ipAddress: 'not an address' })
    const [notice] = await sent(SIGN_IN_SUBJECT)
    expect(notice?.text).toContain('Device: Firefox on macOS\nWhen: ')
    expect(notice?.text).not.toContain('IP address')
  })

  test.each<[string, string]>([
    ['::ffff:198.51.100.24', 'IP address: 198.51.100.24\n'],
    ['2001:db8::7', 'IP address: 2001:db8::7\n'],
  ])('the address %s is shown as its owner knows it', async (ipAddress, line) => {
    await registered()
    await signIn({ ...from(FIREFOX_MAC), ipAddress })
    const [notice] = await sent(SIGN_IN_SUBJECT)
    expect(notice?.text).toContain(line)
  })

  test('a failed sign-in from a new device announces nothing', async () => {
    await registered()
    const error = await signIn(from(FIREFOX_MAC), 'not the password').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ServiceException)
    expect(await sent(SIGN_IN_SUBJECT)).toEqual([])
    expect(deps.mailer.outbox).toHaveLength(1)
  })

  test('a sign-in stopped at a second factor announces nothing until the factor is proven', async () => {
    const { userId } = await registered()
    await Sessions.revokeAllForUser(deps, tenant, userId, 'revoked_by_admin', TEST_ACTOR)
    spies.push(
      spyOn(Factors, 'requiredFor').mockResolvedValue(['totp']),
      spyOn(Factors, 'verify').mockImplementation(
        async (_d, _t, _u, proof) => proof.response === 'good'
      )
    )
    const ctx = from(FIREFOX_MAC)
    const { attempt } = await Flows.signIn(deps, tenant, { identifier: EMAIL }, ctx)
    const waiting = await Flows.submitPassword(deps, tenant, ref(attempt), PASSWORD, ctx)
    expect(waiting.attempt.step.status).toBe('needs_second_factor')
    expect(waiting.tokens).toBeUndefined()
    const wrong = { method: 'totp', response: 'bad' } as const
    await Flows.submitSecondFactor(deps, tenant, 'sign_in', ref(attempt), wrong, ctx).catch(
      () => {}
    )
    expect(
      await deps.sessions.listActiveByUser(tenant.environmentId, userId, deps.clock.now())
    ).toEqual([])
    expect(await sent(SIGN_IN_SUBJECT)).toEqual([])

    const proof = { method: 'totp', response: 'good' } as const
    const done = await Flows.submitSecondFactor(deps, tenant, 'sign_in', ref(attempt), proof, ctx)
    expect(done.attempt.step.status).toBe('complete')
    expect(await sent(SIGN_IN_SUBJECT)).toHaveLength(1)
  })

  test('of two sign-ins racing from the same new device, one is announced', async () => {
    await registered()
    const [x, y] = await Promise.all([signIn(from(FIREFOX_MAC)), signIn(from(FIREFOX_MAC))])
    expect([x.attempt.step.status, y.attempt.step.status]).toEqual(['complete', 'complete'])
    expect(await sent(SIGN_IN_SUBJECT)).toHaveLength(1)
  })

  test('a request that lost the race for an attempt creates no session and announces nothing', async () => {
    await registered()
    const ctx = from(FIREFOX_MAC)
    const { attempt } = await Flows.signIn(deps, tenant, { identifier: EMAIL }, ctx)
    const results = await Promise.allSettled([
      Flows.submitPassword(deps, tenant, ref(attempt), PASSWORD, ctx),
      Flows.submitPassword(deps, tenant, ref(attempt), PASSWORD, ctx),
    ])
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(await sent(SIGN_IN_SUBJECT)).toHaveLength(1)
  })

  test('the sign-in a password reset ends in is announced by the password notice only', async () => {
    await registered()
    expect((await resetPassword(from(FIREFOX_MAC))).attempt.step.status).toBe('complete')
    expect(await sent(SIGN_IN_SUBJECT)).toEqual([])
    expect(await sent(CHANGED_SUBJECT)).toHaveLength(1)
    // The device is known from then on.
    await signIn(from(FIREFOX_MAC), NEW_PASSWORD)
    expect(await sent(SIGN_IN_SUBJECT)).toEqual([])
  })

  test('nothing is sent when the environment has the notice switched off', async () => {
    await registered()
    settings({ newSignIn: false })
    await signIn(from(FIREFOX_MAC))
    expect(await sent(SIGN_IN_SUBJECT)).toEqual([])
  })

  test('at most three an hour per user, however many new devices sign in', async () => {
    await registered()
    const read = logged('info')
    for (const agent of [FIREFOX_MAC, SAFARI_IPHONE, EDGE_LINUX, OPERA_MAC]) {
      expect((await signIn(from(agent))).attempt.step.status).toBe('complete')
      await Notices.settled()
    }
    expect(await sent(SIGN_IN_SUBJECT)).toHaveLength(Notices.NOTICES_PER_HOUR)
    expect(read()).toContain('security notice skipped')
    expect(read()).not.toMatch(/northline/i)

    // The fourth device is known by now; a fifth, an hour later, is announced again.
    deps.clock.advance(Notices.NOTICE_WINDOW_MS)
    await signIn(from('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) Chrome/140.0 Safari/537.36'))
    expect(await sent(SIGN_IN_SUBJECT)).toHaveLength(Notices.NOTICES_PER_HOUR + 1)
  })

  test('the allowance is the user’s own and is not the one codes are sent under', async () => {
    await registered()
    for (const agent of [FIREFOX_MAC, SAFARI_IPHONE, EDGE_LINUX, OPERA_MAC]) {
      await signIn(from(agent))
      await Notices.settled()
    }
    // Notices used up: a reset code and the password notice are still sent.
    const before = deps.mailer.outbox.length
    expect((await resetPassword(home)).attempt.step.status).toBe('complete')
    await Notices.settled()
    expect(deps.mailer.outbox.slice(before).map((message) => message.subject)).toEqual([
      expect.stringMatching(/^\d{6} is your Tula password reset code$/),
      CHANGED_SUBJECT,
    ])
  })

  test('a relay that is down does not fail the sign-in, and the log has no address', async () => {
    await registered()
    const read = logged('warn')
    spies.push(
      spyOn(deps.mailer, 'send').mockRejectedValue(
        Object.assign(new Error(`550 <${EMAIL}>: recipient rejected`), {
          code: 'EENVELOPE',
          responseCode: 550,
        })
      )
    )
    const done = await signIn(from(FIREFOX_MAC))
    expect(done.attempt.step.status).toBe('complete')
    expect(done.tokens?.accessToken).toEqual(expect.any(String))
    await Notices.settled()
    expect(read()).toContain('"reason":"Error EENVELOPE 550"')
    expect(read()).toContain('"notice":"new_sign_in"')
    expect(read()).not.toMatch(/northline|rejected/i)
  })

  test('a relay that hangs does not delay the sign-in', async () => {
    await registered()
    let release = () => {}
    const hung = new Promise<void>((resolve) => {
      release = resolve
    })
    spies.push(spyOn(deps.mailer, 'send').mockImplementation(() => hung))
    // Resolves although the relay has not answered.
    expect((await signIn(from(FIREFOX_MAC))).attempt.step.status).toBe('complete')
    release()
    await Notices.settled()
  })

  test('a limiter that cannot count means no notice, and the sign-in still completes', async () => {
    await registered()
    deps.rateLimiter = brokenNoticeLimiter(deps.rateLimiter) as TestDeps['rateLimiter']
    const read = logged('warn')
    const done = await signIn(from(FIREFOX_MAC))
    expect(done.attempt.step.status).toBe('complete')
    expect(await sent(SIGN_IN_SUBJECT)).toEqual([])
    expect(read()).toContain('"reason":"Error ECONNREFUSED"')
  })

  test('a store that fails while the notice is decided does not fail the sign-in', async () => {
    await registered()
    const read = logged('warn')
    spies.push(spyOn(deps.sessions, 'listDevicesBefore').mockRejectedValue(new Error(EMAIL)))
    expect((await signIn(from(FIREFOX_MAC))).attempt.step.status).toBe('complete')
    expect(await sent(SIGN_IN_SUBJECT)).toEqual([])
    expect(read()).toContain('security notice not sent')
    expect(read()).not.toMatch(/northline/i)
  })

  test('a session or user that is gone by the time the notice is decided sends nothing', async () => {
    const { userId, sessionId } = await registered()
    Notices.newSignIn(deps, tenant, { userId, sessionId: '00000000-0000-7000-8000-00000000dead' })
    Notices.newSignIn(deps, tenant, { userId: '00000000-0000-7000-8000-00000000dead', sessionId })
    spies.push(spyOn(deps.users, 'findById').mockResolvedValue(null))
    await signIn(from(FIREFOX_MAC))
    expect(await sent(SIGN_IN_SUBJECT)).toEqual([])
  })

  test('one environment’s sessions say nothing about another’s', async () => {
    const { userId, sessionId } = await registered()
    const other = { ...tenant, environmentId: TEST_TENANT.productionEnvironmentId }
    Notices.newSignIn(deps, other, { userId, sessionId })
    expect(await sent(SIGN_IN_SUBJECT)).toEqual([])
  })
})

describe('password notice', () => {
  const change = (userId: string, sessionId: string, input = {}) =>
    Users.changePassword(
      deps,
      tenant,
      { userId, sessionId },
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, ...input }
    )

  test('the user changing their own password is told so', async () => {
    const { userId, sessionId } = await registered()
    await change(userId, sessionId)
    const [notice, ...more] = await sent(CHANGED_SUBJECT)
    expect(more).toEqual([])
    expect(notice?.to).toBe(EMAIL)
    expect(notice?.text).toContain(
      'The password for your Tula account was changed by someone signed in to it. Every other device was signed out.'
    )
    expect(notice?.text).toMatch(/When: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/)
    expect(notice?.text).toContain('open Tula and reset your password from the sign-in screen')
    expectNothingSensitive(notice as MailMessage)
    expect(`${notice?.text}${notice?.html}`).not.toContain(NEW_PASSWORD)
  })

  test('a completed password reset is told so', async () => {
    await registered()
    await resetPassword(home)
    const [notice, ...more] = await sent(CHANGED_SUBJECT)
    expect(more).toEqual([])
    expect(notice?.text).toContain(
      'The password for your Tula account was reset, using a code sent to this email address.'
    )
    expectNothingSensitive(notice as MailMessage)
  })

  test('an administrator setting the password is told so, with the support address when set', async () => {
    const { userId } = await registered()
    deps.environmentSettings.seed(tenant.environmentId, {
      revision: 1,
      settings: {
        ...DEFAULT_ENVIRONMENT_SETTINGS,
        app: { name: 'Acme', supportEmail: 'help@acme.test' },
      },
    })
    await Users.setPassword(deps, tenant, userId, NEW_PASSWORD, TEST_ACTOR)
    const [notice, ...more] = await sent('Your Acme password was changed')
    expect(more).toEqual([])
    expect(notice?.text).toContain('An administrator of Acme set a new password for your account.')
    expect(notice?.text).toContain(
      'If you cannot get back in to your account, contact help@acme.test.'
    )
    expectNothingSensitive(notice as MailMessage)
  })

  test('a first password on an account that had none says a password was added', async () => {
    const user = await Users.create(deps, tenant, { email: EMAIL, emailVerified: true }, TEST_ACTOR)
    await Users.setPassword(deps, tenant, user.id, PASSWORD, TEST_ACTOR)
    const [byAdmin] = await sent(ADDED_SUBJECT)
    expect(byAdmin?.text).toContain('An administrator of Tula added a password to your account.')
    expect(await sent(CHANGED_SUBJECT)).toEqual([])
  })

  test('a first password set through a reset says a password was added', async () => {
    await Users.create(deps, tenant, { email: EMAIL, emailVerified: true }, TEST_ACTOR)
    await resetPassword(home)
    const [byReset, ...more] = await sent(ADDED_SUBJECT)
    expect(more).toEqual([])
    expect(byReset?.text).toContain(
      'A password was added to your Tula account, using a code sent to this email address.'
    )
    expectNothingSensitive(byReset as MailMessage)
  })

  test('a reset stopped at a second factor has stored the password, so it is announced', async () => {
    await registered()
    spies.push(spyOn(Factors, 'requiredFor').mockResolvedValue(['totp']))
    const waiting = await resetPassword(from(FIREFOX_MAC))
    expect(waiting.attempt.step.status).toBe('needs_second_factor')
    expect(await sent(CHANGED_SUBJECT)).toHaveLength(1)
    expect(await sent(SIGN_IN_SUBJECT)).toEqual([])
  })

  test.each<[string, object]>([
    ['a wrong current password', { currentPassword: 'not the password' }],
    ['a new password the policy refuses', { newPassword: 'short' }],
  ])('%s changes nothing and announces nothing', async (_, input) => {
    const { userId, sessionId } = await registered()
    await expect(change(userId, sessionId, input)).rejects.toBeInstanceOf(ServiceException)
    expect(await sent(CHANGED_SUBJECT)).toEqual([])
  })

  test('nothing is sent when the environment has the notice switched off', async () => {
    const { userId, sessionId } = await registered()
    settings({ passwordChanged: false })
    await change(userId, sessionId)
    await Users.setPassword(deps, tenant, userId, PASSWORD, TEST_ACTOR)
    expect(await sent(CHANGED_SUBJECT)).toEqual([])
    // The other switch is its own.
    await signIn(from(FIREFOX_MAC))
    expect(await sent(SIGN_IN_SUBJECT)).toHaveLength(1)
  })

  test('at most three an hour per user, apart from the new sign-in allowance', async () => {
    const { userId } = await registered()
    for (const password of [
      'first new passphrase 1',
      'second new passphrase 2',
      'third new passphrase 3',
      NEW_PASSWORD,
    ]) {
      await Users.setPassword(deps, tenant, userId, password, TEST_ACTOR)
      await Notices.settled()
    }
    expect(await sent(CHANGED_SUBJECT)).toHaveLength(Notices.NOTICES_PER_HOUR)
    await signIn(home, NEW_PASSWORD)
    await signIn(from(FIREFOX_MAC), NEW_PASSWORD)
    expect(await sent(SIGN_IN_SUBJECT)).toHaveLength(1)
    deps.clock.advance(Notices.NOTICE_WINDOW_MS)
    await Users.setPassword(deps, tenant, userId, PASSWORD, TEST_ACTOR)
    expect(await sent(CHANGED_SUBJECT)).toHaveLength(Notices.NOTICES_PER_HOUR + 1)
  })

  test('a relay that is down does not fail the change, and the log has no address', async () => {
    const { userId, sessionId } = await registered()
    const read = logged('warn')
    deps.mailer.failing = true
    await change(userId, sessionId)
    await Users.setPassword(deps, tenant, userId, PASSWORD, TEST_ACTOR)
    await Notices.settled()
    deps.mailer.failing = false
    expect((await signIn(home)).attempt.step.status).toBe('complete')
    expect(read()).toContain('"notice":"password_changed"')
    expect(read()).toContain('"reason":"Error"')
    expect(read()).not.toMatch(/northline|relay/i)
  })

  test('a relay that is down does not fail a password reset', async () => {
    await registered()
    const send = deps.mailer.send.bind(deps.mailer)
    spies.push(
      spyOn(deps.mailer, 'send').mockImplementation(async (message) => {
        if (!/^\d{6}\b/.test(message.subject)) {
          throw new Error('mail relay unavailable')
        }
        await send(message)
      }),
      spyOn(logger, 'warn').mockImplementation(() => {})
    )
    const done = await resetPassword(home)
    expect(done.attempt.step.status).toBe('complete')
    expect((await signIn(home, NEW_PASSWORD)).attempt.step.status).toBe('complete')
  })

  test('a limiter that cannot count means no notice, and the change still happens', async () => {
    const { userId, sessionId } = await registered()
    deps.rateLimiter = brokenNoticeLimiter(deps.rateLimiter) as TestDeps['rateLimiter']
    const read = logged('warn')
    await change(userId, sessionId)
    expect(await sent(CHANGED_SUBJECT)).toEqual([])
    expect(read()).toContain('"reason":"Error ECONNREFUSED"')
    expect((await signIn(home, NEW_PASSWORD)).attempt.step.status).toBe('complete')
  })

  test('settings that cannot be read mean no notice, and the change still happens', async () => {
    const { userId } = await registered()
    const read = logged('warn')
    const get = deps.environmentSettings.get.bind(deps.environmentSettings)
    let failing = false
    spies.push(
      spyOn(deps.environmentSettings, 'get').mockImplementation(async (...args) => {
        if (failing) {
          throw new Error('settings unavailable')
        }
        return get(...args)
      })
    )
    failing = true
    Notices.passwordChanged(
      deps,
      tenant,
      { id: userId, email: EMAIL },
      { by: 'self', added: false, at: deps.clock.now() }
    )
    await Notices.settled()
    failing = false
    expect(await sent(CHANGED_SUBJECT)).toEqual([])
    expect(read()).toContain('security notice not sent')
  })

  test('sending a notice is not an audited action', async () => {
    const { userId, sessionId } = await registered()
    await change(userId, sessionId)
    await signIn(from(FIREFOX_MAC), NEW_PASSWORD)
    await Notices.settled()
    expect(deps.mailer.outbox.map((message) => message.subject)).toEqual(
      expect.arrayContaining([CHANGED_SUBJECT, SIGN_IN_SUBJECT])
    )
    const recorded = JSON.stringify(deps.activityLog.entries)
    expect(recorded).not.toMatch(/notice|northline/i)
  })
})

describe('limitKey', () => {
  test('is per kind, environment and user, and holds no address', () => {
    expect(Notices.limitKey('new_sign_in', tenant, 'user_1')).toBe(
      `notice_new_sign_in:${tenant.environmentId}:user_1`
    )
    expect(Notices.limitKey('password_changed', tenant, 'user_1')).not.toBe(
      Notices.limitKey('new_sign_in', tenant, 'user_1')
    )
  })
})

describe('settled', () => {
  test('resolves at once when nothing is on its way', async () => {
    await Notices.settled()
    expect(deps.mailer.outbox).toEqual([])
  })
})
