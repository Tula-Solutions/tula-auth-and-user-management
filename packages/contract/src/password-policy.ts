import { z } from 'zod'
import { DEFAULT_SPECIAL_CHARS } from './password-rules'

// The rule engine is plain code in `./password-rules` (importable without Zod as
// `@tula/contract/password-rules`); this module adds the policy schema and the presets.
export * from './password-rules'

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
