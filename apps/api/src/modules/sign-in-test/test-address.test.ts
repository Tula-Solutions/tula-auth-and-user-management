import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test'
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  type FlowAttempt,
  isTestAddress,
  OAUTH_PROVIDERS,
  testAddress,
} from '@tula-tech/contract'
import type { Tenant } from '~/dependencies'
import { createApp } from '~/index'
import { captureMail } from '~/lib/captured-mail'
import * as logger from '~/lib/logger'
import * as Email from '~/modules/email/service'
import * as OAuth from '~/modules/oauth/service'
import { createTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'

// The marked address of a sign-in test's throwaway user (ADR 0058) at every place an address
// reaches an account or a mailbox. No person may hold one, be created with one, be reported
// by a provider with one or be sent mail at one. Each row is put beside an address the server
// has always refused (a Kelvin sign for a "k"): the answers are the same, so a marked address
// tells nobody anything, and it is decided from the address alone.

const PK = 'tula_pk_dev_publishable0000000000000000000'
const SK = 'tula_sk_dev_admin000000000000000000000000000000'
const MARKED = testAddress('0123456789abcdef0123456789abcdef')
const MARKED_SPELLINGS = [
  MARKED,
  MARKED.toUpperCase(),
  'someone@test.tula.invalid',
  'someone@deeper.test.tula.invalid',
]
/** Refused by `parseEmail` since long before: the comparison every row is held to. */
const NEVER_AN_ADDRESS = '\u212Aelvin@northline.app'
const PASSWORD = 'correct horse battery staple'
const tenant: Tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}

let deps: TestDeps
let app: ReturnType<typeof createApp>
let spies: Mock<(...args: never[]) => unknown>[] = []

beforeEach(async () => {
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
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    spies.push(spyOn(logger, level).mockImplementation(() => undefined))
  }
})

afterEach(() => {
  for (const spy of spies) {
    spy.mockRestore()
  }
  spies = []
})

const logged = () => JSON.stringify(spies.flatMap((spy) => spy.mock.calls))

