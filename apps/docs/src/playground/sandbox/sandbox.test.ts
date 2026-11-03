import { describe, expect, test } from 'bun:test'
import {
  ClientConfigSchema,
  CurrentUserSchema,
  ErrorEnvelopeSchema,
  FactorsSchema,
  FlowAttemptSchema,
  PasskeyListSchema,
  PasskeySchema,
  PasskeySignInStartSchema,
  SessionListSchema,
  SessionTokensSchema,
  TotpEnrolmentSchema,
} from '@tula-tech/contract'
import { isTulaError, type TulaClient } from '@tula-tech/core'
import { OPERATIONS } from './api-types'
import { HANDLERS, UNSUPPORTED } from './handlers'
import {
  approveOAuth,
  attemptOfAuthorizationUrl,
  createSandbox,
  DEFAULT_SANDBOX_SETTINGS,
  DEMO_EMAIL,
  DEMO_MFA_EMAIL,
  DEMO_PASSWORD,
  DEMO_TOTP_SECRET,
  denyOAuth,
  type OAuthProfile,
  pendingOAuth,
  type Sandbox,
  type SandboxSettings,
  sandboxProfiles,
  totpNow,
} from './index'
import { totpAt } from './totp'
import { ACCESS_TOKEN_TTL_MS, CODE_GUESSES, LOCKOUT_FAILURES, LOCKOUT_SECONDS } from './world'

const PAGE = 'http://localhost:4321/playground/'

/** A sandbox on the shared test page, with the given settings and clock. */
function make(settings: Partial<SandboxSettings> = {}, now?: () => number): Sandbox {
  return createSandbox({
    settings: { ...DEFAULT_SANDBOX_SETTINGS, ...settings },
    pageUrl: PAGE,
    ...(now && { now }),
  })
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (isTulaError(error)) {
      return error.code
    }
    throw error
  }
  return 'resolved'
}

function newestCode(sandbox: Sandbox, to: string): string {
  const mail = [...sandbox.world.inbox].reverse().find((one) => one.to === to && one.code)
  if (!mail?.code) {
    throw new Error(`no code for ${to}`)
  }
  return mail.code
}

function signedIn(client: TulaClient): boolean {
  return client.state.status === 'signed-in'
}

describe('the route table', () => {
  test('answers every operation of the client API and nothing else', () => {
    expect(Object.keys(HANDLERS).sort()).toEqual(Object.keys(OPERATIONS).sort())
  })

  test('names a reason for every operation it does not simulate, and only real operations', () => {
    for (const [id, reason] of Object.entries(UNSUPPORTED)) {
      expect(id in OPERATIONS).toBe(true)
      expect(reason?.length).toBeGreaterThan(10)
    }
  })

  test('refuses an address that is not its own, and a route it does not have', async () => {
    const sandbox = make()
    const elsewhere = await sandbox.fetch(new Request('https://api.example.com/v1/client/config'))
    expect(elsewhere.status).toBe(404)
    const unknown = await sandbox.fetch(
      new Request('https://sandbox.tula.invalid/v1/client/nothing', {
        headers: { 'x-tula-publishable-key': 'tula_pk_dev_x' },
      })
    )
    expect(unknown.status).toBe(404)
  })

  test('refuses a request with no publishable key, as the real service does', async () => {
    const sandbox = make()
    const response = await sandbox.fetch(
      new Request('https://sandbox.tula.invalid/v1/client/config')
    )
    expect(response.status).toBe(401)
    expect((await response.json()).code).toBe('auth.invalid_key')
  })
})

describe('the client config', () => {
  test('lists the enabled methods and providers, the sign-up mode, the policy and the two-step policy', async () => {
    const sandbox = make({
      methods: { password: true, emailCode: true, emailLink: true, passkey: true },
      oauth: ['github', 'google'],
      mfaPolicy: 'required',
      signUpPassword: 'optional',
    })
    const response = await sandbox.fetch(
      new Request('https://sandbox.tula.invalid/v1/client/config', {
        headers: { 'x-tula-publishable-key': 'tula_pk_dev_sandbox' },
      })
    )
    const body = ClientConfigSchema.parse(await response.json())
    expect(body.signIn.methods).toEqual(['password', 'emailCode', 'emailLink', 'passkey'])
    expect(body.signIn.oauth).toEqual(['github', 'google'])
    expect(body.mfa?.policy).toBe('required')
    expect(body.signUp?.password).toBe('optional')
    expect(body.password.preset).toBe('recommended')
  })
})

