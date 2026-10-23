import { type AdminClient, isTulaAdminError, type TulaAdminError } from '@tula-tech/admin'
import { type ImportUserRow, MAX_IMPORT_ROWS } from '@tula-tech/contract'
import { UsageError } from '../args'
import type { Host } from '../host'
import type { Output } from '../output'
import { comparable } from './formats'
import { type Progress, serializeProgress } from './progress'
import type { ParsedExport, SourceRow } from './types'

/**
 * The most bytes of request body one batch holds. The server's cap is 4 MiB
 * (`MAX_IMPORT_BODY_BYTES`); the margin keeps a batch clear of it whatever the framing adds.
 */
export const BATCH_BYTE_LIMIT = 4_000_000

/** How many times one call is tried before the run stops and keeps its progress. */
const MAX_ATTEMPTS = 6

/** Waiting before a retry of a failed call that said nothing about when: this, times the attempt. */
const BACKOFF_MS = 2000

/**
 * What a run needs. Everything outside the process is passed in so that a test supplies it.
 *
 * @example
 * ```ts
 * const context: RunContext = { admin, host, output, progressPath, batchSize: 500, maxWaitMs: 120_000 }
 * ```
 */
export interface RunContext {
  /** The admin client. */
  admin: AdminClient
  /** Writes the progress file, and waits. */
  host: Pick<Host, 'writeSecretFile' | 'sleep'>
  /** Where messages go: all of them to standard error. */
  output: Output
  /** Where the progress file is. */
  progressPath: string
  /** Rows per batch, at most 500. */
  batchSize: number
  /** The longest a `Retry-After` is waited, in milliseconds. */
  maxWaitMs: number
}

function say(context: RunContext, text: string): void {
  context.output.error(text)
}

/** Whether an admin error is the rate limit. */
function isRateLimited(error: TulaAdminError): boolean {
  return error.status === 429 || error.code === 'rate_limited'
}

/** Whether a call that failed may be tried again as it is: no answer at all, or a 5xx. */
function isTransient(error: TulaAdminError): boolean {
  return error.status === 0 || error.status >= 500
}

/**
 * Run one admin call, waiting out the rate limit.
 *
 * A `429` is waited for as long as `Retry-After` says, up to `maxWaitMs`, and tried again; so
 * is a call that got no answer or a `5xx` (after a pause that grows), because every call here is
 * safe to repeat: users are matched by address, organizations by slug, members by user. After
 * six attempts the error is thrown and the run keeps what it has.
 *
 * @param context - The run.
 * @param what - A fixed word for what is being done, for the waiting message.
 * @param call - The call.
 * @returns What the call returned.
 * @throws TulaAdminError when the error is not one to wait for, or the attempts are used up.
 */
export async function withRetry<T>(
  context: RunContext,
  what: string,
  call: () => Promise<T>
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call()
    } catch (error) {
      if (!isTulaAdminError(error) || attempt >= MAX_ATTEMPTS) {
        throw error
      }
      let wait: number
      if (isRateLimited(error)) {
        wait = Math.min(error.retryAfterMs ?? BACKOFF_MS * attempt, context.maxWaitMs)
        say(
          context,
          `The rate limit was reached; waiting ${Math.ceil(wait / 1000)}s before ${what}.`
        )
      } else if (isTransient(error)) {
        wait = BACKOFF_MS * attempt
        say(
          context,
          `The server did not answer (${error.status === 0 ? 'no response' : `HTTP ${error.status}`}); trying ${what} again in ${Math.ceil(wait / 1000)}s.`
        )
      } else {
        throw error
      }
      await context.host.sleep(Math.max(0, wait))
    }
  }
}

/** Write the progress file. A failure to write stops the run: continuing would lose the place. */
async function save(context: RunContext, progress: Progress): Promise<void> {
  await context.host.writeSecretFile(context.progressPath, serializeProgress(progress))
}

/** Set a key of a record the progress file reads back, without touching the prototype. */
function setOwn(record: Record<string, string>, key: string, value: string): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

/** A code from an error, safe to keep in a file: the dotted lower-case form or `unknown`. */
function codeOf(error: TulaAdminError): string {
  return /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/.test(error.code) && error.code.length <= 80
    ? error.code
    : 'unknown'
}

/**
 * The next batch: the importable rows after the last one sent, as many as `batchSize` and the
 * byte limit allow.
 *
 * @param rows - Every row of the export.
 * @param after - The number of the last row already sent.
 * @param batchSize - Rows per batch.
 * @param extraBytes - Bytes a batch carries beside its rows (the Firebase parameters).
 * @returns The rows of the batch, empty when none are left.
 */
