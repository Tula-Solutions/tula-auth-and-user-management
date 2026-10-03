import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  type EnvironmentSettings,
  SecondFactorMethodSchema,
} from '@tula/contract'
import type { Tenant } from '~/dependencies'
import type { Actor } from '~/lib/actor'
import { base32Decode, totp } from '~/lib/totp'
import * as Factors from '~/modules/factor/service'
import * as Mfa from '~/modules/mfa/service'
import * as Notices from '~/modules/notice/service'
import { createTestDeps, TEST_TENANT, type TestDeps } from '~/testing'

const tenant: Tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const otherTenant: Tenant = { ...tenant, environmentId: TEST_TENANT.productionEnvironmentId }
const USER = '00000000-0000-7000-8000-0000000000a1'
const actor: Actor = { type: 'user', id: USER, ipAddress: '203.0.113.7', userAgent: 'tests/1.0' }
let deps: TestDeps

beforeEach(async () => {
  deps = createTestDeps()
  await deps.users.create({
    id: USER,
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
    passwordHash: null,
  })
})

afterEach(() => Notices.settled())

const codeFor = (secret: string) => totp(base32Decode(secret), deps.clock.now())

/** Turn two-step verification on for `USER`; the confirming code's step is then spent. */
async function enrol() {
  const { secret } = await Mfa.startTotp(deps, tenant, USER)
  const { codes } = await Mfa.confirmTotp(deps, tenant, { userId: USER }, codeFor(secret), actor)
  deps.clock.advance('30s')
  return { secret, codes }
}

function withPolicy(policy: EnvironmentSettings['mfa']['policy'], environmentId: string) {
  deps.environmentSettings.seed(environmentId, {
    revision: 1,
    settings: { ...DEFAULT_ENVIRONMENT_SETTINGS, mfa: { policy } },
  })
}

function settings(passwordEnabled: boolean): EnvironmentSettings {
  return {
    ...DEFAULT_ENVIRONMENT_SETTINGS,
    signIn: {
      methods: {
        ...DEFAULT_ENVIRONMENT_SETTINGS.signIn.methods,
        password: { enabled: passwordEnabled },
      },
    },
  }
}

describe('firstFactors', () => {
  test('lists the password when the environment has it switched on', () => {
    expect(Factors.firstFactors(DEFAULT_ENVIRONMENT_SETTINGS)).toEqual(['password'])
    expect(Factors.firstFactors(settings(true))).toEqual(['password'])
  })

  test('lists the email strategies an environment has switched on, after the password', () => {
    const withEmail = (emailCode: boolean, emailLink: boolean, password = true) => ({
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      signIn: {
        methods: {
          password: { enabled: password },
          emailCode: { enabled: emailCode },
          emailLink: { enabled: emailLink },
        },
      },
    })
    expect(Factors.firstFactors(withEmail(true, false))).toEqual(['password', 'email_code'])
    expect(Factors.firstFactors(withEmail(true, true))).toEqual([
      'password',
      'email_code',
      'email_link',
    ])
    expect(Factors.firstFactors(withEmail(true, true, false))).toEqual(['email_code', 'email_link'])
  })

  test('each email strategy names the setting that switches it on', () => {
    expect(Factors.EMAIL_FACTOR_METHODS).toEqual({
      email_code: 'emailCode',
      email_link: 'emailLink',
    })
  })

  test('lists nothing when every method is switched off', () => {
    expect(Factors.firstFactors(settings(false))).toEqual([])
  })

  test('takes the settings and nothing else, so the answer cannot depend on an account', () => {
    // One parameter: there is no way to pass an identifier or a user.
    expect(Factors.firstFactors).toHaveLength(1)
  })
})