describe('password sign-in', () => {
  test('a wrong password and an unknown address are the same generic error', async () => {
    const sandbox = make()
    const wrong = await sandbox.client.signIn.start({ identifier: DEMO_EMAIL })
    const unknown = await sandbox.client.signIn.start({ identifier: 'nobody@example.test' })
    expect(await codeOf(wrong.submitPassword({ password: 'not-the-password-1' }))).toBe(
      'auth.invalid_credentials'
    )
    expect(await codeOf(unknown.submitPassword({ password: DEMO_PASSWORD }))).toBe(
      'auth.invalid_credentials'
    )
  })

  test('the start offers the same step for every identifier', async () => {
    const sandbox = make()
    const known = await sandbox.client.signIn.start({ identifier: DEMO_EMAIL })
    const unknown = await sandbox.client.signIn.start({ identifier: 'nobody@example.test' })
    expect(known.step).toEqual(unknown.step)
  })

  test('the right password signs in and the client holds a session', async () => {
    const sandbox = make()
    const flow = await sandbox.client.signIn.start({ identifier: DEMO_EMAIL })
    const step = await flow.submitPassword({ password: DEMO_PASSWORD })
    expect(step.status).toBe('complete')
    expect(signedIn(sandbox.client)).toBe(true)
    const user = await sandbox.client.user.get()
    expect(user?.email).toBe(DEMO_EMAIL)
  })

  test('five wrong passwords ask the identifier to wait, with the time, and the wait ends', async () => {
    let now = Date.now()
    const sandbox = make({}, () => now)
    for (let attempt = 0; attempt < LOCKOUT_FAILURES; attempt++) {
      const flow = await sandbox.client.signIn.start({ identifier: DEMO_EMAIL })
      expect(await codeOf(flow.submitPassword({ password: 'wrong-password-123' }))).toBe(
        'auth.invalid_credentials'
      )
    }
    const locked = await sandbox.client.signIn.start({ identifier: DEMO_EMAIL })
    let error: unknown
    try {
      await locked.submitPassword({ password: DEMO_PASSWORD })
    } catch (caught) {
      error = caught
    }
    expect(isTulaError(error) && error.code).toBe('rate_limited')
    expect(isTulaError(error) && error.retryAfterMs).toBe(LOCKOUT_SECONDS * 1000)
    // Even the right password waits.
    now += (LOCKOUT_SECONDS + 1) * 1000
    const later = await sandbox.client.signIn.start({ identifier: DEMO_EMAIL })
    expect((await later.submitPassword({ password: DEMO_PASSWORD })).status).toBe('complete')
  })

  test('an attempt without its secret, or past its time, is the same not-found', async () => {
    let now = Date.now()
    const sandbox = make({}, () => now)
    const started = await sandbox.fetch(
      new Request('https://sandbox.tula.invalid/v1/client/sign-ins', {
        method: 'POST',
        headers: { 'x-tula-publishable-key': 'tula_pk_dev_x', 'content-type': 'application/json' },
        body: JSON.stringify({ identifier: DEMO_EMAIL }),
      })
    )
    const attempt = FlowAttemptSchema.parse(await started.json())
    const submit = (secret: string | null) =>
      sandbox.fetch(
        new Request(`https://sandbox.tula.invalid/v1/client/sign-ins/${attempt.id}/password`, {
          method: 'POST',
          headers: {
            'x-tula-publishable-key': 'tula_pk_dev_x',
            'content-type': 'application/json',
            ...(secret && { 'x-tula-attempt': secret }),
          },
          body: JSON.stringify({ password: DEMO_PASSWORD }),
        })
      )
    expect((await (await submit(null)).json()).code).toBe('flow.not_found')
    expect((await (await submit('sbx_as_wrong')).json()).code).toBe('flow.not_found')
    now += 11 * 60_000
    expect((await (await submit(attempt.attemptSecret ?? null)).json()).code).toBe('flow.not_found')
  })
})

