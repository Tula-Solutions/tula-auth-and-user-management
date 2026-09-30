import { describe, expect, test } from 'bun:test'
import {
  evaluatePassword,
  normalizePassword,
  PASSWORD_POLICY_PRESETS,
  type PasswordPolicy,
  PasswordPolicySchema,
  type PasswordRule,
} from './password-policy'

const { recommended, strict, legacy } = PASSWORD_POLICY_PRESETS

function failedRules(policy: PasswordPolicy, password: string, info = {}): PasswordRule[] {
  return evaluatePassword(policy, password, info)
    .checks.filter((check) => !check.passed)
    .map((check) => check.rule)
}

describe('presets', () => {
  test.each([
    ['recommended', recommended],
    ['strict', strict],
    ['legacy', legacy],
  ])('%s is a valid policy', (_, policy) => {
    expect(PasswordPolicySchema.parse(policy)).toEqual(policy)
  })

  test('recommended follows NIST: length + breach check, no composition or rotation', () => {
    expect(recommended.minLength).toBe(10)
    expect(recommended.breachCheck).toBe('block')
    expect(recommended.requireUppercase || recommended.requireSpecial).toBe(false)
    expect(recommended.expiryDays).toBeNull()
  })

  test('schema rejects maxLength below minLength', () => {
    expect(
      PasswordPolicySchema.safeParse({ ...recommended, maxLength: 8, minLength: 12 }).success
    ).toBe(false)
  })
})

describe('evaluatePassword with the recommended preset', () => {
  test.each([
    ['correct horse battery', []],
    ['short', ['min_length']],
    ['password123', ['common']],
    ['PASSWORD123', ['common']],
    ['maya-loves-hiking', ['user_info']],
  ] as const)('%p fails %p', (password, expected) => {
    expect(failedRules(recommended, password, { email: 'maya@northline.app' })).toEqual([
      ...expected,
    ])
  })

  test('reports the rule parameters for the checklist', () => {
    const minLength = evaluatePassword(recommended, 'x').checks.find((c) => c.rule === 'min_length')
    expect(minLength).toEqual({
      rule: 'min_length',
      code: 'password.too_short',
      passed: false,
      params: { min: 10 },
    })
  })

  test('counts Unicode code points, not UTF-16 units', () => {
    // 10 emoji = 20 UTF-16 code units but 10 characters.
    expect(failedRules(recommended, '🦦🦦🦦🦦🦦🦦🦦🦦🦦🦦')).toEqual([])
    expect(failedRules(recommended, '🦦🦦🦦🦦🦦🦦🦦🦦🦦')).toEqual(['min_length'])
  })

  test('allows spaces and long passphrases up to maxLength', () => {
    expect(failedRules(recommended, 'a'.repeat(128))).toEqual([])
    expect(failedRules(recommended, 'a'.repeat(129))).toEqual(['max_length'])
  })

  test('ignores user info shorter than 3 characters', () => {
    expect(failedRules(recommended, 'al-is-a-good-name', { firstName: 'Al' })).toEqual([])
  })

  test('checks first name, last name and username too', () => {
    const info = { firstName: 'Maya', lastName: 'Torres', username: 'mtorres' }
    expect(failedRules(recommended, 'xx-torres-xx-yy', info)).toEqual(['user_info'])
    expect(failedRules(recommended, 'mtorres-2026!!', info)).toEqual(['user_info'])
  })
})

describe('evaluatePassword with the strict preset', () => {
  test('passes a strong password', () => {
    expect(evaluatePassword(strict, 'Tidal-Otter-42-Kelp').ok).toBe(true)
  })

  test.each([
    ['tidal-otter-42-kelp', ['uppercase']],
    ['TIDAL-OTTER-42-KELP', ['lowercase']],
    ['Tidal-Otter-Kelp-Bed', ['number']],
    ['TidalOtter42KelpBed', ['special']],
    ['Tidal-Otterrrr-42!', ['repeated_characters']],
    ['Tidal-Otter-1234!', ['sequence']],
    ['Tidal-Otter-dcba-9!', ['sequence']],
  ] as const)('%p fails %p', (password, expected) => {
    expect(failedRules(strict, password)).toEqual([...expected])
  })
})

describe('minCharacterClasses', () => {
  const policy: PasswordPolicy = { ...recommended, preset: 'custom', minCharacterClasses: 3 }

  test.each([
    ['onlylowercaseletters', false],
    ['lowerUPPERmixed', false],
    ['lowerUPPER123', true],
    ['lower123!!!???', true],
  ])('%p meets 3 classes: %p', (password, passes) => {
    expect(failedRules(policy, password).includes('character_classes')).toBe(!passes)
  })
})

describe('legacy preset', () => {
  test('requires every character class and rotates every 90 days', () => {
    expect(legacy.expiryDays).toBe(90)
    expect(failedRules(legacy, 'abcdefgh')).toEqual(['uppercase', 'number', 'special'])
  })
})

describe('normalizePassword', () => {
  test('composed and decomposed forms evaluate identically', () => {
    const composed = 'café-au-lait'
    const decomposed = 'café-au-lait'
    expect(normalizePassword(composed)).toBe(normalizePassword(decomposed))
    expect(evaluatePassword(recommended, decomposed)).toEqual(
      evaluatePassword(recommended, composed)
    )
  })
})

describe('user info matching is Unicode-normalized (F2)', () => {
  const composed = 'José'
  const decomposed = 'José'

  test.each([
    ['composed name, decomposed password', composed, `my-${decomposed.toLowerCase()}-zebra-quilt`],
    ['decomposed name, composed password', decomposed, `my-${composed.toLowerCase()}-zebra-quilt`],
    ['decomposed both', decomposed, `my-${decomposed.toLowerCase()}-zebra-quilt`],
  ])('%s fails user_info', (_, firstName, password) => {
    expect(failedRules(recommended, password, { firstName })).toEqual(['user_info'])
  })
})
