import { z } from 'zod'

const EmailSchema = z.email().max(320)

/**
 * Normalize an email for lookups and uniqueness: trimmed and lowercased.
 *
 * Deliberately nothing provider-specific (no stripping `+tags` or dots): those rules differ per
 * provider and would merge addresses their owners consider distinct.
 *
 * @param email - The email as entered.
 * @returns The normalized email.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * Mask an email for display and logs, e.g. `m***@northline.app`.
 *
 * The mask has a fixed width so it does not reveal the length of the local part.
 *
 * @param email - The email to mask.
 * @returns The masked email, or `***` when it has no local part or domain.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at < 1 || at === email.length - 1) {
    return '***'
  }
  return `${email[0]}***${email.slice(at)}`
}

/**
 * Validate an email as entered and return both forms the system stores.
 *
 * @param input - The email as the user typed it.
 * @returns The trimmed email and its normalized form, or `null` when it is not a valid address.
 *
 * @example
 * ```ts
 * parseEmail(' Maya@Northline.app ') // { email: 'Maya@Northline.app', normalized: 'maya@northline.app' }
 * ```
 */
export function parseEmail(input: string): { email: string; normalized: string } | null {
  const email = input.trim()
  const normalized = normalizeEmail(email)
  return EmailSchema.safeParse(normalized).success ? { email, normalized } : null
}
