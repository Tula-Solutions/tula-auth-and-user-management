import type { ImportUserRow } from '@tula-tech/contract'
import {
  accepted,
  addCountNotes,
  DISABLED_USER,
  fitMetadata,
  NO_EMAIL,
  objectOf,
  pick,
  readHash,
  readRecords,
  refused,
  text,
  truthy,
  UNREADABLE_ROW,
  usableEmail,
} from './formats'
import type { ParsedExport, ParseInput, Refusal, SourceRow } from './types'

const DELETED: Refusal = {
  code: 'source.user_deleted',
  reason: 'The user is soft-deleted at Supabase (`deleted_at` is set).',
}

const ANONYMOUS: Refusal = {
  code: 'email.invalid',
  reason: 'The row is an anonymous user and has no email address.',
}

/** Whether a timestamp cell is set and, for `banned_until`, still ahead of `now`. */
function stillAhead(value: unknown, now: number): boolean {
  const iso = text(value)
  if (iso === undefined) {
    return false
  }
  const at = Date.parse(iso)
  return Number.isNaN(at) ? true : at > now
}

/**
 * Read Supabase's `auth.users`, exported as CSV or JSON from the SQL editor or `psql \copy`:
 * `id`, `email`, `encrypted_password` (bcrypt), `email_confirmed_at`, `raw_user_meta_data`,
 * `raw_app_meta_data`, `banned_until`, `deleted_at`, `is_anonymous`. A user with no
 * `encrypted_password` (magic link or OAuth) is imported without a password. A soft-deleted or
 * currently banned user is refused, not imported as a live account.
 *
 * @param input - The export's text.
 * @param now - The time to judge `banned_until` by.
 * @returns The users and notes.
 */
export function parseSupabase(input: ParseInput, now: number = Date.now()): ParsedExport {
  const notes: string[] = []
  const counts = { droppedMetadata: 0, passwordless: 0 }
  const records = readRecords(input.text, {
    containers: ['users', 'data'],
    csv: true,
    label: 'The Supabase export',
  })
  const rows: SourceRow[] = records.map((record, position) => {
    const row = position + 1
    if (record === null) {
      return refused(row, null, UNREADABLE_ROW)
    }
    const sourceId = text(pick(record, 'id'))
    const email = usableEmail(record.email)
    if (pick(record, 'deleted_at') !== undefined) {
      return refused(row, email ?? null, DELETED, sourceId)
    }
    if (email === undefined) {
      return refused(row, null, truthy(record.is_anonymous) ? ANONYMOUS : NO_EMAIL, sourceId)
    }
    if (stillAhead(record.banned_until, now)) {
      return refused(row, email, DISABLED_USER, sourceId)
    }
    const metaUser = objectOf(record.raw_user_meta_data)
    const user: ImportUserRow = {
      email,
      emailVerified: pick(record, 'email_confirmed_at', 'confirmed_at') !== undefined,
    }
    const nameValue = text(metaUser?.full_name) ?? text(metaUser?.name)
    if (nameValue !== undefined) {
      user.name = nameValue
    }
    if (sourceId !== undefined) {
      user.externalId = sourceId
    }
    const meta = fitMetadata({
      userMetadata: metaUser,
      appMetadata: objectOf(record.raw_app_meta_data),
    })
    if (meta === 'too_large') {
      counts.droppedMetadata += 1
    } else if (meta !== undefined) {
      user.metadata = { supabase: meta }
    }
    const hash = text(record.encrypted_password)
    if (hash !== undefined) {
      const read = readHash(hash)
      if (read.kind === 'password') {
        user.password = read.password
      } else if (input.allowPasswordless) {
        counts.passwordless += 1
      } else {
        return refused(row, email, read.refusal, sourceId)
      }
    }
    return accepted(row, email, user, sourceId)
  })
  addCountNotes(notes, counts)
  return { rows, organizations: [], memberships: [], notes }
}
