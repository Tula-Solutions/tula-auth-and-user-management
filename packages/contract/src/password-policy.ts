import { z } from 'zod'
import { DEFAULT_SPECIAL_CHARS } from './password-rules'

// The rule engine is plain code in `./password-rules` (importable without Zod as
// `@tula/contract/password-rules`); this module adds the policy schema and the presets.
export * from './password-rules'

/**
 * The most passwords `history` may tell a server to remember for a user.
 *
 * A new password is compared with every one of them, and each comparison is a full argon2id
 * verification: about a second and a half of one core for all 24 (ADR 0038 has the
 * measurement and the limits that bound how often a caller can cause it). 24 is what the
 * strictest common baselines ask for.
 *
 * @example
 * ```ts
 * policy.history <= MAX_PASSWORD_HISTORY // true for every policy the schema accepts
 * ```
 */
export const MAX_PASSWORD_HISTORY = 24

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
    /**
     * How many of a user's last passwords, the current one included, cannot be set again;
     * 0 remembers none. With 1 only the current password is refused. A server keeps the
     * previous `history - 1` hashes and no more: lowering the number deletes the surplus, and
     * raising it cannot bring back what was not kept (ADR 0038).
     */
    history: z.number().int().min(0).max(MAX_PASSWORD_HISTORY),
    /**
     * Forced rotation: after this many days a password is too old to sign in with, and its
     * owner is taken through setting a new one at their next password sign-in. `null` = never
     * (NIST discourages forced rotation; it is offered for compliance). A password's age is
     * counted from when it was last set, and only a sign-in **with the password** looks at
     * it: an emailed code, a provider or a passkey signs in whatever the password's age
     * (ADR 0041).
     */
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
