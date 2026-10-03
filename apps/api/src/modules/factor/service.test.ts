import { afterEach, describe, expect, test } from 'bun:test'
import { DEFAULT_ENVIRONMENT_SETTINGS, type EnvironmentSettings } from '@tula/contract'
import type { Tenant } from '~/dependencies'
import * as Factors from '~/modules/factor/service'
import { createTestDeps, TEST_TENANT } from '~/testing'

const tenant: Tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const USER = '00000000-0000-7000-8000-0000000000a1'

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
  test('no user has a second factor yet', async () => {
    const deps = createTestDeps()
    expect(await Factors.requiredFor(deps, tenant, USER)).toEqual([])
  })
})

describe('verify', () => {
  afterEach(() => {
    delete Factors.SECOND_FACTOR_VERIFIERS.totp
  })

  test('no method can be proven while none has a verifier', async () => {
    const deps = createTestDeps()
    expect(Factors.SECOND_FACTOR_VERIFIERS).toEqual({})
    for (const method of ['totp', 'passkey', 'backup_code', 'sms_code'] as const) {
      expect(await Factors.verify(deps, tenant, USER, { method, response: '123456' })).toBe(false)
    }
  })

  test('asks the verifier registered for the method, and only that one', async () => {
    const deps = createTestDeps()
    const seen: unknown[] = []
    Factors.SECOND_FACTOR_VERIFIERS.totp = async (d, t, userId, response) => {
      seen.push([d === deps, t, userId, response])
      return response === '424242'
    }
    expect(await Factors.verify(deps, tenant, USER, { method: 'totp', response: '424242' })).toBe(
      true
    )
    expect(await Factors.verify(deps, tenant, USER, { method: 'totp', response: '000000' })).toBe(
      false
    )
    expect(
      await Factors.verify(deps, tenant, USER, { method: 'backup_code', response: '424242' })
    ).toBe(false)
    expect(seen).toEqual([
      [true, tenant, USER, '424242'],
      [true, tenant, USER, '000000'],
    ])
  })
})
