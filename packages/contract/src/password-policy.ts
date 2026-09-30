import { z } from 'zod'
import { COMMON_PASSWORDS } from './common-passwords'
import type { ErrorCode, ErrorParams } from './errors'

/** ASCII punctuation counted as "special" by default. */
export const DEFAULT_SPECIAL_CHARS = '!@#$%^&*()-_=+[]{};:,.?/\\|\'"`~<>'

/**
 * A project's password rules (business plan §4.7).
 *
 * The same object is enforced by the server and rendered as a live checklist by every SDK, so
 * web, iOS and Android can never disagree about what's valid.
 */
export const PasswordPolicySchema = z
  .object({
    preset: z.enum(['recommended', 'strict', 'legacy', 'custom']),
    minLength: z.number().int().min(1).max(256),
    maxLength: z.number().int().min(8).max(1024),
    requireLowercase: z.boolean(),
    requireUppercase: z.boolean(),
    requireNumber: z.boolean(),
    requireSpecial: z.boolean(),
    /** Minimum distinct classes (lower, upper, number, special); 0 disables the rule. */
    minCharacterClasses: z.number().int().min(0).max(4),
    specialChars: z.string().min(1),
    disallowUserInfo: z.boolean(),
    disallowCommon: z.boolean(),
    breachCheck: z.enum(['off', 'warn', 'block']),
    /** Longest allowed run of one repeated character (e.g. 3 allows `aaa`, rejects `aaaa`). */
    maxRepeatedChars: z.number().int().min(1).nullable(),
    blockSequences: z.boolean(),
    /** Number of previous passwords that can't be reused (enforced from Phase 2). */
    history: z.number().int().min(0).max(24),
    /** Forced rotation in days, `null` = never (NIST discourages it; offered for compliance). */
    expiryDays: z.number().int().min(1).nullable(),
  })
  .refine((p) => p.maxLength >= p.minLength, {
    message: 'maxLength must be at least minLength',
    path: ['maxLength'],
  })
  .meta({ ref: 'PasswordPolicy' })

/** Password policy. */
export type PasswordPolicy = z.infer<typeof PasswordPolicySchema>

const BASE: Omit<PasswordPolicy, 'preset'> = {
  minLength: 10,
  maxLength: 128,
  requireLowercase: false,
  requireUppercase: false,
  requireNumber: false,
  requireSpecial: false,
  minCharacterClasses: 0,
  specialChars: DEFAULT_SPECIAL_CHARS,
  disallowUserInfo: true,
  disallowCommon: true,
  breachCheck: 'block',
  maxRepeatedChars: null,
  blockSequences: false,
  history: 0,
  expiryDays: null,
}

/**
 * Built-in presets. `recommended` follows NIST 800-63B (length + breach check, no forced
 * composition or rotation); `strict` and `legacy` exist because some customers' auditors require
 * composition rules.
 */
export const PASSWORD_POLICY_PRESETS: Readonly<
  Record<Exclude<PasswordPolicy['preset'], 'custom'>, PasswordPolicy>
> = {
  recommended: { ...BASE, preset: 'recommended' },
  strict: {
    ...BASE,
    preset: 'strict',
    minLength: 12,
    requireLowercase: true,
    requireUppercase: true,
    requireNumber: true,
    requireSpecial: true,
    maxRepeatedChars: 3,
    blockSequences: true,
    history: 5,
  },
  legacy: {
    ...BASE,
    preset: 'legacy',
    minLength: 8,
    requireLowercase: true,
    requireUppercase: true,
    requireNumber: true,
    requireSpecial: true,
    breachCheck: 'warn',
    expiryDays: 90,
  },
}

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
  params?: ErrorParams
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
