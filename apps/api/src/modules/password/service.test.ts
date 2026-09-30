import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { type ErrorCode, PASSWORD_POLICY_PRESETS, type PasswordPolicy } from '@tula/contract'
import { MemoryBreachChecker } from '~/adapters/memory/breach-checker'
import { ServiceException } from '~/exceptions'
import * as Passwords from '~/modules/password/service'
import { createTestDeps, TEST_CONFIG, TEST_TENANT, type TestDeps } from '~/testing'

const STRONG = 'correct horse battery staple'
const CURRENT_PARAMS = '$argon2id$v=19$m=65536,t=2,p=1$'

function depsWith(policy: Partial<PasswordPolicy> = {}, breached: string[] = []): TestDeps {
  return createTestDeps({
    config: {
      ...TEST_CONFIG,
      passwordPolicy: { ...PASSWORD_POLICY_PRESETS.recommended, ...policy },
    },
    breachChecker: new MemoryBreachChecker(breached),
  })
}

async function rejection(promise: Promise<unknown>): Promise<ServiceException> {
  try {
    await promise
  } catch (err) {
    if (err instanceof ServiceException) {
      return err
    }
    throw err
  }
  throw new Error('expected a rejection')
}

let verifySpy: ReturnType<typeof spyOn> | undefined
afterEach(() => {
  verifySpy?.mockRestore()
  verifySpy = undefined
})

describe('hash', () => {
  test('uses argon2id with the pinned parameters and a random salt', async () => {
    const first = await Passwords.hash(STRONG)
    const second = await Passwords.hash(STRONG)
    expect(first.startsWith(CURRENT_PARAMS)).toBe(true)
    expect(first).not.toContain(STRONG)
    expect(first).not.toBe(second)
  })

  test('refuses input longer than the hard cap instead of hashing it', async () => {
    const err = await rejection(Passwords.hash('a'.repeat(Passwords.MAX_PASSWORD_LENGTH + 1)))
    expect(err.code).toBe('password.too_long')
    expect(err.params).toEqual({ max: Passwords.MAX_PASSWORD_LENGTH })
  })
})

describe('verify', () => {
  test('accepts the right password and rejects a wrong one', async () => {
    const stored = await Passwords.hash(STRONG)
    expect(await Passwords.verify(stored, STRONG)).toBe(true)
    expect(await Passwords.verify(stored, `${STRONG}!`)).toBe(false)
  })

  test('treats composed and decomposed Unicode as the same password', async () => {
    const composed = 'café au lait sunrise'
    const decomposed = 'café au lait sunrise'
    const stored = await Passwords.hash(composed)
    expect(await Passwords.verify(stored, decomposed)).toBe(true)
  })

  test('an unknown user still runs one argon2id verify at the same cost', async () => {
    verifySpy = spyOn(Bun.password, 'verify')
    expect(await Passwords.verify(null, STRONG)).toBe(false)
    expect(verifySpy).toHaveBeenCalledTimes(1)
    const dummy = verifySpy.mock.calls[0]?.[1] as string
    // Same parameters as real hashes, otherwise unknown users would answer faster.
    expect(dummy.startsWith(CURRENT_PARAMS)).toBe(true)
    expect(Passwords.needsRehash(dummy)).toBe(false)
  })

  test('an unknown user is rejected even when the dummy password is guessed', async () => {
    // Whatever the dummy hash verifies to, a missing account can never sign in.
    verifySpy = spyOn(Bun.password, 'verify').mockResolvedValue(true)
    expect(await Passwords.verify(null, STRONG)).toBe(false)
  })

  test('rejects over-long input without hashing it, for known and unknown users', async () => {
    const stored = await Passwords.hash(STRONG)
    verifySpy = spyOn(Bun.password, 'verify')
    const huge = 'a'.repeat(Passwords.MAX_PASSWORD_LENGTH + 1)
    expect(await Passwords.verify(stored, huge)).toBe(false)
    expect(await Passwords.verify(null, huge)).toBe(false)
    expect(verifySpy).not.toHaveBeenCalled()
  })

  test('the length cap counts code points, not UTF-16 units', async () => {
    const stored = await Passwords.hash('🔒'.repeat(Passwords.MAX_PASSWORD_LENGTH))
    expect(await Passwords.verify(stored, '🔒'.repeat(Passwords.MAX_PASSWORD_LENGTH))).toBe(true)
  })
})

