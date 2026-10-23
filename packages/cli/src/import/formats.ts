import type { ImportUserRow } from '@tula-tech/contract'
import { UsageError } from '../args'
import type { Refusal, SourceRow } from './types'

/** What is said when an export is not in a form this command reads. Never the content. */
const UNREADABLE = 'is not a JSON, NDJSON or CSV export this command reads'

/** A password in the import's form. */
export type ImportPassword = NonNullable<ImportUserRow['password']>

/** A record of an export, or `null` for a line that could not be read. */
export type RawRecord = Record<string, unknown>

/**
 * Whether a value is a plain object.
 *
 * @param value - Anything.
 * @returns `true` for a non-null, non-array object.
 */
export function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Split CSV text (RFC 4180: quoted fields, doubled quotes, CRLF or LF, a quoted newline) into
 * rows of fields.
 *
 * @param text - The CSV text, with or without a byte order mark.
 * @returns The rows, blank lines removed.
 * @throws UsageError when a quoted field is never closed.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let started = false
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] as string
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"' && field === '') {
      quoted = true
      started = true
    } else if (char === ',') {
      row.push(field)
      field = ''
      started = true
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') {
        index += 1
      }
      if (started || field !== '') {
        row.push(field)
        rows.push(row)
      }
      row = []
      field = ''
      started = false
    } else {
      field += char
    }
  }
  if (quoted) {
    throw new UsageError('A quoted field in the CSV file is never closed.')
  }
  if (started || field !== '') {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** Options of {@link readRecords}. */
export interface ReadOptions {
  /** Names of object keys that hold the array of records when the file is one JSON object. */
  containers: readonly string[]
  /** Whether the file may be CSV. */
  csv: boolean
  /** What the file is called in an error (`the Firebase export`). */
  label: string
}

/**
 * Read the records of an export: a JSON array, one JSON object holding an array under one of
 * `containers`, NDJSON (one object per line) or, where allowed, CSV with a header row. A line
 * of NDJSON that is not an object is a `null` record, so one bad line costs one row.
 *
 * @param text - The file's text.
 * @param options - Where the array may be, whether CSV is allowed, how to name the file.
 * @returns One entry per record, in order.
 * @throws UsageError when the file is none of the forms. The error names the form, never the content.
 */
export function readRecords(text: string, options: ReadOptions): (RawRecord | null)[] {
  const body = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trim()
  if (body === '') {
    return []
  }
  if (body.startsWith('[') || body.startsWith('{')) {
    let whole: unknown
    try {
      whole = JSON.parse(body)
    } catch {
      whole = undefined
    }
    if (Array.isArray(whole)) {
      return whole.map((entry) => (isRecord(entry) ? entry : null))
    }
    if (isRecord(whole)) {
      for (const key of options.containers) {
        const inside = whole[key]
        if (Array.isArray(inside)) {
          return inside.map((entry) => (isRecord(entry) ? entry : null))
        }
      }
      // One object of its own: a single record (or a one-line NDJSON file).
      if (!body.includes('\n')) {
        return [whole]
      }
    }
    if (body.startsWith('{')) {
      return body
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '')
        .map((line) => {
          try {
            const parsed: unknown = JSON.parse(line)
            return isRecord(parsed) ? parsed : null
          } catch {
            return null
          }
        })
    }
    throw new UsageError(`${options.label} ${UNREADABLE}.`)
  }
  if (!options.csv) {
    throw new UsageError(`${options.label} ${UNREADABLE}.`)
  }
  const [header, ...lines] = parseCsv(body)
  if (!header) {
    return []
  }
  const names = header.map((name) => name.trim())
  return lines.map((fields) => {
    const record: RawRecord = {}
    names.forEach((name, position) => {
      if (name !== '') {
        record[name] = fields[position] ?? ''
      }
    })
    return record
  })
}

/**
 * The first present value among several spellings of a key (`primary_email_address`,
 * `primaryEmailAddress`). `null`, `undefined` and the empty string are absent.
 *
 * @param record - A record of the export.
 * @param keys - The spellings, in order of preference.
 * @returns The value, or `undefined`.
 */