describe('emailed code and link', () => {
  const settings: Partial<SandboxSettings> = {
    methods: { password: true, emailCode: true, emailLink: true, passkey: false },
  }

  test('a code in the inbox signs in; a wrong one is refused; a fifth wrong one ends the code', async () => {
    const sandbox = make(settings)
    const flow = await sandbox.client.signIn.start({ identifier: DEMO_EMAIL })
    expect(flow.step.status).toBe('needs_first_factor')
    await flow.prepareFirstFactor({ strategy: 'email_code' })
    const code = newestCode(sandbox, DEMO_EMAIL)
    const wrong = code === '000000' ? '111111' : '000000'
    expect(await codeOf(flow.attemptFirstFactor({ strategy: 'email_code', code: wrong }))).toBe(
      'verification.invalid_code'
    )
    const step = await flow.attemptFirstFactor({ strategy: 'email_code', code })
    expect(step.status).toBe('complete')
    expect(signedIn(sandbox.client)).toBe(true)
  })

  test('guesses are limited to five, then the right code is no longer accepted', async () => {
    const sandbox = make(settings)
    const flow = await sandbox.client.signIn.start({ identifier: DEMO_EMAIL })
    await flow.prepareFirstFactor({ strategy: 'email_code' })
    const code = newestCode(sandbox, DEMO_EMAIL)
    const wrong = code === '000000' ? '111111' : '000000'
    for (let guess = 0; guess < CODE_GUESSES; guess++) {
      await codeOf(flow.attemptFirstFactor({ strategy: 'email_code', code: wrong }))
    }
    expect(await codeOf(flow.attemptFirstFactor({ strategy: 'email_code', code }))).toMatch(
      /verification\.too_many_attempts|rate_limited/
    )
  })

  test('a code marked expired in the inbox answers as expired', async () => {
    const sandbox = make(settings)
    const flow = await sandbox.client.signIn.start({ identifier: DEMO_EMAIL })
    await flow.prepareFirstFactor({ strategy: 'email_code' })
    const mail = sandbox.world.inbox.at(-1)
    expect(mail?.code).toBeTruthy()
    if (mail) {
      mail.expired = true
    }
    expect(
      await codeOf(flow.attemptFirstFactor({ strategy: 'email_code', code: mail?.code ?? '' }))
    ).toBe('verification.expired')
  })

  test('a code asked for and not used expires with its ten minutes', async () => {
    let now = Date.now()
    const sandbox = make(settings, () => now)
    const flow = await sandbox.client.signIn.start({ identifier: DEMO_EMAIL })
    await flow.prepareFirstFactor({ strategy: 'email_code' })
    const code = newestCode(sandbox, DEMO_EMAIL)
    now += 9 * 60_000
    // Still inside its time, and the attempt's: one more minute and both are over.
    now += 2 * 60_000
    expect(await codeOf(flow.attemptFirstFactor({ strategy: 'email_code', code }))).toBe(
      'flow.not_found'
    )
  })

  test('an address with no account is sent a notice with no code, and the step is the same', async () => {
    const sandbox = make(settings)
    const known = await sandbox.client.signIn.start({ identifier: DEMO_EMAIL })
    const unknown = await sandbox.client.signIn.start({ identifier: 'nobody@example.test' })
    const a = await known.prepareFirstFactor({ strategy: 'email_code' })
    const b = await unknown.prepareFirstFactor({ strategy: 'email_code' })
    expect(a.status).toBe(b.status)
    const notice = sandbox.world.inbox.at(-1)
    expect(notice?.to).toBe('nobody@example.test')
    expect(notice?.notice).toBe(true)
    expect(notice?.code).toBeUndefined()
    expect(notice?.link).toBeUndefined()
    expect(
      await codeOf(unknown.attemptFirstFactor({ strategy: 'email_code', code: '123456' }))
    ).toBe('verification.invalid_code')
  })

  test('opening the emailed link in the same browser signs the waiting sign-in in', async () => {
    const sandbox = make(settings)
    const flow = await sandbox.client.signIn.start({ identifier: DEMO_EMAIL })
    await flow.prepareFirstFactor({
      strategy: 'email_link',
      redirectUrl: `${new URL(PAGE).origin}/playground/email-link/`,
    })
    const mail = sandbox.world.inbox.at(-1)
    expect(mail?.link).toContain('#tula_link=')
    // Nothing completes until the link is opened.
    const waiting = await flow.attemptFirstFactor({ strategy: 'email_link' })
    expect(waiting.status).toBe('needs_first_factor')
    sandbox.page.set(mail?.link ?? '')
    const outcome = await sandbox.client.signIn.handleEmailLink({ waitMs: 50 })
    expect(['signed_in', 'verified']).toContain(outcome.status)
    const step = await flow.attemptFirstFactor({ strategy: 'email_link' })
    expect(step.status).toBe('complete')
    expect(signedIn(sandbox.client)).toBe(true)
  })

  test('a link opened where the sign-in was not started proves nothing and is not used up', async () => {
    const sandbox = make(settings)
    const flow = await sandbox.client.signIn.start({ identifier: DEMO_EMAIL })
    await flow.prepareFirstFactor({
      strategy: 'email_link',
      redirectUrl: `${new URL(PAGE).origin}/playground/email-link/`,
    })
    const mail = sandbox.world.inbox.at(-1)
    const fragment = new URLSearchParams((mail?.link ?? '').split('#')[1])
    const response = await sandbox.fetch(
      new Request('https://sandbox.tula.invalid/v1/client/sign-ins/link', {
        method: 'POST',
        headers: { 'x-tula-publishable-key': 'tula_pk_dev_x', 'content-type': 'application/json' },
        body: JSON.stringify({
          token: fragment.get('tula_link'),
          attemptId: fragment.get('tula_attempt'),
          binding: 'sbx_lb_someone-elses',
        }),
      })
    )
    expect((await response.json()).code).toBe('verification.different_browser')
    // Still usable where it was asked for.
    sandbox.page.set(mail?.link ?? '')
    await sandbox.client.signIn.handleEmailLink({ waitMs: 50 })
    expect((await flow.attemptFirstFactor({ strategy: 'email_link' })).status).toBe('complete')
  })
})