function client(path: string, body: unknown, attempt?: string) {
  return app.request(`/v1/client${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tula-publishable-key': PK,
      ...(attempt && { 'x-tula-attempt': attempt }),
    },
    body: JSON.stringify(body),
  })
}

/** The status and the body of an answer, with what differs between any two attempts taken out. */
async function answer(res: Response) {
  const body = (await res.json()) as Record<string, unknown>
  const { id: _id, attemptSecret: _secret, expiresAt: _expires, ...rest } = body
  return { status: res.status, body: rest }
}

const userCount = async () =>
  (await deps.users.list(tenant.environmentId, { page: 1, size: 100, sort: '-createdAt' }))
    .totalCount

describe.each(MARKED_SPELLINGS)('the marked address %p', (address) => {
  test('is the contract’s to recognise', () => {
    expect(isTestAddress(address)).toBe(true)
  })

  test('cannot sign up', async () => {
    const marked = await answer(await client('/sign-ups', { email: address, password: PASSWORD }))
    const never = await answer(
      await client('/sign-ups', { email: NEVER_AN_ADDRESS, password: PASSWORD })
    )
    expect(marked).toEqual(never)
    expect(marked.status).toBe(422)
    expect(JSON.stringify(marked.body)).toContain('email.invalid')
    expect(await userCount()).toBe(0)
    expect(deps.mailer.outbox).toEqual([])
  })

  test('cannot be created by an administrator', async () => {
    const create = (email: string) =>
      app.request('/v1/admin/users', {
        method: 'POST',
        headers: { authorization: `Bearer ${SK}`, 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: PASSWORD }),
      })
    const marked = await answer(await create(address))
    expect(marked).toEqual(await answer(await create(NEVER_AN_ADDRESS)))
    expect(marked.status).toBe(422)
    expect(await userCount()).toBe(0)
  })

  test('cannot ask for a password reset', async () => {
    const marked = await answer(await client('/password-resets', { email: address }))
    expect(marked).toEqual(
      await answer(await client('/password-resets', { email: NEVER_AN_ADDRESS }))
    )
    expect(marked.status).toBe(422)
    expect(deps.mailer.outbox).toEqual([])
  })

  test('a sign-in start answers it as it answers every identifier, and looks nothing up', async () => {
    const byEmail = spyOn(deps.users, 'findByEmail')
    const marked = await answer(await client('/sign-ins', { identifier: address }))
    const person = await answer(await client('/sign-ins', { identifier: 'maya@northline.app' }))
    expect(marked).toEqual(person)
    expect(marked.status).toBe(200)
    expect(byEmail).not.toHaveBeenCalled()
    byEmail.mockRestore()
  })

  test('proves nothing with a password, and is answered like an unknown address', async () => {
    const guess = async (identifier: string) => {
      const started = (await (await client('/sign-ins', { identifier })).json()) as FlowAttempt
      return answer(
        await client(
          `/sign-ins/${started.id}/password`,
          { password: PASSWORD },
          started.attemptSecret
        )
      )
    }
    const marked = await guess(address)
    expect(marked).toEqual(await guess('nobody@northline.app'))
    expect(marked.status).toBe(401)
    expect(marked.body).toMatchObject({ code: 'auth.invalid_credentials' })
  })

  test('cannot ask for a sign-in email', async () => {
    deps.environmentSettings.seed(tenant.environmentId, {
      revision: 1,
      settings: {
        ...DEFAULT_ENVIRONMENT_SETTINGS,
        signIn: {
          methods: {
            password: { enabled: true },
            emailCode: { enabled: true },
            emailLink: { enabled: false },
            passkey: { enabled: false },
            smsCode: { enabled: false },
          },
        },
      },
    })
    const prepare = async (identifier: string) => {
      const started = (await (await client('/sign-ins', { identifier })).json()) as FlowAttempt
      return answer(
        await client(
          `/sign-ins/${started.id}/first-factor/prepare`,
          { strategy: 'email_code' },
          started.attemptSecret
        )
      )
    }
    const marked = await prepare(address)
    expect(marked).toEqual(await prepare(NEVER_AN_ADDRESS))
    expect(marked.status).toBe(422)
    expect(deps.mailer.outbox).toEqual([])
  })

  test.each(OAUTH_PROVIDERS.filter((provider) => provider !== 'x' && provider !== 'facebook'))(
    'reported by %s as verified, it is no address at all',
    async (provider) => {
      const byEmail = spyOn(deps.users, 'findByEmail')
      const outcome = await OAuth.resolveAccount(
        deps,
        tenant,
        provider,
        { subject: 'subject-1', email: address, emailVerified: true },
        {},
        'web'
      ).then(
        () => 'resolved',
        (error: { code?: string }) => error.code
      )
      expect(outcome).toBe('oauth.email_missing')
      expect(byEmail).not.toHaveBeenCalled()
      byEmail.mockRestore()
      expect(await userCount()).toBe(0)
    }
  )

  test('is never handed to the deployment’s mailer, whatever asks', async () => {
    const messages = [
      { type: 'email_verification', code: '482913', ttlMinutes: 10 },
      { type: 'sign_in', code: '482913', ttlMinutes: 10 },
      { type: 'no_account' },
      { type: 'account_exists' },
    ] as const
    for (const message of messages) {
      await Email.send(deps, tenant, address, message)
    }
    expect(deps.mailer.outbox).toEqual([])
    const lines = logged()
    expect(lines).toContain('email not sent: the address is in the reserved test domain')
    expect(lines).not.toContain('482913')
    expect(lines.toLowerCase()).not.toContain('tula.invalid')
  })
})

describe('a mail capture', () => {
  test('keeps what it is handed and sends nothing, for any address', async () => {
    const mail = captureMail()
    const capturing = { ...deps, mailer: mail }
    await Email.send(capturing, tenant, MARKED, {
      type: 'email_verification',
      code: '482913',
      ttlMinutes: 10,
    })
    await Email.send(capturing, tenant, MARKED, { type: 'no_account' })
    expect(mail.captured).toEqual([
      { to: MARKED, type: 'email_verification', code: '482913' },
      { to: MARKED, type: 'no_account' },
    ])
    expect(deps.mailer.outbox).toEqual([])
    // A message rendered first and handed to `send` is dropped, not passed on.
    await mail.send({ to: MARKED, subject: 's', text: 't', html: 'h' })
    expect(mail.captured).toHaveLength(2)
    expect(deps.mailer.outbox).toEqual([])
  })

  test('the deployment’s mailer is not one', async () => {
    await Email.send(deps, tenant, 'maya@northline.app', { type: 'no_account' })
    expect(deps.mailer.outbox).toHaveLength(1)
  })
})
