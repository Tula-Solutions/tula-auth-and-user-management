import type { Output } from '../output'
import { comparable, maskEmail } from './formats'
import type { Progress, RefusedItem } from './progress'
import type { ImportProvider, ParsedExport } from './types'

/** What the server's refusal codes mean, in this CLI's own words (never the server's text). */
const SERVER_REASONS: Readonly<Record<string, string>> = {
  'email.invalid': 'The server does not accept the address.',
  'import.unsupported_algorithm': 'The server does not read this password hash algorithm.',
  'import.hash_malformed': 'The password hash is not a well-formed hash of its algorithm.',
  'import.hash_parameters_too_weak':
    'The password hash has parameters below the server’s minimum (see docs/user-import.md).',
  'import.hash_parameters_too_costly':
    'The password hash has parameters above the server’s maximum (see docs/user-import.md).',
  'validation.failed': 'The row’s name, metadata or external id cannot be stored.',
  'source.organization_missing': 'The membership’s organization was not created.',
  'source.member_user_missing': 'The membership’s user is not in the environment.',
  'organization.role_unknown': 'The role does not exist in the environment.',
  'organization.slug_taken': 'The slug is taken and no organization with it could be found.',
}

/** What is said of a code this version has no words for. */
function reasonOf(code: string): string {
  return Object.hasOwn(SERVER_REASONS, code) ? (SERVER_REASONS[code] as string) : 'See the code.'
}

/** One refused line of a report. */
export interface RefusedLine {
  /** The kind of item: a user, an organization or a membership. */
  kind: 'user' | 'organization' | 'membership'
  /** Its number in its file. */
  row: number
  /** Why. */
  code: string
  /** The address, masked, for a user. */
  email?: string
  /** One sentence. */
  reason: string
}

/**
 * What a parsed export amounts to, for the dry run and the end of a run.
 *
 * @example
 * ```ts
 * const summary = summarize(parsed)
 * ```
 */
export interface Summary {
  /** Users in the file. */
  total: number
  /** Users that would be sent. */
  ready: number
  /** Of those, the number with each password algorithm. */
  algorithms: Record<string, number>
  /** Of those, the number without a password. */
  withoutPassword: number
  /** Of those, the number whose address repeats an earlier row's. */
  repeated: number
  /** Users refused before any request, by this command. */
  refused: RefusedLine[]
  /** Organizations and memberships in the files. */
  organizations: number
  memberships: number
}

/**
 * Count what a parsed export holds and list what is refused locally.
 *
 * @param parsed - The parsed export.
 * @returns The summary.
 */
export function summarize(parsed: ParsedExport): Summary {
  const algorithms: Record<string, number> = {}
  const seen = new Set<string>()
  const summary: Summary = {
    total: parsed.rows.length,
    ready: 0,
    algorithms,
    withoutPassword: 0,
    repeated: 0,
    refused: [],
    organizations: parsed.organizations.length,
    memberships: parsed.memberships.length,
  }
  for (const entry of parsed.rows) {
    if (entry.user === null || entry.refusal !== null) {
      if (entry.refusal) {
        summary.refused.push({
          kind: 'user',
          row: entry.row,
          code: entry.refusal.code,
          email: maskEmail(entry.email),
          reason: entry.refusal.reason,
        })
      }
      continue
    }
    summary.ready += 1
    const algorithm = entry.user.password?.algorithm
    if (algorithm === undefined) {
      summary.withoutPassword += 1
    } else {
      algorithms[algorithm] = (algorithms[algorithm] ?? 0) + 1
    }
    const key = comparable(entry.user.email)
    if (seen.has(key)) {
      summary.repeated += 1
    }
    seen.add(key)
  }
  for (const entry of parsed.organizations) {
    if (entry.refusal) {
      summary.refused.push({
        kind: 'organization',
        row: entry.row,
        code: entry.refusal.code,
        reason: entry.refusal.reason,
      })
    }
  }
  for (const entry of parsed.memberships) {
    if (entry.refusal) {
      summary.refused.push({
        kind: 'membership',
        row: entry.row,
        code: entry.refusal.code,
        reason: entry.refusal.reason,
      })
    }
  }
  return summary
}