export function nextBatch(
  rows: readonly SourceRow[],
  after: number,
  batchSize: number,
  extraBytes: number
): SourceRow[] {
  const batch: SourceRow[] = []
  let bytes = extraBytes + 32
  for (const entry of rows) {
    if (entry.row <= after || entry.user === null) {
      continue
    }
    const size = Buffer.byteLength(JSON.stringify(entry.user)) + 1
    if (batch.length > 0 && (batch.length >= batchSize || bytes + size > BATCH_BYTE_LIMIT)) {
      break
    }
    batch.push(entry)
    bytes += size
  }
  return batch
}

/** The rows that will be sent, counted. */
export function importable(parsed: ParsedExport): number {
  return parsed.rows.filter((entry) => entry.user !== null).length
}

/**
 * Send the users, batch by batch, saving the progress file after every answer.
 *
 * A batch that had to be sent again reports the users its first attempt made as duplicates; a
 * duplicate that carries the row's own external id is counted as created then, and never
 * otherwise (a user who was there before stays skipped).
 *
 * @param context - The run.
 * @param parsed - The parsed export.
 * @param progress - The progress so far; changed in place.
 * @throws TulaAdminError when a call fails for good. The progress file then holds every batch answered.
 */
export async function importUsers(
  context: RunContext,
  parsed: ParsedExport,
  progress: Progress
): Promise<void> {
  const total = importable(parsed)
  const batchSize = Math.min(context.batchSize, MAX_IMPORT_ROWS)
  const firebaseBytes = parsed.firebaseScrypt
    ? Buffer.byteLength(JSON.stringify(parsed.firebaseScrypt))
    : 0
  const keepIds = parsed.memberships.length > 0
  for (;;) {
    const batch = nextBatch(parsed.rows, progress.doneThrough, batchSize, firebaseBytes)
    if (batch.length === 0) {
      return
    }
    const users = batch.map((entry) => entry.user as ImportUserRow)
    const needsFirebase =
      parsed.firebaseScrypt !== undefined &&
      users.some((user) => user.password?.algorithm === 'firebase_scrypt')
    let sends = 0
    const { data } = await withRetry(context, 'importing', () => {
      sends += 1
      return context.admin.call('importUsers', {
        body: needsFirebase ? { users, firebaseScrypt: parsed.firebaseScrypt } : { users },
      })
    })
    // A batch sent again got no answer the first time, and the server may have made its users
    // before the answer was lost. Its duplicates that carry this row's own external id are then
    // the first attempt's work (ADR 0066, "A retried batch").
    const retried = sends > 1
    if (data.results.length !== batch.length) {
      throw new UsageError(
        'The server answered a batch with a different number of results than rows sent. Nothing more was sent; the progress file is unchanged.'
      )
    }
    for (const result of data.results) {
      const entry = batch[result.index]
      if (entry === undefined) {
        continue
      }
      if (result.status === 'created') {
        progress.counts.created += 1
        if (keepIds && entry.sourceId !== undefined) {
          setOwn(progress.userIds, entry.sourceId, result.id)
        }
      } else if (result.status === 'skipped') {
        // The existing user's id pairs a provider id with a Tula id without a lookup by
        // address, whoever made the user. Rows repeated inside the batch carry none.
        if (keepIds && entry.sourceId !== undefined && result.id !== undefined) {
          setOwn(progress.userIds, entry.sourceId, result.id)
        }
        if (retried && result.sameExternalId === true) {
          progress.counts.created += 1
        } else {
          progress.counts.skipped += 1
        }
      } else {
        progress.counts.refused += 1
        progress.refused.push({
          row: entry.row,
          code: /^[a-z][a-z0-9_.]{0,79}$/.test(result.code) ? result.code : 'unknown',
        })
      }
    }
    progress.doneThrough = (batch[batch.length - 1] as SourceRow).row
    progress.batches += 1
    await save(context, progress)
    const done = progress.counts.created + progress.counts.skipped + progress.counts.refused
    say(context, `Imported ${done} of ${total} users (batch ${progress.batches}).`)
  }
}

/** A lookup of a Tula user by address, memoized for the run. */
async function findUser(
  context: RunContext,
  cache: Map<string, string | null>,
  email: string
): Promise<string | null> {
  const key = comparable(email)
  const cached = cache.get(key)
  if (cached !== undefined) {
    return cached
  }
  const { data } = await withRetry(context, 'looking a user up', () =>
    context.admin.call('listUsers', { query: { q: email, size: 20 } })
  )
  const match = data.data.find((user) => user.email !== null && comparable(user.email) === key)
  cache.set(key, match?.id ?? null)
  return match?.id ?? null
}