describe('requiredFor', () => {
  test('a user with no factor is asked for nothing', async () => {
    expect(await Factors.requiredFor(deps, tenant, USER)).toEqual([])
    expect(await Factors.requiredFor(deps, tenant, 'nobody')).toEqual([])
  })

  test('a pending enrolment is not a factor', async () => {
    await Mfa.startTotp(deps, tenant, USER)
    expect(await Factors.requiredFor(deps, tenant, USER)).toEqual([])
  })

  test('a confirmed authenticator is asked for, with a backup code while one is left', async () => {
    await enrol()
    expect(await Factors.requiredFor(deps, tenant, USER)).toEqual(['totp', 'backup_code'])
    await deps.factors.replaceBackupCodes(tenant.environmentId, USER, tenant, [], deps.clock.now())
    expect(await Factors.requiredFor(deps, tenant, USER)).toEqual(['totp'])
  })

  test.each<[EnvironmentSettings['mfa']['policy']]>([['off'], ['optional'], ['required']])(
    'the policy `%s` does not change what a user who has a factor is asked for',
    async (policy) => {
      await enrol()
      withPolicy(policy, tenant.environmentId)
      expect(await Factors.requiredFor(deps, tenant, USER)).toEqual(['totp', 'backup_code'])
    }
  )

  test('a factor of one environment is not asked for in another', async () => {
    await enrol()
    expect(await Factors.requiredFor(deps, otherTenant, USER)).toEqual([])
  })

  test('once turned off it is no longer asked for', async () => {
    await enrol()
    await Mfa.disableTotp(deps, tenant, USER, actor)
    expect(await Factors.requiredFor(deps, tenant, USER)).toEqual([])
  })
})

describe('enrolmentRequired', () => {
  type Policy = EnvironmentSettings['mfa']['policy']
  type Methods = Parameters<typeof Factors.enrolmentRequired>[2]

  // Only a user with nothing to prove, where a second factor is required, must enrol.
  test.each<[Policy, Methods, boolean]>([
    ['off', [], false],
    ['optional', [], false],
    ['required', [], true],
    ['off', ['totp'], false],
    ['optional', ['totp', 'backup_code'], false],
    ['required', ['totp'], false],
    ['required', ['totp', 'backup_code'], false],
  ])('policy %s, factors %j: %p', async (policy, secondFactors, expected) => {
    withPolicy(policy, tenant.environmentId)
    expect(await Factors.enrolmentRequired(deps, tenant, secondFactors)).toBe(expected)
  })

  test('an environment that has saved nothing does not require one', async () => {
    expect(await Factors.enrolmentRequired(deps, tenant, [])).toBe(false)
  })

  test('reads the policy of the environment asked about, not another’s', async () => {
    withPolicy('required', otherTenant.environmentId)
    expect(await Factors.enrolmentRequired(deps, tenant, [])).toBe(false)
    expect(await Factors.enrolmentRequired(deps, otherTenant, [])).toBe(true)
  })

  test('the only method that can be enrolled inside an attempt is the authenticator', () => {
    expect(Factors.ENROLMENT_METHODS).toEqual(['totp'])
  })
})

describe('the second-factor registry', () => {
  test('an authenticator and backup codes have a verifier; nothing else does', () => {
    expect(Object.keys(Factors.SECOND_FACTOR_VERIFIERS).sort()).toEqual(['backup_code', 'totp'])
    for (const method of SecondFactorMethodSchema.options) {
      expect([method, typeof Factors.SECOND_FACTOR_VERIFIERS[method]]).toEqual([
        method,
        method === 'totp' || method === 'backup_code' ? 'function' : 'undefined',
      ])
    }
  })
})

