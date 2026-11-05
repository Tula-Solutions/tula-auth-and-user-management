import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { DEFAULT_ENVIRONMENT_SETTINGS } from '@tula-tech/contract'
import type { Tenant } from '~/dependencies'
import * as Audit from '~/modules/audit/service'
import * as Flows from '~/modules/flow/service'
import * as Hooks from '~/modules/hook/service'
import * as OrganizationDomains from '~/modules/organization-domain/service'
import * as Passwords from '~/modules/password/service'
import * as Sso from '~/modules/sso/service'
import { createTestDeps, TEST_TENANT, type TestDeps } from '~/testing'

const tenant: Tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const web: Flows.ClientContext = {
  client: 'web',
  userAgent: 'Mozilla/5.0',
  ipAddress: '203.0.113.7',
  originAllowed: true,
}
let deps: TestDeps

beforeEach(() => {
  deps = createTestDeps()
  for (const [id, kind] of [
    [TEST_TENANT.environmentId, 'development'],
    [TEST_TENANT.productionEnvironmentId, 'production'],
  ] as const) {
    deps.environments.add({
      id,
      projectId: TEST_TENANT.projectId,
      kind,
      createdAt: deps.clock.now(),
    })
  }
})

describe('password reset lookups (H-078)', () => {
  test('an unknown address goes through the same enforced-SSO lookup as a real one', async () => {
    const refuses = spyOn(Sso, 'refuses')
    try {
      await Flows.startPasswordReset(deps, tenant, { email: 'nobody@northline.app' }, web)
      expect(refuses).toHaveBeenCalledTimes(1)
    } finally {
      refuses.mockRestore()
    }
  })
})

describe('the sign-up organization join (H-083)', () => {
  test('a stale accountCreated flag does not make a sign-in join an organization', async () => {
    const userId = deps.ids.next()
    await deps.users.create(
      {
        id: userId,
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        email: 'maya@northline.app',
        emailNormalized: 'maya@northline.app',
        emailVerifiedAt: deps.clock.now(),
        firstName: null,
        lastName: null,
        createdAt: deps.clock.now(),
        identityId: deps.ids.next(),
        credentialId: deps.ids.next(),
        passwordHash: await Passwords.hash('correct horse battery staple'),
      },
      Audit.none('fixture')
    )
    // The account is older than the attempt: a flag claiming it was created here is wrong.
    deps.clock.advance(60_000)
    const { attempt: later } = await Flows.signIn(
      deps,
      tenant,
      { identifier: 'maya@northline.app' },
      web
    )
    const stored = await deps.flowAttempts.findById(tenant.environmentId, later.id)
    await deps.flowAttempts.transition(
      tenant.environmentId,
      later.id,
      stored?.status ?? 'needs_password',
      {
        status: stored?.status ?? 'needs_password',
        state: { ...stored?.state, accountCreated: true },
      },
      deps.clock.now()
    )
    const join = spyOn(OrganizationDomains, 'joinOnSignUp')
    try {
      await Flows.submitPassword(
        deps,
        tenant,
        { id: later.id, secret: later.attemptSecret },
        'correct horse battery staple',
        web
      )
      expect(join).not.toHaveBeenCalled()
    } finally {
      join.mockRestore()
    }
  })
})

describe('the ban check at the end of a flow (H-087)', () => {
  test('a ban that lands after the flow checks the user is refused by the session service', async () => {
    const userId = deps.ids.next()
    await deps.users.create(
      {
        id: userId,
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        email: 'maya@northline.app',
        emailNormalized: 'maya@northline.app',
        emailVerifiedAt: deps.clock.now(),
        firstName: null,
        lastName: null,
        createdAt: deps.clock.now(),
        identityId: deps.ids.next(),
        credentialId: deps.ids.next(),
        passwordHash: await Passwords.hash('correct horse battery staple'),
      },
      Audit.none('fixture')
    )
    const { attempt } = await Flows.signIn(deps, tenant, { identifier: 'maya@northline.app' }, web)
    // The ban lands in the window between `finish`'s own steps and `Sessions.create`.
    const before = spyOn(Hooks, 'beforeSession').mockImplementation(async () => {
      await deps.users.setBanned(
        tenant.environmentId,
        userId,
        deps.clock.now(),
        deps.clock.now(),
        Audit.none('fixture')
      )
      return 'none' as never
    })
    try {
      const err = await Flows.submitPassword(
        deps,
        tenant,
        { id: attempt.id, secret: attempt.attemptSecret },
        'correct horse battery staple',
        web
      ).catch((e: unknown) => e)
      expect((err as { code?: string }).code).toBe('auth.user_banned')
    } finally {
      before.mockRestore()
    }
  })
})

describe('a first factor switched off while its attempt is parked (H-089)', () => {
  const LINK = 'https://app.northline.app/verify'
  const methods = DEFAULT_ENVIRONMENT_SETTINGS.signIn.methods
  const seed = (patch: Partial<typeof methods>) =>
    deps.environmentSettings.seed(tenant.environmentId, {
      revision: 1,
      settings: {
        ...DEFAULT_ENVIRONMENT_SETTINGS,
        urls: { ...DEFAULT_ENVIRONMENT_SETTINGS.urls, allowedRedirectUrls: [LINK] },
        signIn: { methods: { ...methods, ...patch } },
      },
    })

  const prepare = (strategy: 'email_code' | 'email_link') =>
    strategy === 'email_link' ? { strategy, redirectUrl: LINK } : { strategy }

  async function parked(strategy: 'email_code' | 'email_link') {
    await deps.users.create(
      {
        id: deps.ids.next(),
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        email: 'maya@northline.app',
        emailNormalized: 'maya@northline.app',
        emailVerifiedAt: deps.clock.now(),
        firstName: null,
        lastName: null,
        createdAt: deps.clock.now(),
        identityId: deps.ids.next(),
        credentialId: deps.ids.next(),
        passwordHash: await Passwords.hash('correct horse battery staple'),
      },
      Audit.none('fixture')
    )
    seed({ emailCode: { enabled: true }, emailLink: { enabled: strategy === 'email_link' } })
    const { attempt } = await Flows.signIn(deps, tenant, { identifier: 'maya@northline.app' }, web)
    const ref = { id: attempt.id, secret: attempt.attemptSecret ?? '' }
    await Flows.prepareFirstFactor(deps, tenant, ref, prepare(strategy), web)
    return ref
  }

  const steps: Record<
    string,
    (ref: { id: string; secret: string }, strategy: 'email_code' | 'email_link') => Promise<unknown>
  > = {
    prepare: (ref, strategy) => Flows.prepareFirstFactor(deps, tenant, ref, prepare(strategy), web),
    attempt: (ref, strategy) =>
      Flows.attemptFirstFactor(
        deps,
        tenant,
        ref,
        strategy === 'email_code' ? { strategy, code: '123456' } : { strategy },
        web
      ),
  }

  for (const strategy of ['email_code', 'email_link'] as const) {
    for (const [name, step] of Object.entries(steps)) {
      test(`${strategy}: ${name} is refused once the method is off`, async () => {
        const ref = await parked(strategy)
        seed({ emailCode: { enabled: strategy === 'email_link' }, emailLink: { enabled: false } })
        const err = await step(ref, strategy).catch((e: unknown) => e)
        expect((err as { code?: string }).code).toBe('auth.method_disabled')
      })
    }
  }
})
