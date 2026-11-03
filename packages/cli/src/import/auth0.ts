import type { ImportUserRow } from '@tula-tech/contract'
import {
  accepted,
  addCountNotes,
  DISABLED_USER,
  fitMetadata,
  type ImportPassword,
  isRecord,
  NO_EMAIL,
  objectOf,
  pick,
  type RawRecord,
  readHash,
  readRecords,
  refused,
  text,
  truthy,
  UNREADABLE_ROW,
  usableEmail,
} from './formats'
import type { ParsedExport, ParseInput, Refusal, SourceRow } from './types'

/** The `_id` of an entry of Auth0's password hash export: `{ "$oid": "…" }` or the text. */
function oidOf(record: RawRecord): string | undefined {
  const id = record._id
  if (isRecord(id)) {
    return text(id.$oid)
  }
  return text(id)
}

/** Password hashes from the file Auth0 support exports, by `auth0|<oid>` and by address. */
interface HashIndex {
  byId: Map<string, string>
  byEmail: Map<string, string[]>
  /** Entries that no user used. */
  unused: Set<string>
  unreadable: number
}

function indexHashes(source: string | undefined): HashIndex {
  const index: HashIndex = {
    byId: new Map(),
    byEmail: new Map(),
    unused: new Set(),
    unreadable: 0,
  }
  if (source === undefined) {
    return index
  }
  const records = readRecords(source, {
    containers: ['users', 'data'],
    csv: false,
    label: 'The password hash file',
  })
  records.forEach((record, position) => {
    const hash = record === null ? undefined : text(pick(record, 'passwordHash', 'password_hash'))
    if (record === null || hash === undefined) {
      index.unreadable += 1
      return
    }
    const key = String(position)
    index.unused.add(key)
    const oid = oidOf(record)
    if (oid !== undefined) {
      index.byId.set(`auth0|${oid}`, `${key}\n${hash}`)
    }
    const email = usableEmail(record.email)?.toLowerCase()
    if (email !== undefined) {
      index.byEmail.set(email, [...(index.byEmail.get(email) ?? []), `${key}\n${hash}`])
    }
  })
  return index
}

/** Look a user's hash up: by id first, then by address when only one entry has it. */
function hashFor(index: HashIndex, userId: string | undefined, email: string): string | undefined {
  const found =
    (userId === undefined ? undefined : index.byId.get(userId)) ??
    (index.byEmail.get(email.toLowerCase())?.length === 1
      ? index.byEmail.get(email.toLowerCase())?.[0]
      : undefined)
  if (found === undefined) {
    return undefined
  }
  const [key, ...rest] = found.split('\n')
  index.unused.delete(key as string)
  return rest.join('\n')
}

const UNSUPPORTED: Refusal = {
  code: 'import.unsupported_algorithm',
  reason:
    'The password hash is in a format the server does not read. Auth0 password hashes are bcrypt; custom_password_hash is read for bcrypt and argon2 only.',
}

/** The password of Auth0's `custom_password_hash` import field (bcrypt and argon2 only). */
function customHash(
  value: unknown
): { password: ImportPassword } | { refusal: Refusal } | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const algorithm = text(value.algorithm)?.toLowerCase()
  const hash = isRecord(value.hash) ? text(value.hash.value) : undefined
  if (hash === undefined) {
    return { refusal: UNSUPPORTED }
  }
  if (algorithm === 'bcrypt' || algorithm === 'argon2') {
    const read = readHash(hash)
    return read.kind === 'password' ? { password: read.password } : { refusal: read.refusal }
  }
  return { refusal: UNSUPPORTED }
}

/**
 * Read an Auth0 bulk user export (NDJSON or a JSON array: `user_id`, `email`, `email_verified`,
 * `name`, `given_name`, `family_name`, `user_metadata`, `app_metadata`, `blocked`). Auth0 does
 * not export password hashes with it: they come in a separate file from a support request
 * (`--password-hashes`, NDJSON with `_id.$oid`, `email` and `passwordHash`, which are bcrypt),
 * joined to the users by `auth0|<oid>`, else by an address that one entry has. A user may also
 * carry `custom_password_hash` (Auth0's import format). A social or passwordless user has no
 * password and is imported without one.
 *
 * @param input - The export's text and the hash file.
 * @returns The users and notes.
 */
export function parseAuth0(input: ParseInput): ParsedExport {
  const notes: string[] = []
  const counts = { droppedMetadata: 0, passwordless: 0 }
  const hashes = indexHashes(input.files['password-hashes'])
  const records = readRecords(input.text, {
    containers: ['users', 'data'],
    csv: false,
    label: 'The Auth0 export',
  })
  let databaseUsers = 0
  let withHash = 0
  const rows: SourceRow[] = records.map((record, position) => {
    const row = position + 1
    if (record === null) {
      return refused(row, null, UNREADABLE_ROW)
    }
    const sourceId = text(pick(record, 'user_id', 'id'))
    const email = usableEmail(record.email)
    if (email === undefined) {
      return refused(row, null, NO_EMAIL, sourceId)
    }
    if (truthy(record.blocked)) {
      return refused(row, email, DISABLED_USER, sourceId)
    }
    const user: ImportUserRow = { email, emailVerified: truthy(record.email_verified) }
    const name =
      text(record.name) ??
      [text(record.given_name), text(record.family_name)]
        .filter((part) => part !== undefined)
        .join(' ')
    if (name !== undefined && name !== '') {
      user.name = name
    }
    if (sourceId !== undefined) {
      user.externalId = sourceId
    }
    const meta = fitMetadata({
      userMetadata: objectOf(record.user_metadata),
      appMetadata: objectOf(record.app_metadata),
      username: text(record.username),
    })
    if (meta === 'too_large') {
      counts.droppedMetadata += 1
    } else if (meta !== undefined) {
      user.metadata = { auth0: meta }
    }
    if (sourceId?.startsWith('auth0|')) {
      databaseUsers += 1
    }
    const direct =
      text(pick(record, 'passwordHash', 'password_hash')) ?? hashFor(hashes, sourceId, email)
    const found =
      direct !== undefined
        ? (() => {
            const read = readHash(direct)
            return read.kind === 'password'
              ? { password: read.password }
              : { refusal: read.refusal }
          })()
        : customHash(record.custom_password_hash)
    if (found !== undefined) {
      if ('password' in found) {
        user.password = found.password
        withHash += 1
      } else {
        if (!input.allowPasswordless) {
          return refused(row, email, found.refusal, sourceId)
        }
        counts.passwordless += 1
      }
    }
    return accepted(row, email, user, sourceId)
  })
  if (input.files['password-hashes'] === undefined && databaseUsers > 0) {
    notes.push(
      `${databaseUsers} user(s) are database-connection users, and Auth0 does not put password hashes in the user export. Without --password-hashes they are imported without a password and reset it. See the Auth0 guide for how to ask Auth0 support for the hashes.`
    )
  } else if (input.files['password-hashes'] !== undefined) {
    if (hashes.unused.size > 0) {
      notes.push(
        `${hashes.unused.size} entr${hashes.unused.size === 1 ? 'y' : 'ies'} of the password hash file matched no user of the export.`
      )
    }
    if (hashes.unreadable > 0) {
      notes.push(
        `${hashes.unreadable} line(s) of the password hash file had no readable passwordHash.`
      )
    }
    if (withHash === 0) {
      notes.push(
        'No password hash was matched to a user: check that the two files are from the same tenant.'
      )
    }
  }
  addCountNotes(notes, counts)
  return { rows, organizations: [], memberships: [], notes }
}