describe('verify', () => {
  const verify = (method: Factors.SecondFactorProof['method'], response: unknown, t = tenant) =>
    Factors.verify(deps, t, USER, { method, response }, actor)

  test('a right authenticator code proves `otp`, once', async () => {
    const { secret } = await enrol()
    const code = codeFor(secret)
    expect(await verify('totp', code)).toEqual({ methods: ['otp'] })
    expect(await verify('totp', code)).toBeNull()
  })

  test('a right backup code proves `backup_code` and says how many are left, once', async () => {
    const { codes } = await enrol()
    expect(await verify('backup_code', codes[0])).toEqual({
      methods: ['backup_code'],
      backupCodesRemaining: 9,
    })
    expect(await verify('backup_code', codes[0])).toBeNull()
    expect(await verify('backup_code', codes[1])).toEqual({
      methods: ['backup_code'],
      backupCodesRemaining: 8,
    })
    // The use is recorded with the actor the engine passed in.
    expect(deps.activityLog.ofType('user.backup_code_used')).toHaveLength(2)
    expect(deps.activityLog.ofType('user.backup_code_used')[0]).toMatchObject({
      actor: { type: 'user', id: USER },
      ipAddress: '203.0.113.7',
      userAgent: 'tests/1.0',
    })
  })

  test('the last backup code leaves none', async () => {
    const { codes } = await enrol()
    for (const [index, code] of codes.entries()) {
      expect(await verify('backup_code', code)).toEqual({
        methods: ['backup_code'],
        backupCodesRemaining: 9 - index,
      })
    }
    expect(await Factors.requiredFor(deps, tenant, USER)).toEqual(['totp'])
  })

  test('a wrong response proves nothing and never throws', async () => {
    const { secret, codes } = await enrol()
    for (const response of ['000000', '', 'zzzzz-zzzzz', 123456, null, undefined, {}, []]) {
      if (response !== codeFor(secret)) {
        expect(await verify('totp', response)).toBeNull()
      }
      expect(await verify('backup_code', response)).toBeNull()
    }
    // A proof of one method is not accepted as the other.
    expect(await verify('totp', codes[0])).toBeNull()
    expect(await verify('backup_code', codeFor(secret))).toBeNull()
    expect(deps.activityLog.ofType('user.backup_code_used')).toEqual([])
  })

  test('a method with no verifier can never be proven, whatever is submitted', async () => {
    const { secret, codes } = await enrol()
    for (const method of ['passkey', 'sms_code'] as const) {
      for (const response of [codeFor(secret), codes[0], '123456', true]) {
        expect(await verify(method, response)).toBeNull()
      }
    }
    // Nothing was spent by the refusals.
    expect(await verify('totp', codeFor(secret))).toEqual({ methods: ['otp'] })
    expect(await Mfa.status(deps, tenant, USER)).toMatchObject({ backupCodes: { remaining: 10 } })
  })

  test('a user with no factor, a pending one, or one in another environment proves nothing', async () => {
    expect(await verify('totp', '123456')).toBeNull()
    const { secret } = await Mfa.startTotp(deps, tenant, USER)
    expect(await verify('totp', codeFor(secret))).toBeNull()
    await Mfa.confirmTotp(deps, tenant, { userId: USER }, codeFor(secret), actor)
    deps.clock.advance('30s')
    expect(await verify('totp', codeFor(secret), otherTenant)).toBeNull()
    expect(await verify('totp', codeFor(secret))).toEqual({ methods: ['otp'] })
  })

  describe('with a verifier of another shape registered', () => {
    const registry: Record<string, Factors.SecondFactorVerifier | undefined> =
      Factors.SECOND_FACTOR_VERIFIERS
    afterEach(() => {
      delete registry.passkey
    })

    test('asks the verifier registered for the method, and only that one, with everything it needs', async () => {
      const seen: unknown[] = []
      registry.passkey = async (d, t, userId, response, by) => {
        seen.push([d === deps, t, userId, response, by])
        return response === 'assertion'
      }
      // A verifier that answers `true` proves the method and adds nothing to `amr`.
      expect(await verify('passkey', 'assertion')).toEqual({ methods: [] })
      expect(await verify('passkey', 'forged')).toBeNull()
      expect(await verify('sms_code', 'assertion')).toBeNull()
      expect(seen).toEqual([
        [true, tenant, USER, 'assertion', actor],
        [true, tenant, USER, 'forged', actor],
      ])
    })
  })
})
