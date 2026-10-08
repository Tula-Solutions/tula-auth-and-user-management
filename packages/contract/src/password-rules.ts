/**
 * The password rule engine: evaluates a password against a policy.
 *
 * This module has no runtime dependency on Zod, so an SDK can import it from
 * `@tula/contract/password-rules` to draw a live checklist that agrees with the server without
 * adding a schema library to an application's bundle. The policy schema and the presets live in
 * `./password-policy`.
 */
import { COMMON_PASSWORDS } from './common-passwords'
import type { ErrorCode } from './error-codes'
import type { PasswordPolicy } from './password-policy'

/** ASCII punctuation counted as "special" by default. */
export const DEFAULT_SPECIAL_CHARS = '!@#$%^&*()-_=+[]{};:,.?/\\|\'"`~<>'

/** Rule identifiers shown in the live checklist. */
export type PasswordRule =
  | 'min_length'
  | 'max_length'
  | 'lowercase'
  | 'uppercase'
  | 'number'
  | 'special'
  | 'character_classes'
  | 'user_info'
  | 'common'
  | 'repeated_characters'
  | 'sequence'

/** The result of one rule. */
export interface PasswordCheck {
  /** Which rule this is. */
  rule: PasswordRule
  /** The error code to report when the rule fails. */
  code: ErrorCode
  /** Whether the password satisfies the rule. */
  passed: boolean
  /** Rule parameters for rendering, e.g. `{ min: 10 }`. */
  params?: Record<string, string | number | boolean>
}

/** Result of evaluating a password against a policy (breach check excluded; it's async). */
export interface PasswordEvaluation {
  /** True when every rule passed. */
  ok: boolean
  /** Every applicable rule, in checklist order. */
  checks: PasswordCheck[]
}

/** Personal details a password must not contain when `disallowUserInfo` is on. */
export interface PasswordUserInfo {
  email?: string
  firstName?: string
  lastName?: string
  username?: string
}

/**
 * Normalize a password before measuring or hashing it.
 *
 * NFC keeps visually identical Unicode passphrases (e.g. composed vs decomposed "é") equal on
 * every platform.
 *
 * @param password - The raw password.
 * @returns The NFC-normalized password.
 */
export function normalizePassword(password: string): string {
  return password.normalize('NFC')
}

const LOWER = /\p{Ll}/u
const UPPER = /\p{Lu}/u
const NUMBER = /\p{Nd}/u
const SEQUENCE_LENGTH = 4
const MIN_USER_INFO_LENGTH = 3

function longestRun(chars: readonly string[]): number {
  let longest = 0
  let current = 0
  for (let i = 0; i < chars.length; i++) {
    current = i > 0 && chars[i] === chars[i - 1] ? current + 1 : 1
    longest = Math.max(longest, current)
  }
  return longest
}

function hasSequence(chars: readonly string[]): boolean {
  const codes = chars.map((c) => c.toLowerCase().codePointAt(0) ?? 0)
  let ascending = 1
  let descending = 1
  for (let i = 1; i < codes.length; i++) {
    const step = (codes[i] ?? 0) - (codes[i - 1] ?? 0)
    ascending = step === 1 ? ascending + 1 : 1
    descending = step === -1 ? descending + 1 : 1
    if (ascending >= SEQUENCE_LENGTH || descending >= SEQUENCE_LENGTH) {
      return true
    }
  }
  return false
}

function userInfoTokens(info: PasswordUserInfo): string[] {
  const localPart = info.email?.split('@')[0]
  return [localPart, info.firstName, info.lastName, info.username]
    .map((value) => (value ? normalizePassword(value).trim().toLowerCase() : undefined))
    .filter((value): value is string => !!value && value.length >= MIN_USER_INFO_LENGTH)
}

/**
 * Evaluate a password against a policy and return every rule's result.
 *
 * Pure and synchronous so it runs identically on the server and inside SDKs (live checklist).
 * Length is measured in Unicode code points after NFC normalization, so emoji and accented
 * passphrases count the way users expect. The breached-password check is not included; the server
 * runs it separately.
 *
 * @param policy - The active password policy.
 * @param password - The candidate password.
 * @param userInfo - Personal details the password must not contain.
 * @returns `ok` plus the result of each applicable rule.
 *
 * @example
 * ```ts
 * const { ok, checks } = evaluatePassword(PASSWORD_POLICY_PRESETS.recommended, 'correct horse')
 * ```
 */
export function evaluatePassword(
  policy: PasswordPolicy,
  password: string,
  userInfo: PasswordUserInfo = {}
): PasswordEvaluation {
  const chars = [...normalizePassword(password)]
  const special = new Set([...policy.specialChars])
  const hasLower = chars.some((c) => LOWER.test(c))
  const hasUpper = chars.some((c) => UPPER.test(c))
  const hasNumber = chars.some((c) => NUMBER.test(c))
  const hasSpecial = chars.some((c) => special.has(c))
  const checks: PasswordCheck[] = []

  checks.push({
    rule: 'min_length',
    code: 'password.too_short',
    passed: chars.length >= policy.minLength,
    params: { min: policy.minLength },
  })
  checks.push({
    rule: 'max_length',
    code: 'password.too_long',
    passed: chars.length <= policy.maxLength,
    params: { max: policy.maxLength },
  })
  if (policy.requireLowercase) {
    checks.push({ rule: 'lowercase', code: 'password.missing_lowercase', passed: hasLower })
  }
  if (policy.requireUppercase) {
    checks.push({ rule: 'uppercase', code: 'password.missing_uppercase', passed: hasUpper })
  }
  if (policy.requireNumber) {
    checks.push({ rule: 'number', code: 'password.missing_number', passed: hasNumber })
  }
  if (policy.requireSpecial) {
    checks.push({ rule: 'special', code: 'password.missing_special', passed: hasSpecial })
  }
  if (policy.minCharacterClasses > 0) {
    const classes = [hasLower, hasUpper, hasNumber, hasSpecial].filter(Boolean).length
    checks.push({
      rule: 'character_classes',
      code: 'password.too_few_character_classes',
      passed: classes >= policy.minCharacterClasses,
      params: { min: policy.minCharacterClasses },
    })
  }
  if (policy.disallowUserInfo) {
    const lower = chars.join('').toLowerCase()
    checks.push({
      rule: 'user_info',
      code: 'password.contains_user_info',
      passed: !userInfoTokens(userInfo).some((token) => lower.includes(token)),
    })
  }
  if (policy.disallowCommon) {
    checks.push({
      rule: 'common',
      code: 'password.common',
      passed: !COMMON_PASSWORDS.has(chars.join('').toLowerCase()),
    })
  }
  if (policy.maxRepeatedChars !== null) {
    checks.push({
      rule: 'repeated_characters',
      code: 'password.repeated_characters',
      passed: longestRun(chars) <= policy.maxRepeatedChars,
      params: { max: policy.maxRepeatedChars },
    })
  }
  if (policy.blockSequences) {
    checks.push({ rule: 'sequence', code: 'password.sequence', passed: !hasSequence(chars) })
  }

  return { ok: checks.every((check) => check.passed), checks }
}
