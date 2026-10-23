import { createHash } from 'node:crypto'
import { UsageError } from '../args'
import { IMPORT_PROVIDERS, type ImportProvider } from './types'

/** A row or item the server or this command refused, by its number and code. Nothing else. */
export interface RefusedItem {
  /** The row's number in its file. */
  row: number
  /** The code. */
  code: string
}

/**
 * The progress file of `tula import`: where a run stopped, so that the next one starts there.
 *
 * It holds **row numbers, offsets, counts, codes and ids, and nothing else**: no email address,
 * no name, no password hash, no signer key, no metadata. The ids are the provider's ids of users
 * and organizations and Tula's ids for them (the memberships of a Clerk import need the pairing).
 * `fingerprint` is a SHA-256 of the export files, `target` a truncated SHA-256 of the API and
 * the key, so that a progress file is never resumed against another export or environment.
 *
 * @example
 * ```ts
 * const progress = newProgress('clerk', fingerprint, target)
 * ```
 */
export interface Progress {
  /** The file's format. */
  version: 1
  /** The provider the export came from. */
  provider: ImportProvider
  /** SHA-256 (hex) of the export files. */
  fingerprint: string
  /** The first 16 hex characters of a SHA-256 of the API's address and the key. */
  target: string
  /** The number of the last user row of a batch that was sent and answered. */
  doneThrough: number
  /** Batches answered. */
  batches: number
  /** What the server did with the rows sent. */
  counts: { created: number; skipped: number; refused: number }
  /** The rows the server refused. */
  refused: RefusedItem[]
  /** Clerk only: the provider's user id to Tula's, for the memberships. */
  userIds: Record<string, string>
  /** Organizations (Clerk only). */
  organizations: {
    /** How many of the file's organizations are done. */
    cursor: number
    created: number
    /** Already there under the same slug. */
    existing: number
    failed: RefusedItem[]
    /** The provider's organization id to Tula's. */
    ids: Record<string, string>
  }
  /** Memberships (Clerk only). */
  memberships: {
    /** How many of the file's memberships are done. */
    cursor: number
    added: number
    /** Already members. */
    existing: number
    failed: RefusedItem[]
  }
}

/**
 * A fresh progress file.
 *
 * @param provider - The provider.
 * @param fingerprint - {@link fingerprintOf} the export files.
 * @param target - {@link targetOf} the API and key.
 * @returns Progress with nothing done.
 */
export function newProgress(
  provider: ImportProvider,
  fingerprint: string,
  target: string
): Progress {
  return {
    version: 1,
    provider,
    fingerprint,
    target,
    doneThrough: 0,
    batches: 0,
    counts: { created: 0, skipped: 0, refused: 0 },
    refused: [],
    userIds: {},
    organizations: { cursor: 0, created: 0, existing: 0, failed: [], ids: {} },
    memberships: { cursor: 0, added: 0, existing: 0, failed: [] },
  }
}

/**
 * A fingerprint of the export files: a SHA-256 of each file's name and bytes, in order. It
 * identifies the export without holding any of it.
 *
 * @param files - The files' texts, in a fixed order, with the option each came from.
 * @returns Hex.
 */
export function fingerprintOf(files: readonly [name: string, text: string][]): string {
  const hash = createHash('sha256')
  for (const [name, text] of files) {
    hash.update(`${name}\n${Buffer.byteLength(text)}\n`)
    hash.update(text)
  }
  return hash.digest('hex')
}

/**
 * A fingerprint of where the import goes: the API's address and the secret key, cut to 16 hex
 * characters. A key has far more entropy than that, so the value reveals nothing of it; it only
 * tells two runs against different environments apart.
 *
 * @param apiUrl - The API's address.
 * @param secretKey - The secret key.
 * @returns 16 hex characters.
 */
export function targetOf(apiUrl: string, secretKey: string): string {
  return createHash('sha256')
    .update(`tula-import-target\n${new URL(apiUrl).origin}\n${secretKey}`)
    .digest('hex')
    .slice(0, 16)
}

const CORRUPT =
  'The progress file is not one this version of `tula import` wrote. Nothing was changed: move it away, or pass --fresh to start over.'

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function items(value: unknown): value is RefusedItem[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        count((entry as RefusedItem).row) &&
        typeof (entry as RefusedItem).code === 'string' &&
        (entry as RefusedItem).code.length <= 80
    )
  )
}

function pairs(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  )
}

/**
 * Read a progress file, strictly: any other shape is refused rather than guessed at.
 *
 * @param source - The file's text.
 * @returns The progress.
 * @throws UsageError when the text is not a progress file of this version. The text is never repeated.
 */
export function readProgress(source: string): Progress {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new UsageError(CORRUPT)
  }
  if (typeof value !== 'object' || value === null) {
    throw new UsageError(CORRUPT)
  }
  const found = value as Record<string, unknown>
  const counts = found.counts as Record<string, unknown> | undefined
  const orgs = found.organizations as Record<string, unknown> | undefined
  const members = found.memberships as Record<string, unknown> | undefined
  if (
    found.version !== 1 ||
    !IMPORT_PROVIDERS.includes(found.provider as ImportProvider) ||
    typeof found.fingerprint !== 'string' ||
    typeof found.target !== 'string' ||
    !count(found.doneThrough) ||
    !count(found.batches) ||
    !counts ||
    !count(counts.created) ||
    !count(counts.skipped) ||
    !count(counts.refused) ||
    !items(found.refused) ||
    !pairs(found.userIds) ||
    !orgs ||
    !count(orgs.cursor) ||
    !count(orgs.created) ||
    !count(orgs.existing) ||
    !items(orgs.failed) ||
    !pairs(orgs.ids) ||
    !members ||
    !count(members.cursor) ||
    !count(members.added) ||
    !count(members.existing) ||
    !items(members.failed)
  ) {
    throw new UsageError(CORRUPT)
  }
  return found as unknown as Progress
}

/**
 * The progress file's text.
 *
 * @param progress - The progress.
 * @returns JSON, one trailing newline.
 */
export function serializeProgress(progress: Progress): string {
  return `${JSON.stringify(progress, null, 2)}\n`
}