export function pick(record: RawRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (Object.hasOwn(record, key)) {
      const value = record[key]
      if (value !== null && value !== undefined && value !== '') {
        return value
      }
    }
  }
  return undefined
}

/**
 * A trimmed, non-empty string from a value; numbers are written out.
 *
 * @param value - Anything.
 * @returns The string, or `undefined`.
 */
export function text(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * A boolean as the exports write it: `true`, `t`, `1`, `yes` (any case).
 *
 * @param value - A boolean or its text.
 * @returns `true` only for a true value.
 */
export function truthy(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    return value === 1
  }
  return typeof value === 'string' && /^(?:true|t|1|yes|y)$/i.test(value.trim())
}

/**
 * A JSON object that a CSV cell or a JSON field holds (`raw_user_meta_data`).
 *
 * @param value - The object itself, or JSON text of one.
 * @returns The object, or `undefined` for anything else.
 */
export function objectOf(value: unknown): RawRecord | undefined {
  if (isRecord(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(value)
      return isRecord(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Hide most of an address so that a report can name a row without exposing a person:
 * the first character, then `***`, and only the last label of the domain
 * (`maya@northline.app` becomes `m***@***.app`).
 *
 * @param email - An address, or `null`.
 * @returns The masked form, or `(no address)`.
 *
 * @example
 * ```ts
 * maskEmail('maya@northline.app') // 'm***@***.app'
 * ```
 */
export function maskEmail(email: string | null): string {
  if (email === null || email.trim() === '') {
    return '(no address)'
  }
  const trimmed = email.trim()
  const at = trimmed.lastIndexOf('@')
  if (at < 1) {
    return '***'
  }
  const first = Array.from(trimmed)[0] ?? ''
  const domain = trimmed.slice(at + 1)
  const dot = domain.lastIndexOf('.')
  const label = dot === -1 ? '' : domain.slice(dot).replace(/[^\w.-]/g, '')
  return `${first}***@***${label}`
}

/**
 * The form an address is compared in to find a repeat inside one file. The server decides
 * what is a duplicate for real; this only counts the obvious ones for the report.
 *
 * @param email - An address.
 * @returns The trimmed, lower-cased address.
 */
export function comparable(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * Whether an address is plausible enough to send. The server validates it properly; this only
 * keeps a row with no usable address (a phone-only or anonymous user) out of a batch.
 *
 * @param email - Anything.
 * @returns The trimmed address when it has one `@` with text on both sides and no space.
 */
export function usableEmail(email: unknown): string | undefined {
  const value = text(email)
  if (value === undefined || value.length > 320 || /\s/.test(value)) {
    return undefined
  }
  const at = value.indexOf('@')
  return at > 0 && at === value.lastIndexOf('@') && at < value.length - 1 ? value : undefined
}

/** The refusal of a row with no usable address. */
export const NO_EMAIL: Refusal = {
  code: 'email.invalid',
  reason: 'The row has no usable email address.',
}

/** The refusal of a row whose line or record could not be read. */
export const UNREADABLE_ROW: Refusal = {
  code: 'source.row_unreadable',
  reason: 'The record is not a JSON object, so nothing could be read from it.',
}

/** The refusal of a user the provider had disabled, blocked or banned. */
export const DISABLED_USER: Refusal = {
  code: 'source.user_disabled',
  reason:
    'The user is disabled, blocked or banned at the provider, and importing would make the account usable again.',
}

/** Bytes the compact JSON of a value takes as the server counts them: about 1 more per `:` and `,`. */
function storedSize(value: unknown): number {
  const json = JSON.stringify(value)
  let extra = 0
  for (const char of json) {
    if (char === ':' || char === ',') {
      extra += 1
    }
  }
  return Buffer.byteLength(json) + extra
}

/** Largest metadata this command sends: the contract's 4 KiB less a margin for the estimate. */
const METADATA_LIMIT = 4000

/**
 * Metadata for a row, or nothing when it would not fit. Whatever the provider keeps beside a
 * user is kept with them up to the server's limit; beyond it the whole object is dropped (the
 * server would refuse the row, and a user without their metadata is better than no user) and the
 * caller counts it in a note.
 *
 * @param value - The object to keep.
 * @returns The object, `undefined` when it is empty, or `'too_large'`.
 */
export function fitMetadata(value: RawRecord): RawRecord | undefined | 'too_large' {
  const kept = Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null)
  )
  if (Object.keys(kept).length === 0) {
    return undefined
  }
  return storedSize(kept) > METADATA_LIMIT ? 'too_large' : kept
}

/**
 * Convert URL-safe base64 (`-` and `_`, as Firebase's export writes it) to the standard
 * alphabet the server reads. Standard input is unchanged.
 *
 * @param value - Base64 in either alphabet.
 * @returns The same bytes in the standard alphabet.
 */
export function standardBase64(value: string): string {
  return value.trim().replaceAll('-', '+').replaceAll('_', '/')
}

/** What a hash prefix says about an algorithm the server reads. */
export type HashReading =
  | { kind: 'password'; password: ImportPassword }
  | { kind: 'unsupported'; refusal: Refusal }

/**
 * Tell which algorithm a stored hash is from its own text, for the exports that do not say
 * (Supabase, better-auth). bcrypt, argon2id/argon2i and PBKDF2-SHA256 are carried; scrypt and
 * everything else are refused with a reason. The parameters are judged by the server.
 *
 * @param hash - A stored password hash.
 * @returns The password in the import's form, or why it cannot be carried.
 */
export function readHash(hash: string): HashReading {
  const value = hash.trim()
  if (/^\$2[aby]\$/.test(value)) {
    return { kind: 'password', password: { algorithm: 'bcrypt', hash: value } }
  }
  if (value.startsWith('$argon2id$')) {
    return { kind: 'password', password: { algorithm: 'argon2id', hash: value } }
  }
  if (value.startsWith('$argon2i$')) {
    return { kind: 'password', password: { algorithm: 'argon2i', hash: value } }
  }
  if (value.startsWith('pbkdf2_sha256$') || value.startsWith('$pbkdf2-sha256$')) {
    return { kind: 'password', password: { algorithm: 'pbkdf2_sha256', hash: value } }
  }
  if (/^[0-9a-f]{16,64}:[0-9a-f]{64,256}$/i.test(value) || value.startsWith('$scrypt$')) {
    return {
      kind: 'unsupported',
      refusal: {
        code: 'import.unsupported_algorithm',
        reason:
          'The password is hashed with scrypt, which the server does not read yet (only bcrypt, argon2, PBKDF2-SHA256 and Firebase scrypt).',
      },
    }
  }
  return {
    kind: 'unsupported',
    refusal: {
      code: 'import.unsupported_algorithm',
      reason:
        'The password hash is in a format the server does not read (it reads bcrypt, argon2id, argon2i, PBKDF2-SHA256 and Firebase scrypt).',
    },
  }
}

/**
 * Build a refused row.
 *
 * @param row - The row number.
 * @param email - The address as the export has it, or `null`.
 * @param refusal - Why it is refused.
 * @param sourceId - The user's id at the provider.
 * @returns The refused row.
 */
export function refused(
  row: number,
  email: string | null,
  refusal: Refusal,
  sourceId?: string
): SourceRow {
  return { row, sourceId, email, user: null, refusal }
}

/**
 * Build an accepted row.
 *
 * @param row - The row number.
 * @param email - The address, as sent.
 * @param user - The row to send.
 * @param sourceId - The user's id at the provider.
 * @returns The row.
 */
export function accepted(
  row: number,
  email: string,
  user: ImportUserRow,
  sourceId?: string
): SourceRow {
  return { row, sourceId, email, user, refusal: null }
}

/**
 * Notes about what the whole export did not carry over, from counters.
 *
 * @param notes - Where to add them.
 * @param counts - The counters.
 */
export function addCountNotes(
  notes: string[],
  counts: {
    droppedMetadata?: number
    passwordless?: number
    unreadable?: number
  }
): void {
  if (counts.droppedMetadata) {
    notes.push(
      `${counts.droppedMetadata} user(s) had metadata over the 4 KiB limit; it was left out and the users are imported without it.`
    )
  }
  if (counts.passwordless) {
    notes.push(
      `${counts.passwordless} user(s) are imported without a password because their hash cannot be carried over (--allow-passwordless).`
    )
  }
}