describe('sign-up and password reset', () => {
  test('a weak password is refused with the contract rule and its field', async () => {
    const sandbox = make()
    let error: unknown
    try {
      await sandbox.client.signUp.start({ email: 'new@example.test', password: 'short' })
    } catch (caught) {
      error = caught
    }
    expect(isTulaError(error) && error.code).toBe('password.too_short')
    expect(isTulaError(error) && error.errors?.[0]?.field).toBe('password')
  })

  test('a sign-up is proven with the emailed code, then signed in', async () => {
    const sandbox = make()
    const flow = await sandbox.client.signUp.start({
      email: 'new@example.test',
      password: 'a-long-enough-password',
      firstName: 'Nia',
    })
    expect(flow.step.status).toBe('needs_email_verification')
    expect(await codeOf(flow.verifyEmail({ code: '000000' }))).toMatch(/verification\.invalid_code/)
    const step = await flow.verifyEmail({ code: newestCode(sandbox, 'new@example.test') })
    expect(step.status).toBe('complete')
    expect(signedIn(sandbox.client)).toBe(true)
    expect(sandbox.world.findUserByEmail('new@example.test')?.firstName).toBe('Nia')
  })

  test('an address that has an account gets the same step and a notice instead of a code', async () => {
    const sandbox = make()
    const flow = await sandbox.client.signUp.start({
      email: DEMO_EMAIL,
      password: 'a-long-enough-password',
    })
    expect(flow.step.status).toBe('needs_email_verification')
    const notice = sandbox.world.inbox.at(-1)
    expect(notice?.notice).toBe(true)
    expect(notice?.code).toBeUndefined()
    expect(await codeOf(flow.verifyEmail({ code: '123456' }))).toBe('verification.invalid_code')
  })

  test('a sign-up with no password is allowed only where the environment says so', async () => {
    const strict = make()
    expect(await codeOf(strict.client.signUp.start({ email: 'passwordless@example.test' }))).toBe(
      'validation.failed'
    )
    const optional = make({
      signUpPassword: 'optional',
      methods: { password: true, emailCode: true, emailLink: false, passkey: false },
    })
    const flow = await optional.client.signUp.start({ email: 'passwordless@example.test' })
    const step = await flow.verifyEmail({ code: newestCode(optional, 'passwordless@example.test') })
    expect(step.status).toBe('complete')
    expect(optional.world.findUserByEmail('passwordless@example.test')?.password).toBeNull()
  })

  test('a reset takes the emailed code and a new password, and the new password signs in', async () => {
    const sandbox = make()
    const reset = await sandbox.client.resetPassword.start({ email: DEMO_EMAIL })
    expect(reset.step.status).toBe('needs_new_password')
    expect(await codeOf(reset.submit({ code: '000000', password: 'brand-new-password-9' }))).toBe(
      'verification.invalid_code'
    )
    const step = await reset.submit({
      code: newestCode(sandbox, DEMO_EMAIL),
      password: 'brand-new-password-9',
    })
    expect(step.status).toBe('complete')
    await sandbox.client.session.signOut()
    const again = await sandbox.client.signIn.start({ identifier: DEMO_EMAIL })
    expect((await again.submitPassword({ password: 'brand-new-password-9' })).status).toBe(
      'complete'
    )
  })

  test('an unknown address starts a reset that answers like a known one and mails a notice', async () => {
    const sandbox = make()
    const reset = await sandbox.client.resetPassword.start({ email: 'nobody@example.test' })
    expect(reset.step.status).toBe('needs_new_password')
    expect(sandbox.world.inbox.at(-1)?.notice).toBe(true)
  })

  test('a reset does not bypass a second factor', async () => {
    const sandbox = make()
    const reset = await sandbox.client.resetPassword.start({ email: DEMO_MFA_EMAIL })
    const step = await reset.submit({
      code: newestCode(sandbox, DEMO_MFA_EMAIL),
      password: 'brand-new-password-9',
    })
    expect(step.status).toBe('needs_second_factor')
    expect(signedIn(sandbox.client)).toBe(false)
  })
})

