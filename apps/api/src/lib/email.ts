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
