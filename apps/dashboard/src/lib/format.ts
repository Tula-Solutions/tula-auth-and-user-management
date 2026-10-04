const DATE_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/**
 * A timestamp as the operator's locale writes it.
 *
 * @param iso - An ISO time from the API, or nothing.
 * @param fallback - What to show when there is none.
 * @returns The formatted time; the fallback for a missing or unreadable one.
 */
export function formatDateTime(iso: string | null | undefined, fallback = 'Never'): string {
  if (!iso) {
    return fallback
  }
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? fallback : DATE_TIME.format(date)
}

/**
 * A person's name from its parts.
 *
 * @param user - First and last name, either of which may be missing.
 * @returns The name, or an empty string when there is none.
 */
export function fullName(user: { firstName: string | null; lastName: string | null }): string {
  return [user.firstName, user.lastName].filter(Boolean).join(' ')
}

/**
 * Whether a URL from the server may be made a link: absolute `https:` only.
 *
 * @param value - The URL as text.
 * @returns True when it parses and its scheme is https.
 */
export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}
