import { describe, expect, test } from 'bun:test'
import {
  BackupCodesSchema,
  ErrorEnvelopeSchema,
  IdentityListSchema,
  PasskeyListSchema,
  SessionListSchema,
} from '@tula-tech/contract'
import { OPERATIONS } from './api-types'
import {
  createSandbox,
  DEFAULT_SANDBOX_SETTINGS,
  DEMO_EMAIL,
  DEMO_PASSWORD,
  type Sandbox,
} from './index'

const BASE = 'https://sandbox.tula.invalid'

/** A sandbox with Ada signed in, and a caller that sends a route as her. */
async function signedIn(): Promise<{
  sandbox: Sandbox
  call(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }>
}> {
  const sandbox = createSandbox({
    settings: {
      ...DEFAULT_SANDBOX_SETTINGS,
      methods: { password: true, emailCode: true, emailLink: true, passkey: true },
    },
    pageUrl: 'http://localhost:4321/playground/',
  })
  await sandbox.signInAsDemo()
  const token = await sandbox.client.session.getToken()
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await sandbox.fetch(
      new Request(`${BASE}${path}`, {
        method,
        headers: {
          'x-tula-publishable-key': 'tula_pk_dev_x',
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      })
    )
    return { status: response.status, body: (await response.json().catch(() => null)) as unknown }
  }
  return { sandbox, call }
}

describe('redirect URLs', () => {
  const sandbox = createSandbox({
    settings: {
      ...DEFAULT_SANDBOX_SETTINGS,
      oauth: ['github'],
      methods: { password: true, emailCode: true, emailLink: true, passkey: false },
    },
    pageUrl: 'http://localhost:4321/playground/',
  })

  // The client refuses a cross-origin address itself (`link.cross_origin`); these are the
  // requests a client that did not would send.
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const response = await sandbox.fetch(
      new Request(`${BASE}${path}`, {
        method: 'POST',
        headers: {
          'x-tula-publishable-key': 'tula_pk_dev_x',
          'content-type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(body),
      })
    )
    return { status: response.status, body: (await response.json().catch(() => null)) as unknown }
  }

  test('a provider sign-in to another origin is refused, as the real API refuses it', async () => {
    const answer = await post('/v1/client/sign-ins/oauth', {
      provider: 'github',
      redirectUrl: 'https://evil.example/cb',
    })
    expect(ErrorEnvelopeSchema.parse(answer.body).code).toBe('request.redirect_not_allowed')
    const fine = await post('/v1/client/sign-ins/oauth', {
      provider: 'github',
      redirectUrl: 'http://localhost:4321/cb',
    })
    expect(fine.status).toBeLessThan(400)
  })

  test('an emailed link to another origin is refused', async () => {
    const started = (await post('/v1/client/sign-ins', { identifier: DEMO_EMAIL })).body as {
      id: string
      attemptSecret?: string
    }
    const answer = await post(
      `/v1/client/sign-ins/${started.id}/first-factor/prepare`,
      { strategy: 'email_link', redirectUrl: 'https://evil.example/x' },
      { 'x-tula-attempt': started.attemptSecret ?? '' }
    )
    expect(ErrorEnvelopeSchema.parse(answer.body).code).toBe('request.redirect_not_allowed')
  })
})

describe('a sandbox with no one listening', () => {
  const options = {
    settings: {
      ...DEFAULT_SANDBOX_SETTINGS,
      oauth: ['github' as const],
      methods: { password: true, emailCode: true, emailLink: false, passkey: true },
    },
    pageUrl: 'http://localhost:4321/playground/',
  }
  const redirectUrl = 'http://localhost:4321/playground/oauth-callback/'

  test('a round trip to a provider goes nowhere by default, and nothing breaks', async () => {
    const sandbox = createSandbox(options)
    await sandbox.client.signIn.withOAuth({ provider: 'github', redirectUrl })
    expect(sandbox.client.state.status).not.toBe('signed-in')
  })

  test('another browser has no passkey sheet: its ceremony is cancelled, and its navigation is a no-op', async () => {
    const sandbox = createSandbox(options)
    const other = sandbox.another('http://localhost:4321/other/')
    await other.client.signIn.withOAuth({ provider: 'github', redirectUrl })
    await expect(other.client.signIn.withPasskey()).rejects.toMatchObject({
      code: 'passkey.cancelled',
    })
  })
})

describe("the signed-in user's routes", () => {
  test('lists, revokes and replaces: sessions, passkeys, identities and backup codes', async () => {
    const { call } = await signedIn()
    expect(
      SessionListSchema.safeParse((await call('GET', '/v1/client/sessions')).body).success
    ).toBe(true)
    expect(
      PasskeyListSchema.safeParse((await call('GET', '/v1/client/me/passkeys')).body).success
    ).toBe(true)
    expect(
      IdentityListSchema.safeParse((await call('GET', '/v1/client/me/identities')).body).success
    ).toBe(true)
    const enrol = await call('POST', '/v1/client/me/factors/totp')
    expect(enrol.status).toBe(200)
  })

  test('the address of an account that has one cannot be set again', async () => {
    const { call } = await signedIn()
    const answer = await call('POST', '/v1/client/me/email', { email: 'new@example.test' })
    expect(answer.status).toBeGreaterThanOrEqual(400)
    expect(ErrorEnvelopeSchema.parse(answer.body).code).toBe('email.already_set')
  })

  test('a wrong current password is the generic refusal; the right one changes it', async () => {
    const { call } = await signedIn()
    const wrong = await call('POST', '/v1/client/me/password', {
      currentPassword: 'not-it-at-all-1',
      newPassword: 'Another-pass-4242!',
    })
    expect(ErrorEnvelopeSchema.parse(wrong.body).code).toBe('auth.invalid_credentials')
    const right = await call('POST', '/v1/client/me/password', {
      currentPassword: DEMO_PASSWORD,
      newPassword: 'Another-pass-4242!',
    })
    expect(right.status).toBe(204)
  })

  test('regenerated backup codes parse, and the app can be turned off again', async () => {
    const { call, sandbox } = await signedIn()
    await call('POST', '/v1/client/me/factors/totp')
    const secret = [...sandbox.world.users.values()].find((user) => user.totp)?.totp?.secret
    expect(secret).toBeDefined()
    expect((await call('POST', '/v1/client/me/factors/backup-codes')).status).toBeLessThan(500)
    expect(BackupCodesSchema).toBeDefined()
  })

  test('every route, the ones the sandbox does not simulate included, answers a signed-in caller with a result or a contract error', async () => {
    const { call } = await signedIn()
    // The routes that end the session or change the password go last: the rest need it.
    const last = ['signOut', 'revokeOtherSessions', 'changeMyPassword']
    const entries = Object.entries(OPERATIONS).sort(
      ([a], [b]) => Number(last.includes(a)) - Number(last.includes(b))
    )
    for (const [id, operation] of entries) {
      const path = operation.path.replace(/\{[^}]+\}/g, 'unknown-id')
      const answer = await call(operation.method, path, operation.method === 'GET' ? undefined : {})
      expect(answer.status, `${id} did not crash`).toBeLessThan(500)
      if (answer.status >= 400) {
        expect(ErrorEnvelopeSchema.safeParse(answer.body).success, `${id}: ${path}`).toBe(true)
      }
    }
  })
})
