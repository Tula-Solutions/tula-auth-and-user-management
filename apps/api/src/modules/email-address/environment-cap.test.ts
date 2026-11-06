import { describe, expect, test } from 'bun:test'
import * as Audit from '~/modules/audit/service'
import * as EmailAddress from '~/modules/email-address/service'
import { createTestDeps, TEST_TENANT } from '~/testing'

// H-205/H-204 (TULA-157): beside the per-user and per-address limits, one environment can
// only have so many address-verification emails sent an hour, however many accounts ask.

async function addresslessUser(deps: ReturnType<typeof createTestDeps>) {
  const id = deps.ids.next()
  await deps.users.create(
    {
      id,
      projectId: TEST_TENANT.projectId,
      environmentId: TEST_TENANT.environmentId,
      email: null,
      emailNormalized: null,
      emailVerifiedAt: null,
      firstName: null,
      lastName: null,
      createdAt: deps.clock.now(),
      identityId: deps.ids.next(),
      credentialId: deps.ids.next(),
      passwordHash: null,
    } as never,
    Audit.none('fixture')
  )
  return id
}

describe('the environment-wide cap on address emails', () => {
  test('refuses a code once the environment has spent its hour, whoever asks', async () => {
    const deps = createTestDeps()
    const userId = await addresslessUser(deps)
    const key = EmailAddress.environmentLimitKey(TEST_TENANT.environmentId)
    for (let i = 0; i < EmailAddress.EMAIL_ADDITION_EMAILS_PER_ENVIRONMENT_PER_HOUR; i++) {
      await deps.rateLimiter.hit(
        key,
        EmailAddress.EMAIL_ADDITION_EMAILS_PER_ENVIRONMENT_PER_HOUR,
        3_600_000
      )
    }
    await expect(
      EmailAddress.request(deps, TEST_TENANT, { userId }, { email: 'a@northline.app' })
    ).rejects.toMatchObject({ code: 'rate_limited' })
    expect(deps.mailer.outbox).toHaveLength(0)
  })

  test('another environment is not affected', async () => {
    const deps = createTestDeps()
    const userId = await addresslessUser(deps)
    await deps.rateLimiter.hit('email_addition_environment:other', 1, 3_600_000)
    const sent = await EmailAddress.request(
      deps,
      TEST_TENANT,
      { userId },
      { email: 'a@northline.app' }
    )
    expect(sent.destination).toBeTruthy()
  })
})
