import type { FirebaseScryptParams, ImportUserRow } from '@tula-tech/contract'
import { UsageError } from '../args'
import {
  accepted,
  addCountNotes,
  DISABLED_USER,
  fitMetadata,
  NO_EMAIL,
  objectOf,
  pick,
  readRecords,
  refused,
  standardBase64,
  text,
  truthy,
  UNREADABLE_ROW,
  usableEmail,
} from './formats'
import type { ParsedExport, ParseInput, Refusal, SourceRow } from './types'

/**
 * Read Firebase's hash parameters from the text of a file: JSON
 * (`{ "base64_signer_key": …, "base64_salt_separator": …, "rounds": 8, "mem_cost": 14 }`, or
 * the same keys in camelCase) or the console's `hash_config { … }` block (`key: value` lines).
 * Nothing read is ever put in an error.
 *
 * @param source - The file's text.
 * @returns The four values, the numbers possibly absent.
 * @throws UsageError when the file holds no signer key.
 */
export function parseHashConfig(source: string): {
  signerKey: string
  saltSeparator: string
  rounds?: number
  memCost?: number
} {
  const values = new Map<string, string>()
  const trimmed = source.trim()
  const json = trimmed.startsWith('{') ? objectOf(trimmed) : undefined
  if (json !== undefined) {
    for (const [key, value] of Object.entries(json)) {
      if (typeof value === 'string' || typeof value === 'number') {
        values.set(key.replace(/[_-]/g, '').toLowerCase(), String(value))
      }
    }
  } else {
    for (const match of trimmed.matchAll(/([A-Za-z_][\w-]*)\s*[:=]\s*"?([^\s",}]+)"?/g)) {
      values.set((match[1] as string).replace(/[_-]/g, '').toLowerCase(), match[2] as string)
    }
  }
  const signerKey = values.get('base64signerkey') ?? values.get('signerkey')
  if (signerKey === undefined || signerKey === '') {
    throw new UsageError(
      'The Firebase hash config file has no base64_signer_key. It is the file or console text with base64_signer_key, base64_salt_separator, rounds and mem_cost.'
    )
  }
  const number = (name: string): number | undefined => {
    const value = values.get(name)
    return value === undefined || !/^\d{1,3}$/.test(value) ? undefined : Number(value)
  }
  return {
    signerKey: standardBase64(signerKey),
    saltSeparator: standardBase64(
      values.get('base64saltseparator') ?? values.get('saltseparator') ?? ''
    ),
    rounds: number('rounds'),
    memCost: number('memcost'),
  }
}

const NO_SALT: Refusal = {
  code: 'import.hash_malformed',
  reason: 'The user has a passwordHash but no salt, so the hash cannot be checked later.',
}

const NO_CONFIG: Refusal = {
  code: 'import.hash_malformed',
  reason:
    'The user has a password hash and no Firebase hash parameters were given (--firebase-hash-config).',
}

/**
 * Read `firebase auth:export users.json --format=JSON` (`{ "users": [ … ] }`; a bare array or
 * NDJSON are read too). A user with `passwordHash` and `salt` is carried as `firebase_scrypt`
 * with the project's parameters, sent once per call in `firebaseScrypt`; Firebase writes both
 * in URL-safe base64, which is converted to the alphabet the server reads. A disabled user is
 * refused. A user with no email (phone or anonymous) is refused.
 *
 * @param input - The export's text and, in `firebase`, the project's hash parameters.
 * @returns The users and notes.
 * @throws UsageError when users have a password hash and no parameters were given (unless
 *   `--allow-passwordless`).
 */
export function parseFirebase(input: ParseInput): ParsedExport {
  const notes: string[] = []
  const counts = { droppedMetadata: 0, passwordless: 0 }
  const records = readRecords(input.text, {
    containers: ['users'],
    csv: false,
    label: 'The Firebase export',
  })
  const needsConfig = records.filter(
    (record) => record !== null && text(record.passwordHash) !== undefined
  )
  if (needsConfig.length > 0 && input.firebase === undefined && !input.allowPasswordless) {
    throw new UsageError(
      `${needsConfig.length} user(s) of the export have a password hash, and Firebase's hash parameters are needed to carry them: pass --firebase-hash-config <file> (Authentication, Users, the menu, Password hash parameters), or --allow-passwordless to import them without a password.`
    )
  }
  const rows: SourceRow[] = records.map((record, position) => {
    const row = position + 1
    if (record === null) {
      return refused(row, null, UNREADABLE_ROW)
    }
    const sourceId = text(pick(record, 'localId', 'uid'))
    const email = usableEmail(record.email)
    if (email === undefined) {
      return refused(row, null, NO_EMAIL, sourceId)
    }
    if (truthy(record.disabled)) {
      return refused(row, email, DISABLED_USER, sourceId)
    }
    const user: ImportUserRow = { email, emailVerified: truthy(record.emailVerified) }
    const name = text(record.displayName)
    if (name !== undefined) {
      user.name = name
    }
    if (sourceId !== undefined) {
      user.externalId = sourceId
    }
    const meta = fitMetadata({ customAttributes: objectOf(record.customAttributes) })
    if (meta === 'too_large') {
      counts.droppedMetadata += 1
    } else if (meta !== undefined) {
      user.metadata = { firebase: meta }
    }
    const hash = text(record.passwordHash)
    if (hash !== undefined) {
      const salt = text(record.salt)
      const missing = input.firebase === undefined ? NO_CONFIG : salt === undefined ? NO_SALT : null
      if (missing === null && salt !== undefined) {
        user.password = {
          algorithm: 'firebase_scrypt',
          hash: standardBase64(hash),
          params: { salt: standardBase64(salt) },
        }
      } else if (input.allowPasswordless) {
        counts.passwordless += 1
      } else {
        return refused(row, email, missing ?? NO_SALT, sourceId)
      }
    }
    return accepted(row, email, user, sourceId)
  })
  addCountNotes(notes, counts)
  const usesScrypt = rows.some((entry) => entry.user?.password?.algorithm === 'firebase_scrypt')
  const firebaseScrypt: FirebaseScryptParams | undefined =
    usesScrypt && input.firebase !== undefined ? input.firebase : undefined
  return { rows, firebaseScrypt, organizations: [], memberships: [], notes }
}
