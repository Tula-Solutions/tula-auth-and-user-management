import { isTulaAdminError } from '@tula-tech/admin'
import {
  type ActivityType,
  AUDIT_EXPORT_FORMATS,
  type AuditExportFormat,
  auditExportCursor,
} from '@tula-tech/contract'
import { UsageError } from '../args'
import { printable } from '../doctor'
import { type Command, type CommandContext, EXIT } from '../framework'
import { resolveTarget } from '../target'

/** A time flag as the API takes it: any instant `Date` reads, written as ISO 8601 with a zone. */
function instant(flag: string, value: unknown): string | undefined {
  if (value === undefined) {
    return undefined
  }
  const ms = Date.parse(String(value))
  if (!Number.isFinite(ms)) {
    throw new UsageError(`--${flag} is not a time. Use ISO 8601, e.g. 2026-01-31T00:00:00Z.`)
  }
  return new Date(ms).toISOString()
}

/**
 * Split streamed text into whole records. A record ends at a line break outside a CSV quote;
 * NDJSON has no raw line break inside a record, so the same rule serves both.
 */
function takeRecords(buffer: string): { records: string[]; rest: string } {
  const records: string[] = []
  let start = 0
  let quotes = 0
  for (let i = 0; i < buffer.length; i += 1) {
    const char = buffer[i]
    if (char === '"') {
      quotes += 1
    } else if (char === '\n' && quotes % 2 === 0) {
      records.push(buffer.slice(start, i).replace(/\r$/, ''))
      start = i + 1
    }
  }
  return { records, rest: buffer.slice(start) }
}

/**
 * The resume cursor of one record: its `occurredAt` and `id`, the same two fields in both formats.
 * A CSV row is read by position: the first two columns must stay `id` and `occurredAt`
 * (`EXPORT_CSV_COLUMNS` in the API; `audit.test.ts` holds the two together).
 *
 * @param record - One whole record, without its line break.
 * @param format - The export's format.
 * @returns The cursor, or `null` for the CSV header or a record that cannot be read.
 */
export function cursorOf(record: string, format: AuditExportFormat): string | null {
  try {
    if (format === 'ndjson') {
      const row = JSON.parse(record) as { id: string; occurredAt: string }
      return auditExportCursor(row)
    }
    const [id, occurredAt] = record.split(',')
    // The header row names the columns; a data row's first cell is a uuid.
    return id && occurredAt && id !== 'id' ? auditExportCursor({ id, occurredAt }) : null
  } catch {
    return null
  }
}

/** The request body from the flags; a bad format or time is a usage error. */
function requestOf(flags: CommandContext['flags']) {
  const format = typeof flags.format === 'string' ? flags.format : 'ndjson'
  if (!(AUDIT_EXPORT_FORMATS as readonly string[]).includes(format)) {
    throw new UsageError(`--format is one of ${AUDIT_EXPORT_FORMATS.join(', ')}.`)
  }
  return {
    format: format as AuditExportFormat,
    from: instant('from', flags.from),
    to: instant('to', flags.to),
    after: typeof flags.resume === 'string' ? flags.resume : undefined,
    // The server validates the type and answers 422 for one it does not know.
    action: typeof flags.action === 'string' ? (flags.action as ActivityType) : undefined,
    organizationId: typeof flags.organization === 'string' ? flags.organization : undefined,
  }
}

/** Write a streamed export to the output, record by record, and count it. */
async function drain(
  response: Response,
  format: AuditExportFormat,
  output: CommandContext['output']
): Promise<{ rows: number; last: string | null; failed: boolean }> {
  let rows = 0
  let last: string | null = null
  let failed = false
  const emit = (records: string[]) => {
    for (const record of records) {
      output.line(record)
      // The CSV header is a record too, and has no cursor: only data rows count.
      const cursor = cursorOf(record, format)
      if (cursor !== null) {
        rows += 1
        last = cursor
      }
    }
  }
  let buffer = ''
  try {
    const decoder = new TextDecoder()
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      const taken = takeRecords(buffer + decoder.decode(chunk, { stream: true }))
      buffer = taken.rest
      emit(taken.records)
    }
    emit(takeRecords(`${buffer}\n`).records.filter(Boolean))
  } catch {
    failed = true
  }
  return { rows, last, failed }
}

async function run(context: CommandContext): Promise<number> {
  const { flags, io, output, positionals } = context
  if (positionals[0] !== 'export') {
    throw new UsageError(
      'Usage: tula audit export [--format ndjson|csv] [--from <time>] [--to <time>]'
    )
  }
  const body = requestOf(flags)
  const name = typeof flags.env === 'string' ? flags.env : 'default'
  const target = await resolveTarget({ name, environment: {}, flags, io, output }).catch(
    (error: unknown) => {
      if (isTulaAdminError(error) && error.code === 'client.agent_key') {
        throw new UsageError(
          'That is an agent key (tula_ak_…). An audit export needs a secret key (tula_sk_…).'
        )
      }
      throw error
    }
  )

  let response: Response
  try {
    response = await target.admin.stream('exportAuditLogs', { body })
  } catch (error) {
    if (isTulaAdminError(error)) {
      output.error(`${output.errorStyle.red('error:')} ${printable(error.code, 80)}`)
      return EXIT.error
    }
    throw error
  }

  const { rows, last, failed } = await drain(response, body.format, output)
  output.error(`${rows} ${rows === 1 ? 'entry' : 'entries'} exported.`)
  if (failed) {
    output.error(`${output.errorStyle.red('error:')} The stream ended early.`)
  }
  if (last !== null && (failed || rows >= 100_000)) {
    output.error(`Continue with: tula audit export --resume ${last}`)
  }
  return failed ? EXIT.error : EXIT.ok
}

/**
 * `tula audit export`: the environment's audit log to standard output, oldest first, as
 * NDJSON or CSV, streamed and resumable.
 *
 * @example
 * ```sh
 * tula audit export --format csv --from 2026-01-01 > audit.csv
 * ```
 */
export const auditCommand: Command = {
  name: 'audit',
  summary: 'Export the audit log as NDJSON or CSV.',
  usage:
    'tula audit export [--format ndjson|csv] [--from <time>] [--to <time>] [--action <type>] [--organization <id>] [--resume <cursor>] [--env <name>]',
  description:
    'Streams the environment’s audit entries to standard output, oldest first. One request ' +
    'writes at most 100000 entries; when a run stops early or reaches that limit, standard ' +
    'error names the cursor to pass to --resume, which continues with no gap and no repeat. ' +
    'The export is itself recorded in the audit log. Needs a secret key (not an agent key).',
  maxPositionals: 1,
  options: {
    format: {
      type: 'string',
      value: '<ndjson|csv>',
      description: 'Output format. Default ndjson.',
    },
    from: { type: 'string', value: '<time>', description: 'Entries at or after this time.' },
    to: { type: 'string', value: '<time>', description: 'Entries before this time.' },
    action: { type: 'string', value: '<type>', description: 'Only this action.' },
    organization: {
      type: 'string',
      value: '<id>',
      description: 'Only entries about this organization.',
    },
    resume: { type: 'string', value: '<cursor>', description: 'Continue after this cursor.' },
    env: {
      type: 'string',
      short: 'e',
      value: '<name>',
      description: 'Read TULA_SECRET_KEY_<NAME> first.',
    },
    'api-url': { type: 'string', value: '<url>', description: 'The Tula API.' },
    'insecure-http': { type: 'boolean', description: 'Allow plain http that is not localhost.' },
    'secret-key-file': {
      type: 'string',
      value: '<path>',
      description: 'Read the secret key from a file.',
    },
  },
  run,
}