/** The lines for what the server and the later steps refused, with the masked address of a user. */
export function serverRefusals(parsed: ParsedExport, progress: Progress): RefusedLine[] {
  const emails = new Map(parsed.rows.map((entry) => [entry.row, entry.email]))
  const lines: RefusedLine[] = progress.refused.map((item: RefusedItem) => ({
    kind: 'user',
    row: item.row,
    code: item.code,
    email: maskEmail(emails.get(item.row) ?? null),
    reason: reasonOf(item.code),
  }))
  for (const item of progress.organizations.failed) {
    lines.push({
      kind: 'organization',
      row: item.row,
      code: item.code,
      reason: reasonOf(item.code),
    })
  }
  for (const item of progress.memberships.failed) {
    lines.push({ kind: 'membership', row: item.row, code: item.code, reason: reasonOf(item.code) })
  }
  return lines
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

function refusedLines(output: Output, lines: readonly RefusedLine[]): void {
  if (lines.length === 0) {
    return
  }
  output.line()
  output.line(output.style.bold(`Refused (${lines.length}):`))
  for (const line of lines) {
    const who = line.email === undefined ? '' : `  ${line.email}`
    output.line(`  ${line.kind} ${line.row}  ${line.code}${who}  ${line.reason}`)
  }
}

/**
 * Print the dry-run report.
 *
 * @param output - Where to write.
 * @param provider - The provider.
 * @param parsed - The parsed export.
 * @param summary - {@link summarize} of it.
 */
export function renderDryRun(
  output: Output,
  provider: ImportProvider,
  parsed: ParsedExport,
  summary: Summary
): void {
  output.line(output.style.bold(`Dry run: ${provider} export. Nothing was sent.`))
  output.line()
  output.line(`Users in the file:        ${summary.total}`)
  output.line(`  would be imported:      ${summary.ready}`)
  for (const [algorithm, count] of Object.entries(summary.algorithms).sort()) {
    output.line(`    with ${algorithm} password: ${count}`)
  }
  output.line(`    without a password:   ${summary.withoutPassword}`)
  if (summary.repeated > 0) {
    output.line(
      `    repeating an address: ${summary.repeated} (the server skips them: the first row wins)`
    )
  }
  output.line(
    `  refused here:           ${summary.refused.filter((line) => line.kind === 'user').length}`
  )
  if (summary.organizations > 0 || summary.memberships > 0) {
    output.line(`Organizations:            ${summary.organizations}`)
    output.line(`Memberships:              ${summary.memberships}`)
  }
  for (const note of parsed.notes) {
    output.line()
    output.line(`Note: ${note}`)
  }
  refusedLines(output, summary.refused)
  output.line()
  output.line(
    summary.ready === 0 && summary.organizations === 0
      ? 'Nothing would be imported.'
      : 'Run the same command with --yes to import. It is safe to run again: users that exist are skipped.'
  )
}

/**
 * Print the result of a run.
 *
 * @param output - Where to write.
 * @param provider - The provider.
 * @param parsed - The parsed export.
 * @param summary - {@link summarize} of it.
 * @param progress - The finished progress.
 * @returns How many items were refused in all.
 */
export function renderResult(
  output: Output,
  provider: ImportProvider,
  parsed: ParsedExport,
  summary: Summary,
  progress: Progress
): number {
  const server = serverRefusals(parsed, progress)
  const all = [...summary.refused, ...server]
  output.line(output.style.bold(`Imported the ${provider} export.`))
  output.line()
  output.line(`Users created:            ${progress.counts.created}`)
  output.line(
    `Users skipped:            ${progress.counts.skipped} (their address was already a user)`
  )
  output.line(
    `Users refused:            ${summary.refused.filter((line) => line.kind === 'user').length + progress.counts.refused}`
  )
  if (summary.organizations > 0 || summary.memberships > 0) {
    const orgs = progress.organizations
    const members = progress.memberships
    output.line(
      `Organizations:            ${orgs.created} created, ${orgs.existing} already there, ${orgs.failed.length} failed`
    )
    output.line(
      `Memberships:              ${members.added} added, ${members.existing} already members, ${members.failed.length} failed`
    )
  }
  for (const note of parsed.notes) {
    output.line()
    output.line(`Note: ${note}`)
  }
  refusedLines(output, all)
  output.line()
  output.line(
    all.length === 0
      ? 'Done.'
      : `Done, with ${plural(all.length, 'refused item')}. Fix the export and run the same command again to retry: what exists is skipped.`
  )
  return all.length
}

/**
 * The report as JSON, for `--json`.
 *
 * @param provider - The provider.
 * @param parsed - The parsed export.
 * @param summary - {@link summarize} of it.
 * @param progress - The progress, for a real run; absent for a dry run.
 * @returns A plain object. It holds row numbers, codes and masked addresses, and no secret.
 */
export function reportToJson(
  provider: ImportProvider,
  parsed: ParsedExport,
  summary: Summary,
  progress?: Progress
): unknown {
  return {
    provider,
    dryRun: progress === undefined,
    users: {
      total: summary.total,
      ready: summary.ready,
      withoutPassword: summary.withoutPassword,
      algorithms: summary.algorithms,
      repeatedAddresses: summary.repeated,
    },
    organizations: summary.organizations,
    memberships: summary.memberships,
    notes: parsed.notes,
    refused: [...summary.refused, ...(progress ? serverRefusals(parsed, progress) : [])],
    ...(progress
      ? {
          result: {
            created: progress.counts.created,
            skipped: progress.counts.skipped,
            refusedByServer: progress.counts.refused,
            organizations: {
              created: progress.organizations.created,
              existing: progress.organizations.existing,
              failed: progress.organizations.failed.length,
            },
            memberships: {
              added: progress.memberships.added,
              existing: progress.memberships.existing,
              failed: progress.memberships.failed.length,
            },
          },
        }
      : {}),
  }
}
