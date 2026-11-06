import { CreateOrganizationRequestSchema, type ImportUserRow } from '@tula-tech/contract'
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
import type {
  ParsedExport,
  ParseInput,
  Refusal,
  SourceMembership,
  SourceOrganization,
  SourceRow,
} from './types'

/** Clerk's `password_hasher` values this server reads, as the import's algorithm names. */
const HASHERS: Readonly<Record<string, ImportPassword['algorithm']>> = {
  bcrypt: 'bcrypt',
  argon2id: 'argon2id',
  argon2i: 'argon2i',
  pbkdf2_sha256: 'pbkdf2_sha256',
  pbkdf2_sha256_django: 'pbkdf2_sha256',
}

const FIREBASE_HASHER: Refusal = {
  code: 'import.unsupported_algorithm',
  reason:
    'The password is hashed with Firebase scrypt, whose project parameters a Clerk export does not hold. Import from the Firebase export with `--from firebase`, or use --allow-passwordless.',
}

/** The refusal of a hasher this server does not read. */
const UNKNOWN_HASHER: Refusal = {
  code: 'import.unsupported_algorithm',
  reason:
    "The password was hashed with an algorithm the server does not read (it reads bcrypt, argon2id, argon2i and PBKDF2-SHA256). Clerk's md5, sha256, scrypt, phpass and LDAP hashers are not supported.",
}

/** Addresses a Clerk CSV lists in one cell, separated by commas or semicolons. */
function addressList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => addressList(entry))
  }
  const single = text(value)
  return single === undefined
    ? []
    : single
        .split(/[,;]/)
        .map((part) => part.trim().toLowerCase())
        .filter((part) => part !== '')
}

/** The user's address, and whether Clerk had verified it, from a CSV row or the Backend API's JSON. */
function emailOf(record: RawRecord): { email: string | undefined; verified: boolean } {
  const listed = pick(record, 'email_addresses', 'emailAddresses')
  if (Array.isArray(listed)) {
    const primaryId = text(pick(record, 'primary_email_address_id', 'primaryEmailAddressId'))
    const entries = listed.filter(isRecord)
    const chosen = entries.find((entry) => entry.id === primaryId) ?? entries[0]
    if (chosen) {
      const status = isRecord(chosen.verification) ? chosen.verification.status : undefined
      return {
        email: usableEmail(pick(chosen, 'email_address', 'emailAddress', 'email')),
        verified: status === 'verified',
      }
    }
  }
  const email = usableEmail(
    pick(record, 'primary_email_address', 'primaryEmailAddress', 'email', 'email_address')
  )
  const verified = addressList(pick(record, 'verified_email_addresses', 'verifiedEmailAddresses'))
  return { email, verified: email !== undefined && verified.includes(email.toLowerCase()) }
}

/** The password of a user, or why it cannot be carried. */
function passwordOf(
  record: RawRecord
): { password: ImportPassword } | { refusal: Refusal } | undefined {
  const digest = text(pick(record, 'password_digest', 'passwordDigest'))
  if (digest === undefined) {
    return undefined
  }
  const hasher = text(pick(record, 'password_hasher', 'passwordHasher'))?.toLowerCase()
  if (hasher === undefined) {
    const read = readHash(digest)
    return read.kind === 'password' ? { password: read.password } : { refusal: read.refusal }
  }
  if (hasher === 'scrypt_firebase') {
    return { refusal: FIREBASE_HASHER }
  }
  const algorithm = Object.hasOwn(HASHERS, hasher) ? HASHERS[hasher] : undefined
  return algorithm === undefined
    ? { refusal: UNKNOWN_HASHER }
    : { password: { algorithm, hash: digest } }
}

/** What Clerk keeps beside a user, to keep with them. */
function metadataOf(record: RawRecord): RawRecord {
  const keep: RawRecord = {}
  const username = text(pick(record, 'username'))
  if (username !== undefined) {
    keep.username = username
  }
  for (const [key, spellings] of [
    ['publicMetadata', ['public_metadata', 'publicMetadata']],
    ['privateMetadata', ['private_metadata', 'privateMetadata']],
    ['unsafeMetadata', ['unsafe_metadata', 'unsafeMetadata']],
  ] as const) {
    const value = objectOf(pick(record, ...spellings))
    if (value !== undefined && Object.keys(value).length > 0) {
      keep[key] = value
    }
  }
  return keep
}

/**
 * Read a Clerk user export: the dashboard's CSV (`id`, `first_name`, `last_name`, `username`,
 * `primary_email_address`, `verified_email_addresses`, `password_digest`, `password_hasher`,
 * `totp_secret`, …) or JSON from the Backend API (`email_addresses`, `public_metadata`, …).
 * With `--organizations` and `--memberships` it also reads Clerk's organizations and their
 * memberships. Clerk's own two-step secrets (`totp_secret`) are not carried over.
 *
 * @param input - The export's text and the other files.
 * @returns The users, organizations, memberships and notes.
 */
