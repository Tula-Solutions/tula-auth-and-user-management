import type { ImportUserRow } from '@tula-tech/contract'
import {
  accepted,
  addCountNotes,
  DISABLED_USER,
  fitMetadata,
  NO_EMAIL,
  pick,
  readHash,
  readRecords,
  refused,
  text,
  truthy,
  UNREADABLE_ROW,
  usableEmail,
} from './formats'
import type { ParsedExport, ParseInput, SourceRow } from './types'

/**
 * Read better-auth's `user` table, with its `account` table from `--accounts`, each exported as
 * JSON or CSV (camelCase or snake_case columns). The credential account
 * (`providerId` = `credential`) holds the password in `password`. better-auth's default hash is
 * scrypt (`salt:key`, hex), which this server does not read: those users are refused with that
 * reason, or imported without a password with `--allow-passwordless`. A better-auth app that
 * configured bcrypt or argon2 hashing is carried. Without an accounts file no password is
 * carried and the report says so.
 *
 * @param input - The user table's text and the account table's.
 * @returns The users and notes.
 */
export function parseBetterAuth(input: ParseInput): ParsedExport {
  const notes: string[] = []
  const counts = { droppedMetadata: 0, passwordless: 0 }
  const accounts = input.files.accounts
  const passwords = new Map<string, string>()
  if (accounts !== undefined) {
    for (const record of readRecords(accounts, {
      containers: ['account', 'accounts', 'data'],
      csv: true,
      label: 'The accounts file',
    })) {
      const provider = record === null ? undefined : text(pick(record, 'providerId', 'provider_id'))
      const owner = record === null ? undefined : text(pick(record, 'userId', 'user_id'))
      const hash = record === null ? undefined : text(record.password)
      if (provider === 'credential' && owner !== undefined && hash !== undefined) {
        passwords.set(owner, hash)
      }
    }
  } else {
    notes.push(
      'No --accounts file was given, so no password is carried over: every user is imported without one and signs in another way or resets it.'
    )
  }
  const records = readRecords(input.text, {
    containers: ['user', 'users', 'data'],
    csv: true,
    label: 'The better-auth user file',
  })
  const rows: SourceRow[] = records.map((record, position) => {
    const row = position + 1
    if (record === null) {
      return refused(row, null, UNREADABLE_ROW)
    }
    const sourceId = text(pick(record, 'id'))
    const email = usableEmail(record.email)
    if (email === undefined) {
      return refused(row, null, NO_EMAIL, sourceId)
    }
    if (truthy(record.banned)) {
      return refused(row, email, DISABLED_USER, sourceId)
    }
    const user: ImportUserRow = {
      email,
      emailVerified: truthy(pick(record, 'emailVerified', 'email_verified')),
    }
    const name = text(record.name)
    if (name !== undefined) {
      user.name = name
    }
    if (sourceId !== undefined) {
      user.externalId = sourceId
    }
    const meta = fitMetadata({
      username: text(record.username),
      role: text(record.role),
    })
    if (meta === 'too_large') {
      counts.droppedMetadata += 1
    } else if (meta !== undefined) {
      user.metadata = { betterAuth: meta }
    }
    const hash = sourceId === undefined ? undefined : passwords.get(sourceId)
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