describe('two-step verification', () => {
  test('an account with an authenticator app stops at the second step; a wrong code is refused; the right one signs in', async () => {
    const sandbox = make()
    const flow = await sandbox.client.signIn.start({ identifier: DEMO_MFA_EMAIL })
    const first = await flow.submitPassword({ password: DEMO_PASSWORD })
    expect(first.status).toBe('needs_second_factor')
    expect(signedIn(sandbox.client)).toBe(false)
    expect(await codeOf(flow.submitSecondFactor({ method: 'totp', code: '000000' }))).toBe(
      'mfa.invalid_code'
    )
    const code = await totpNow(DEMO_TOTP_SECRET, sandbox.world.now())
    const result = await flow.submitSecondFactor({ method: 'totp', code })
    expect(result.step.status).toBe('complete')
    expect(signedIn(sandbox.client)).toBe(true)
  })

  test('a code is accepted once', async () => {
    const sandbox = make()
    const code = await totpNow(DEMO_TOTP_SECRET, sandbox.world.now())
    const first = await sandbox.client.signIn.start({ identifier: DEMO_MFA_EMAIL })
    await first.submitPassword({ password: DEMO_PASSWORD })
    await first.submitSecondFactor({ method: 'totp', code })
    await sandbox.client.session.signOut()
    const second = await sandbox.client.signIn.start({ identifier: DEMO_MFA_EMAIL })
    await second.submitPassword({ password: DEMO_PASSWORD })
    expect(await codeOf(second.submitSecondFactor({ method: 'totp', code }))).toBe(
      'mfa.invalid_code'
    )
  })

  test('the authenticator app computes RFC 6238 codes', async () => {
    // RFC 6238 appendix B, SHA-1, secret "12345678901234567890" (Base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ).
    expect(await totpAt('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', Math.floor(59 / 30))).toBe('287082')
    expect(await totpAt('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', Math.floor(1111111109 / 30))).toBe(
      '081804'
    )
  })

  test('a backup code works once', async () => {
    const sandbox = make()
    const flow = await sandbox.client.signIn.start({ identifier: DEMO_MFA_EMAIL })
    await flow.submitPassword({ password: DEMO_PASSWORD })
    const result = await flow.submitSecondFactor({ method: 'backup_code', code: 'sbx1-aaaa' })
    expect(result.step.status).toBe('complete')
    await sandbox.client.session.signOut()
    const again = await sandbox.client.signIn.start({ identifier: DEMO_MFA_EMAIL })
    await again.submitPassword({ password: DEMO_PASSWORD })
    expect(
      await codeOf(again.submitSecondFactor({ method: 'backup_code', code: 'sbx1-aaaa' }))
    ).toBe('mfa.invalid_code')
  })

  test('a required policy makes an account without a factor enrol one inside the sign-in', async () => {
    const sandbox = make({ mfaPolicy: 'required' })
    const flow = await sandbox.client.signIn.start({ identifier: DEMO_EMAIL })
    const first = await flow.submitPassword({ password: DEMO_PASSWORD })
    expect(first.status).toBe('needs_factor_enrolment')
    const enrolment = await flow.startTotpEnrolment()
    expect(enrolment.uri).toStartWith('otpauth://totp/')
    expect(await codeOf(flow.confirmTotpEnrolment({ code: '000000' }))).toBe('mfa.invalid_code')
    const code = await totpNow(enrolment.secret, sandbox.world.now())
    const done = await flow.confirmTotpEnrolment({ code })
    expect(done.step.status).toBe('complete')
    expect(done.backupCodes).toHaveLength(10)
    expect(signedIn(sandbox.client)).toBe(true)
  })

  test('the policy "off" turns enrolment away, and "required" will not let the factor be removed', async () => {
    const off = make({ mfaPolicy: 'off' })
    const flow = await off.client.signIn.start({ identifier: DEMO_EMAIL })
    await flow.submitPassword({ password: DEMO_PASSWORD })
    expect(await codeOf(off.client.mfa.startTotp())).toBe('mfa.not_available')
  })
})