export function parseClerk(input: ParseInput): ParsedExport {
  const notes: string[] = []
  const counts = { droppedMetadata: 0, passwordless: 0 }
  const records = readRecords(input.text, {
    containers: ['data', 'users'],
    csv: true,
    label: 'The Clerk export',
  })
  let withTotp = 0
  const rows: SourceRow[] = records.map((record, position) => {
    const row = position + 1
    if (record === null) {
      return refused(row, null, UNREADABLE_ROW)
    }
    const sourceId = text(pick(record, 'id', 'user_id', 'userId'))
    const { email, verified } = emailOf(record)
    if (email === undefined) {
      return refused(row, null, NO_EMAIL, sourceId)
    }
    if (truthy(pick(record, 'banned', 'locked'))) {
      return refused(row, email, DISABLED_USER, sourceId)
    }
    if (text(pick(record, 'totp_secret', 'totpSecret')) !== undefined) {
      withTotp += 1
    }
    const user: ImportUserRow = { email, emailVerified: verified }
    const name = [
      text(pick(record, 'first_name', 'firstName')),
      text(pick(record, 'last_name', 'lastName')),
    ]
      .filter((part) => part !== undefined)
      .join(' ')
    if (name !== '') {
      user.name = name
    }
    if (sourceId !== undefined) {
      user.externalId = sourceId
    }
    const meta = fitMetadata(metadataOf(record))
    if (meta === 'too_large') {
      counts.droppedMetadata += 1
    } else if (meta !== undefined) {
      user.metadata = { clerk: meta }
    }
    const password = passwordOf(record)
    if (password !== undefined) {
      if ('password' in password) {
        user.password = password.password
      } else {
        if (!input.allowPasswordless) {
          return refused(row, email, password.refusal, sourceId)
        }
        counts.passwordless += 1
      }
    }
    return accepted(row, email, user, sourceId)
  })
  if (withTotp > 0) {
    notes.push(
      `${withTotp} user(s) had an authenticator app at Clerk. Two-step verification is not carried over: they enrol again in Tula.`
    )
  }
  addCountNotes(notes, counts)
  const { organizations, memberships } = parseOrganizations(input, notes)
  return { rows, organizations, memberships, notes }
}

/** Tula's slug for a name or a Clerk slug: lower case, letters and digits joined by hyphens. */
function slugOf(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
}

/** A Clerk role key (`org:admin`) as a Tula role key (`admin`). */
function roleOf(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined
  }
  const key = value
    .toLowerCase()
    .replace(/^org:/, '')
    .replace(/[^a-z0-9_]+/g, '_')
  return key === 'basic_member' ? 'member' : key
}

/** The records of a Clerk API list: an array, or `{ "data": [...] }`, or NDJSON. */
function listOf(source: string | undefined, label: string): (RawRecord | null)[] {
  return source === undefined
    ? []
    : readRecords(source, { containers: ['data'], csv: false, label })
}

function parseOrganizations(
  input: ParseInput,
  notes: string[]
): Pick<ParsedExport, 'organizations' | 'memberships'> {
  const organizations: SourceOrganization[] = listOf(
    input.files.organizations,
    'The organizations file'
  ).map((record, position) => {
    const row = position + 1
    if (record === null) {
      return { row, sourceId: '', name: null, slug: null, refusal: UNREADABLE_ROW }
    }
    const sourceId = text(pick(record, 'id', 'organization_id')) ?? ''
    const name = text(pick(record, 'name'))
    const slug = slugOf(text(pick(record, 'slug')) ?? name ?? '')
    const checked = CreateOrganizationRequestSchema.safeParse({ name, slug })
    if (sourceId === '' || !checked.success) {
      return {
        row,
        sourceId,
        name: null,
        slug: null,
        refusal: {
          code: 'source.organization_invalid',
          reason: 'The organization has no id, or no name and slug the API accepts.',
        },
      }
    }
    return { row, sourceId, name: checked.data.name, slug: checked.data.slug, refusal: null }
  })
  const memberships: SourceMembership[] = listOf(
    input.files.memberships,
    'The memberships file'
  ).map((record, position) => {
    const row = position + 1
    const invalid = (organizationId: string, userId: string): SourceMembership => ({
      row,
      organizationId,
      userId,
      role: null,
      refusal: {
        code: 'source.membership_invalid',
        reason: 'The membership has no organization, no user or no role.',
      },
    })
    if (record === null) {
      return invalid('', '')
    }
    const organization = isRecord(record.organization) ? record.organization : undefined
    const data = isRecord(record.public_user_data) ? record.public_user_data : undefined
    const organizationId =
      text(pick(record, 'organization_id', 'organizationId')) ?? text(organization?.id) ?? ''
    const userId =
      text(pick(record, 'user_id', 'userId')) ?? text(data?.user_id) ?? text(data?.userId) ?? ''
    const role = roleOf(text(pick(record, 'role', 'role_name')))
    if (
      organizationId === '' ||
      userId === '' ||
      role === undefined ||
      !/^[a-z][a-z0-9_]{0,31}$/.test(role)
    ) {
      return invalid(organizationId, userId)
    }
    return { row, organizationId, userId, role, refusal: null }
  })
  if (memberships.length > 0 && organizations.length === 0) {
    notes.push(
      'A memberships file was given without an organizations file; no organization is created.'
    )
  }
  return { organizations, memberships }
}
