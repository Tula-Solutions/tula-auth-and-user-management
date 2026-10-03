import { beforeEach, describe, expect, test } from 'bun:test'
import { DEFAULT_ENVIRONMENT_SETTINGS } from '@tula/contract'
import * as Email from '~/modules/email/service'
import * as Flows from '~/modules/flow/service'
import { createTestDeps, TEST_TENANT, type TestDeps } from '~/testing'

const tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const other = { ...tenant, environmentId: TEST_TENANT.productionEnvironmentId }
const ios: Flows.ClientContext = {
  client: 'ios',
  userAgent: 'TulaSDK/1 iOS',
  ipAddress: null,
  originAllowed: true,
}
let deps: TestDeps

function name(environmentId: string, appName: string, supportEmail: string | null = null) {
  deps.environmentSettings.seed(environmentId, {
    revision: 1,
    settings: { ...DEFAULT_ENVIRONMENT_SETTINGS, app: { name: appName, supportEmail } },
  })
}

beforeEach(() => {
  deps = createTestDeps()
})

describe('send', () => {
  test('uses the default app name until the environment sets one', async () => {
    await Email.send(deps, tenant, 'maya@northline.app', { type: 'account_exists' })
    expect(deps.mailer.last()).toMatchObject({
      to: 'maya@northline.app',
      subject: 'Your Tula account already exists',
    })
  })

  test('each environment’s emails carry its own name and support address', async () => {
    name(tenant.environmentId, 'Acme Dev', 'dev-help@acme.test')
    name(other.environmentId, 'Acme')
    const message = { type: 'email_verification', code: '482913', ttlMinutes: 10 } as const
    await Email.send(deps, tenant, 'maya@northline.app', message)
    expect(deps.mailer.last().subject).toBe('482913 is your Acme Dev verification code')
    expect(deps.mailer.last().text).toContain('Need help? Contact dev-help@acme.test')
    await Email.send(deps, other, 'maya@northline.app', message)
    expect(deps.mailer.last().subject).toBe('482913 is your Acme verification code')
    expect(deps.mailer.last().text).not.toContain('Need help')
  })

  test('a relay failure reaches the caller', async () => {
    deps.mailer.send = async () => {
      throw new Error('relay down')
    }
    await expect(
      Email.send(deps, tenant, 'maya@northline.app', { type: 'no_account' })
    ).rejects.toThrow('relay down')
  })
})

describe('every email a flow sends names the app', () => {
  beforeEach(() => {
    for (const [id, kind] of [
      [tenant.environmentId, 'development'],
      [other.environmentId, 'production'],
    ] as const) {
      deps.environments.add({
        id,
        projectId: tenant.projectId,
        kind,
        createdAt: deps.clock.now(),
      })
    }
    name(tenant.environmentId, 'Northline', 'help@northline.app')
  })

  const PASSWORD = 'correct horse battery staple'

  test('the sign-up code, the account-exists notice, the reset code and the no-account notice', async () => {
    const signUp = () =>
      Flows.signUp(deps, tenant, { email: 'maya@northline.app', password: PASSWORD }, ios)
    const { attempt } = await signUp()
    expect(deps.mailer.last().subject).toMatch(/^\d{6} is your Northline verification code$/)

    const code = /^(\d{6})/.exec(deps.mailer.last().subject)?.[1] ?? ''
    await Flows.verifyEmail(
      deps,
      tenant,
      'sign_up',
      { id: attempt.id, secret: attempt.attemptSecret },
      code,
      ios
    )
    deps.clock.advance('2m')
    await signUp()
    expect(deps.mailer.last().subject).toBe('Your Northline account already exists')

    deps.clock.advance('2m')
    await Flows.startPasswordReset(deps, tenant, { email: 'maya@northline.app' }, ios)
    expect(deps.mailer.last().subject).toMatch(/^\d{6} is your Northline password reset code$/)

    await Flows.startPasswordReset(deps, tenant, { email: 'nobody@northline.app' }, ios)
    expect(deps.mailer.last().subject).toBe('Northline password reset requested')

    expect(deps.mailer.outbox).toHaveLength(4)
    for (const sent of deps.mailer.outbox) {
      expect(sent.text).toContain('Northline')
      expect(sent.html).toContain('Northline')
      expect(sent.text).toContain('Need help? Contact help@northline.app')
    }
  })
})