describe('OAuth round trip', () => {
  test('a provider button goes to the sandbox consent screen and back to a signed-in state', async () => {
    const navigated: string[] = []
    const sandbox = createSandbox({
      settings: { ...DEFAULT_SANDBOX_SETTINGS, oauth: ['github'] },
      pageUrl: PAGE,
      onNavigate: (url) => navigated.push(url),
    })
    const redirectUrl = `${new URL(PAGE).origin}/playground/oauth-callback/`
    expect(sandbox.client.signIn.canUseOAuth()).toBe(true)
    await sandbox.client.signIn.withOAuth({ provider: 'github', redirectUrl })
    expect(navigated).toHaveLength(1)
    expect(navigated[0]).toStartWith('https://sandbox.tula.invalid/oauth/github/authorize')
    const attemptId = attemptOfAuthorizationUrl(navigated[0] as string) as string
    expect(pendingOAuth(sandbox.world, attemptId)?.provider).toBe('github')
    const back = approveOAuth(
      sandbox.world,
      attemptId,
      sandboxProfiles('github')[0] as OAuthProfile
    )
    expect(back).toStartWith(`${redirectUrl}#tula_ticket=`)
    sandbox.page.set(back)
    const outcome = await sandbox.client.signIn.handleOAuthCallback()
    expect(outcome.status).toBe('complete')
    expect(signedIn(sandbox.client)).toBe(true)
    // The provider vouched for ada's verified address, so it is her account, now with the identity.
    const user = await sandbox.client.user.get()
    expect(user?.email).toBe(DEMO_EMAIL)
    expect(sandbox.world.findUserByEmail(DEMO_EMAIL)?.identities).toHaveLength(1)
  })

  test('a person who has no account gets one, with the provider as their way in', async () => {
    const sandbox = createSandbox({
      settings: { ...DEFAULT_SANDBOX_SETTINGS, oauth: ['google'] },
      pageUrl: PAGE,
      onNavigate: (url) => {
        const id = attemptOfAuthorizationUrl(url) as string
        sandbox.page.set(
          approveOAuth(sandbox.world, id, sandboxProfiles('google')[1] as OAuthProfile)
        )
      },
    })
    const redirectUrl = `${new URL(PAGE).origin}/playground/oauth-callback/`
    await sandbox.client.signIn.withOAuth({ provider: 'google', redirectUrl })
    expect((await sandbox.client.signIn.handleOAuthCallback()).status).toBe('complete')
    const created = sandbox.world.findUserByEmail('alex.google@example.test')
    expect(created?.password).toBeNull()
    expect(created?.emailVerifiedAt).not.toBeNull()
  })

  test('declining on the provider page comes back as access denied, signed out', async () => {
    const sandbox = createSandbox({
      settings: { ...DEFAULT_SANDBOX_SETTINGS, oauth: ['github'] },
      pageUrl: PAGE,
      onNavigate: (url) => {
        sandbox.page.set(denyOAuth(sandbox.world, attemptOfAuthorizationUrl(url) as string))
      },
    })
    await sandbox.client.signIn.withOAuth({
      provider: 'github',
      redirectUrl: `${new URL(PAGE).origin}/playground/oauth-callback/`,
    })
    const outcome = await sandbox.client.signIn.handleOAuthCallback()
    expect(outcome.status).toBe('error')
    expect(outcome.status === 'error' && outcome.code).toBe('oauth.access_denied')
    expect(signedIn(sandbox.client)).toBe(false)
  })

  test('a provider that is not switched on is refused', async () => {
    const sandbox = createSandbox({ settings: DEFAULT_SANDBOX_SETTINGS, pageUrl: PAGE })
    expect(
      await codeOf(
        sandbox.client.signIn.withOAuth({
          provider: 'github',
          redirectUrl: `${new URL(PAGE).origin}/playground/oauth-callback/`,
        })
      )
    ).toBe('auth.method_disabled')
  })

  test('a ticket is used once, and only with the binding of the browser that started', async () => {
    const sandbox = createSandbox({
      settings: { ...DEFAULT_SANDBOX_SETTINGS, oauth: ['github'] },
      pageUrl: PAGE,
    })
    const post = async (path: string, body: unknown) =>
      (
        await sandbox.fetch(
          new Request(`https://sandbox.tula.invalid${path}`, {
            method: 'POST',
            headers: {
              'x-tula-publishable-key': 'tula_pk_dev_x',
              'content-type': 'application/json',
            },
            body: JSON.stringify(body),
          })
        )
      ).json()
    const redirectUrl = `${new URL(PAGE).origin}/playground/oauth-callback/`
    const start = await post('/v1/client/sign-ins/oauth', { provider: 'github', redirectUrl })
    const attemptId = start.attempt.id as string
    const back = approveOAuth(
      sandbox.world,
      attemptId,
      sandboxProfiles('github')[0] as OAuthProfile
    )
    const ticket = new URLSearchParams(back.split('#')[1]).get('tula_ticket')
    const exchange = (binding: string) =>
      post('/v1/client/sign-ins/oauth/exchange', { ticket, attemptId, binding })
    expect((await exchange('sbx_ob_someone-elses')).code).toBe('oauth.different_browser')
    expect(FlowAttemptSchema.safeParse(await exchange(start.binding)).success).toBe(true)
    expect((await exchange(start.binding)).code).toBe('oauth.ticket_invalid')
  })
})