/** The id of the organization with this slug, by listing them. */
async function findOrganization(context: RunContext, slug: string): Promise<string | null> {
  for (let page = 1; ; page += 1) {
    const { data } = await withRetry(context, 'looking an organization up', () =>
      context.admin.call('listOrganizations', { query: { page, size: 100 } })
    )
    const match = data.data.find((organization) => organization.slug === slug)
    if (match) {
      return match.id
    }
    if (page >= data.meta.totalPages) {
      return null
    }
  }
}

const DISABLED =
  'Organizations are switched off in this environment (organizations.enabled). Switch them on and run the same command again: it continues from the progress file.'

/**
 * Create the organizations of a Clerk export, then add the members, saving after each.
 *
 * An organization is its slug: one that exists already is used as it is and counted as
 * existing, so a second run changes nothing. A member is found by the address of the user in the
 * users file when they were not created in this run.
 *
 * @param context - The run.
 * @param parsed - The parsed export.
 * @param progress - The progress so far; changed in place.
 * @throws UsageError when organizations are switched off in the environment.
 * @throws TulaAdminError when a call fails for good.
 */
export async function importOrganizations(
  context: RunContext,
  parsed: ParsedExport,
  progress: Progress
): Promise<void> {
  const organizations = progress.organizations
  while (organizations.cursor < parsed.organizations.length) {
    const entry = parsed.organizations[
      organizations.cursor
    ] as ParsedExport['organizations'][number]
    if (entry.refusal === null && entry.name !== null && entry.slug !== null) {
      try {
        const { data } = await withRetry(context, 'creating an organization', () =>
          context.admin.call('createOrganization', {
            body: { name: entry.name as string, slug: entry.slug as string },
          })
        )
        setOwn(organizations.ids, entry.sourceId, data.id)
        organizations.created += 1
      } catch (error) {
        if (!isTulaAdminError(error)) {
          throw error
        }
        if (error.code === 'organization.disabled') {
          throw new UsageError(DISABLED)
        }
        if (error.code === 'organization.slug_taken') {
          const id = await findOrganization(context, entry.slug)
          if (id === null) {
            organizations.failed.push({ row: entry.row, code: 'organization.slug_taken' })
          } else {
            setOwn(organizations.ids, entry.sourceId, id)
            organizations.existing += 1
          }
        } else if (isRateLimited(error) || isTransient(error)) {
          throw error
        } else {
          organizations.failed.push({ row: entry.row, code: codeOf(error) })
        }
      }
    }
    organizations.cursor += 1
    await save(context, progress)
  }
  const emails = new Map<string, string>()
  for (const entry of parsed.rows) {
    if (entry.sourceId !== undefined && entry.email !== null) {
      emails.set(entry.sourceId, entry.email)
    }
  }
  const cache = new Map<string, string | null>()
  const members = progress.memberships
  while (members.cursor < parsed.memberships.length) {
    const entry = parsed.memberships[members.cursor] as ParsedExport['memberships'][number]
    if (entry.refusal === null && entry.role !== null) {
      const organizationId = Object.hasOwn(organizations.ids, entry.organizationId)
        ? organizations.ids[entry.organizationId]
        : undefined
      const email = emails.get(entry.userId)
      const userId = Object.hasOwn(progress.userIds, entry.userId)
        ? progress.userIds[entry.userId]
        : email === undefined
          ? null
          : await findUser(context, cache, email)
      if (organizationId === undefined) {
        members.failed.push({ row: entry.row, code: 'source.organization_missing' })
      } else if (userId === null || userId === undefined) {
        members.failed.push({ row: entry.row, code: 'source.member_user_missing' })
      } else {
        try {
          await withRetry(context, 'adding a member', () =>
            context.admin.call('addOrganizationMember', {
              params: { id: organizationId },
              body: { userId, role: entry.role as string },
            })
          )
          members.added += 1
        } catch (error) {
          if (!isTulaAdminError(error)) {
            throw error
          }
          if (error.code === 'organization.disabled') {
            throw new UsageError(DISABLED)
          }
          if (error.code === 'organization.member_exists') {
            members.existing += 1
          } else if (isRateLimited(error) || isTransient(error)) {
            throw error
          } else {
            members.failed.push({ row: entry.row, code: codeOf(error) })
          }
        }
      }
    }
    members.cursor += 1
    await save(context, progress)
  }
}