describe('needsRehash', () => {
  test.each([
    ['current parameters', CURRENT_PARAMS, false],
    ['a lower memory cost', '$argon2id$v=19$m=19456,t=2,p=1$', true],
    ['a lower time cost', '$argon2id$v=19$m=65536,t=1,p=1$', true],
    ['argon2i', '$argon2i$v=19$m=65536,t=2,p=1$', true],
    ['bcrypt', '$2b$10$abcdefghijklmnopqrstuv', true],
    ['garbage', 'not-a-hash', true],
  ])('%s → %p', (_name, prefix, expected) => {
    expect(Passwords.needsRehash(`${prefix}c2FsdA$aGFzaA`)).toBe(expected)
  })
})

describe('policy', () => {
  test("returns the deployment's configured policy for the environment", async () => {
    const deps = depsWith({ minLength: 14 })
    const policy = await Passwords.policy(deps, TEST_TENANT)
    expect(policy.minLength).toBe(14)
  })
})

describe('assess', () => {
  test('a strong password passes with no warnings', async () => {
    const deps = depsWith()
    expect(await Passwords.assess(deps, TEST_TENANT, STRONG)).toEqual({ warnings: [] })
    expect(deps.breachChecker.checks).toBe(1)
  })

  test('reports the first failed rule as the code and every failed rule per field', async () => {
    const deps = depsWith(PASSWORD_POLICY_PRESETS.strict)
    const err = await rejection(Passwords.assess(deps, TEST_TENANT, 'aaaa'))
    expect(err.status).toBe(422)
    expect(err.code).toBe('password.too_short')
    expect(err.params).toEqual({ min: 12 })
    const codes = err.errors?.map((e) => e.code)
    expect(codes).toEqual([
      'password.too_short',
      'password.missing_uppercase',
      'password.missing_number',
      'password.missing_special',
      'password.repeated_characters',
    ] satisfies ErrorCode[])
    expect(err.errors?.every((e) => e.field === 'password' && e.message.length > 0)).toBe(true)
    expect(err.errors?.[0]?.params).toEqual({ min: 12 })
  })

  test('rejects passwords containing the user’s details', async () => {
    const deps = depsWith()
    const err = await rejection(
      Passwords.assess(deps, TEST_TENANT, 'ada.lovelace-rocks-1815', {
        email: 'ada.lovelace@example.com',
      })
    )
    expect(err.code).toBe('password.contains_user_info')
  })

  test('skips the breach lookup when a local rule already failed', async () => {
    const deps = depsWith()
    await rejection(Passwords.assess(deps, TEST_TENANT, 'short'))
    expect(deps.breachChecker.checks).toBe(0)
  })

  test('blocks a breached password when the policy says block', async () => {
    const deps = depsWith({ breachCheck: 'block' }, [STRONG])
    const err = await rejection(Passwords.assess(deps, TEST_TENANT, STRONG))
    expect(err.status).toBe(422)
    expect(err.code).toBe('password.breached')
    expect(err.errors).toEqual([
      { field: 'password', code: 'password.breached', message: expect.any(String) },
    ])
  })

  test('only warns about a breached password when the policy says warn', async () => {
    const deps = depsWith({ breachCheck: 'warn' }, [STRONG])
    const { warnings } = await Passwords.assess(deps, TEST_TENANT, STRONG)
    expect(warnings).toEqual([
      { field: 'password', code: 'password.breached', message: expect.any(String) },
    ])
  })

  test('does not look the password up when the breach check is off', async () => {
    const deps = depsWith({ breachCheck: 'off' }, [STRONG])
    expect(await Passwords.assess(deps, TEST_TENANT, STRONG)).toEqual({ warnings: [] })
    expect(deps.breachChecker.checks).toBe(0)
  })

  test('fails open when the breach source is unavailable', async () => {
    // Blocking every sign-up during a third-party outage is worse than missing one breach check.
    const deps = depsWith({ breachCheck: 'block' }, [STRONG])
    deps.breachChecker.unavailable = true
    expect(await Passwords.assess(deps, TEST_TENANT, STRONG)).toEqual({ warnings: [] })
  })

  test('looks up the normalized password', async () => {
    const composed = 'café au lait sunrise'
    const deps = depsWith({ breachCheck: 'block' }, [composed])
    const err = await rejection(Passwords.assess(deps, TEST_TENANT, 'café au lait sunrise'))
    expect(err.code).toBe('password.breached')
  })
})