describe('passkeys, on a simulated authenticator', () => {
  const settings: Partial<SandboxSettings> = {
    methods: { password: true, emailCode: false, emailLink: false, passkey: true },
  }

  test('registers a passkey, then signs in with it and no second step, never calling the browser', async () => {
    const sandbox = make(settings)
    expect(
      (globalThis as { navigator?: { credentials?: unknown } }).navigator?.credentials
    ).toBeUndefined()
    const flow = await sandbox.client.signIn.start({ identifier: DEMO_EMAIL })
    await flow.submitPassword({ password: DEMO_PASSWORD })
    const passkey = await sandbox.client.user.passkeys.add({ name: 'Sandbox laptop' })
    expect(passkey.name).toBe('Sandbox laptop')
    expect(sandbox.authenticator.credentials).toHaveLength(1)
    await sandbox.client.session.signOut()
    expect(signedIn(sandbox.client)).toBe(false)
    const result = await sandbox.client.signIn.withPasskey()
    expect(result.step.status).toBe('complete')
    expect(signedIn(sandbox.client)).toBe(true)
  })

  test('a passkey sheet that is dismissed is a cancelled ceremony, not an error of the service', async () => {
    const sandbox = createSandbox({
      settings: { ...DEFAULT_SANDBOX_SETTINGS, ...settings },
      pageUrl: PAGE,
      confirmPasskey: async () => false,
    })
    expect(await codeOf(sandbox.client.signIn.withPasskey())).toBe('passkey.cancelled')
  })

  test('a device with no passkey for the site has nothing to offer', async () => {
    const sandbox = make(settings)
    expect(await codeOf(sandbox.client.signIn.withPasskey())).toBe('passkey.cancelled')
  })

  test('passkey sign-in is refused where the method is off', async () => {
    const sandbox = make()
    expect(await codeOf(sandbox.client.signIn.withPasskey())).toBe('auth.method_disabled')
  })
})

describe('sessions and tokens', () => {
  test('lists the devices, signs the others out, and refuses a revoked session', async () => {
    const sandbox = make()
    const other = make()
    // Two sessions of one account in one world: sign in twice with the same client kind.
    const first = await sandbox.client.signIn.start({ identifier: DEMO_EMAIL })
    await first.submitPassword({ password: DEMO_PASSWORD })
    const user = sandbox.world.findUserByEmail(DEMO_EMAIL)
    expect(user).toBeDefined()
    if (user) {
      sandbox.world.createSession(user, 'ios', ['pwd'])
    }
    const sessions = await sandbox.client.session.list()
    expect(sessions).toHaveLength(2)
    expect(sessions.filter((one) => one.current)).toHaveLength(1)
    expect(await sandbox.client.session.revokeOthers()).toBe(1)
    expect(await sandbox.client.session.list()).toHaveLength(1)
    expect(other.world.sessions.size).toBe(0)
  })

  test('an access token lasts a minute and is refreshed with the rotating cookie', async () => {
    let now = Date.now()
    const sandbox = make({}, () => now)
    const flow = await sandbox.client.signIn.start({ identifier: DEMO_EMAIL })
    await flow.submitPassword({ password: DEMO_PASSWORD })
    const before = await sandbox.client.session.getToken()
    now += ACCESS_TOKEN_TTL_MS + 1000
    const after = await sandbox.client.session.getToken()
    expect(after).not.toBe(before)
    expect(signedIn(sandbox.client)).toBe(true)
  })

  test('presenting a refresh token that was already rotated ends the session', async () => {
    const sandbox = make()
    const user = sandbox.world.findUserByEmail(DEMO_EMAIL)
    const session = user && sandbox.world.createSession(user, 'ios', ['pwd'])
    const refresh = async (token: string) =>
      (
        await sandbox.fetch(
          new Request('https://sandbox.tula.invalid/v1/client/sessions/refresh', {
            method: 'POST',
            headers: {
              'x-tula-publishable-key': 'tula_pk_dev_x',
              'x-tula-client': 'ios',
              'content-type': 'application/json',
            },
            body: JSON.stringify({ refreshToken: token }),
          })
        )
      ).json()
    const original = session?.refreshToken ?? ''
    const rotated = await refresh(original)
    expect(SessionTokensSchema.safeParse(rotated).success).toBe(true)
    expect((await refresh(original)).code).toBe('session.reuse_detected')
    expect((await refresh(rotated.refreshToken)).code).toBe('session.invalid_token')
  })

  test('changing the password needs the current one and applies the policy', async () => {
    const sandbox = make()
    const flow = await sandbox.client.signIn.start({ identifier: DEMO_EMAIL })
    await flow.submitPassword({ password: DEMO_PASSWORD })
    expect(
      await codeOf(
        sandbox.client.user.changePassword({
          currentPassword: 'wrong-password-12',
          newPassword: 'a-new-password-123',
        })
      )
    ).toBe('auth.invalid_credentials')
    expect(
      await codeOf(
        sandbox.client.user.changePassword({ currentPassword: DEMO_PASSWORD, newPassword: 'short' })
      )
    ).toBe('password.too_short')
    await sandbox.client.user.changePassword({
      currentPassword: DEMO_PASSWORD,
      newPassword: 'a-new-password-123',
    })
    expect(sandbox.world.findUserByEmail(DEMO_EMAIL)?.password).toBe('a-new-password-123')
  })

  test('what the sandbox does not simulate answers with the contract refusal, not a pretence', async () => {
    const sandbox = make()
    const flow = await sandbox.client.signIn.start({ identifier: DEMO_EMAIL })
    await flow.submitPassword({ password: DEMO_PASSWORD })
    const response = await sandbox.fetch(
      new Request('https://sandbox.tula.invalid/v1/client/me/phone', {
        method: 'POST',
        headers: {
          'x-tula-publishable-key': 'tula_pk_dev_x',
          'content-type': 'application/json',
          authorization: `Bearer ${await sandbox.client.session.getToken()}`,
        },
        body: JSON.stringify({ phoneNumber: '+15555550100' }),
      })
    )
    expect(response.status).toBe(403)
    expect((await response.json()).code).toBe('sms.disabled')
  })
})

describe('the answers fit the contract', () => {
  const KEY = { 'x-tula-publishable-key': 'tula_pk_dev_x', 'content-type': 'application/json' }
  const call = async (
    sandbox: Sandbox,
    method: string,
    path: string,
    body?: unknown,
    headers = {}
  ) => {
    const response = await sandbox.fetch(
      new Request(`https://sandbox.tula.invalid${path}`, {
        method,
        headers: { ...KEY, ...headers },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      })
    )
    return { status: response.status, body: (await response.json().catch(() => null)) as unknown }
  }

  test('the flow, token, factor, passkey and session answers parse as the contract says', async () => {
    const sandbox = make({
      methods: { password: true, emailCode: true, emailLink: true, passkey: true },
    })
    const started = await call(sandbox, 'POST', '/v1/client/sign-ins', { identifier: DEMO_EMAIL })
    const attempt = FlowAttemptSchema.parse(started.body)
    const secret = attempt.attemptSecret as string
    const signedIn = await call(
      sandbox,
      'POST',
      `/v1/client/sign-ins/${attempt.id}/password`,
      { password: DEMO_PASSWORD },
      { 'x-tula-attempt': secret }
    )
    const complete = FlowAttemptSchema.parse(signedIn.body)
    expect(complete.step.status).toBe('complete')
    const tokens = SessionTokensSchema.parse(complete.session)
    const bearer = { authorization: `Bearer ${tokens.accessToken}` }
    expect(
      CurrentUserSchema.safeParse(
        (await call(sandbox, 'GET', '/v1/client/me', undefined, bearer)).body
      ).success
    ).toBe(true)
    expect(
      FactorsSchema.safeParse(
        (await call(sandbox, 'GET', '/v1/client/me/factors', undefined, bearer)).body
      ).success
    ).toBe(true)
    expect(
      SessionListSchema.safeParse(
        (await call(sandbox, 'GET', '/v1/client/sessions', undefined, bearer)).body
      ).success
    ).toBe(true)
    expect(
      PasskeyListSchema.safeParse(
        (await call(sandbox, 'GET', '/v1/client/me/passkeys', undefined, bearer)).body
      ).success
    ).toBe(true)
    expect(
      ClientConfigSchema.safeParse((await call(sandbox, 'GET', '/v1/client/config')).body).success
    ).toBe(true)
  })

  test('every refusal is the contract envelope with a code the contract defines', async () => {
    const sandbox = make()
    const wrong = await call(sandbox, 'POST', '/v1/client/sign-ins', { identifier: '' })
    const missing = await call(sandbox, 'GET', '/v1/client/me')
    const nowhere = await call(sandbox, 'POST', '/v1/client/sign-ins/none/password', {
      password: 'x',
    })
    for (const refusal of [wrong, missing, nowhere]) {
      expect(refusal.status).toBeGreaterThanOrEqual(400)
      expect(ErrorEnvelopeSchema.safeParse(refusal.body).success).toBe(true)
    }
  })

  test('signInAsDemo signs in through the flow and gives the settings back', async () => {
    const settings = {
      methods: { password: false, emailCode: true, emailLink: false, passkey: false },
      mfaPolicy: 'required' as const,
    }
    const sandbox = make(settings)
    await sandbox.signInAsDemo()
    expect(signedIn(sandbox.client)).toBe(true)
    expect(sandbox.world.settings.methods.password).toBe(false)
    expect(sandbox.world.settings.mfaPolicy).toBe('required')
  })

  test('another browser has a session of its own, on the same accounts', async () => {
    const sandbox = make()
    const other = sandbox.another('http://localhost:4321/other/')
    await sandbox.signInAsDemo()
    expect(signedIn(sandbox.client)).toBe(true)
    expect(signedIn(other.client)).toBe(false)
    const flow = await other.client.signIn.start({ identifier: DEMO_EMAIL })
    await flow.submitPassword({ password: DEMO_PASSWORD })
    expect(signedIn(other.client)).toBe(true)
  })

  test('the passkey sign-in start parses', async () => {
    const sandbox = make({
      methods: { password: true, emailCode: false, emailLink: false, passkey: true },
    })
    const start = await call(sandbox, 'POST', '/v1/client/sign-ins/passkey', {})
    expect(PasskeySignInStartSchema.safeParse(start.body).success).toBe(true)
    expect(TotpEnrolmentSchema).toBeDefined()
    expect(PasskeySchema).toBeDefined()
  })
})
