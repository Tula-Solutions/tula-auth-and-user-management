import { type InstanceClient, isTulaAdminError } from '@tula/admin'
import type { CliIo } from './framework'
import type { Output } from './output'
import { VERSION } from './version'

/**
 * How one check went.
 *
 * @example
 * ```ts
 * const status: CheckStatus = 'warn'
 * ```
 */
export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skipped'

/**
 * One line of `tula doctor`'s report.
 *
 * @example
 * ```ts
 * const check: DoctorCheck = { id: 'api', source: 'cli', status: 'ok', summary: 'The API answers.' }
 * ```
 */
export interface DoctorCheck {
  /** Stable identifier, e.g. `database`. */
  id: string
  /** Where it ran: on this machine, or inside the API. */
  source: 'cli' | 'server'
  /** How it went. */
  status: CheckStatus
  /** One sentence saying what was found. */
  summary: string
  /** What to do about it. */
  fix?: string
  /** Values the operator needs, e.g. redirect URIs. */
  values?: string[]
}

/**
 * What `tula doctor` found.
 *
 * @example
 * ```ts
 * const report = await examine({ apiUrl, instance, io })
 * process.exit(exitCode(report, false))
 * ```
 */
export interface DoctorReport {
  /** The API that was examined. */
  apiUrl: string
  /** The API's version, when it answered. */
  version?: string
  /** The deployment tier, when the server-side checks ran. */
  environment?: string
  /** Every check, the CLI's own first. */
  checks: DoctorCheck[]
}

/** This machine's clock against the server's: worth a warning, and broken. */
const SKEW_WARN_MS = 5_000
const SKEW_FAIL_MS = 30_000

/** How long this machine waits for `/v1/status`. */
const STATUS_TIMEOUT_MS = 10_000

const STATUSES: ReadonlySet<string> = new Set(['ok', 'warn', 'fail', 'skipped'])

/**
 * What a terminal acts on instead of showing, or draws as a break: C0 and C1 controls (an
 * escape sequence could rewrite the screen or the window title) and the line and paragraph
 * separators. Each becomes a space, so the words either side stay apart.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
const CONTROLS = /[\u{0}-\u{1F}\u{7F}-\u{9F}\p{Zl}\p{Zp}]/gu

/**
 * What a reader cannot see but a terminal obeys or hides: format characters (`Cf`: the bidi
 * overrides and isolates that make text read in another order than it is stored, zero-width
 * spaces and joiners, the byte-order mark, tag characters), private-use and unassigned code
 * points (`Co`, `Cn`) and lone surrogates (`Cs`). Unicode classes with the `u` flag, never a
 * list of code points: the list would be out of date with the next Unicode version.
 */
const INVISIBLE = /[\p{Cf}\p{Co}\p{Cn}\p{Cs}]/gu

/**
 * Text from a server, made safe for a terminal and bounded: no control characters (an escape
 * sequence could rewrite the screen or the window title), and nothing invisible that changes
 * how the rest reads (a right-to-left override would show `all good` for a failing check's
 * text; a zero-width space splits a word a reader would search for).
 *
 * @param value - What the server sent.
 * @param max - The longest text kept, in UTF-16 units; a character is never cut in half.
 * @returns Printable text.
 *
 * @example
 * ```ts
 * printable('ok\u001b[2J') // 'ok [2J'
 * printable('ok\u{202E}txt.exe') // 'oktxt.exe'
 * ```
 */
export function printable(value: unknown, max = 600): string {
  const text = typeof value === 'string' ? value : ''
  return (
    text
      .replace(CONTROLS, ' ')
      .replace(INVISIBLE, '')
      .slice(0, max)
      // The cut may have split a surrogate pair: half a character is a lone surrogate.
      .replace(INVISIBLE, '')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The server's checks, read defensively: the answer is data from the network. */
function serverChecks(data: unknown): DoctorCheck[] {
  const checks = isRecord(data) && Array.isArray(data.checks) ? data.checks : []
  return checks.filter(isRecord).map((check) => ({
    id: printable(check.id, 60) || 'unknown',
    source: 'server' as const,
    status: (typeof check.status === 'string' && STATUSES.has(check.status)
      ? check.status
      : 'fail') as CheckStatus,
    summary: printable(check.summary),
    ...(typeof check.fix === 'string' ? { fix: printable(check.fix) } : {}),
    ...(Array.isArray(check.values)
      ? { values: check.values.slice(0, 50).map((value) => printable(value, 300)) }
      : {}),
  }))
}

async function status(
  io: CliIo,
  url: string,
  signal: AbortSignal | undefined
): Promise<{ status: number; version?: string } | null> {
  const send = io.fetch ?? ((target, init) => fetch(target, init))
  try {
    const response = await send(`${url}/v1/status`, {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': `tula-cli/${VERSION}` },
      redirect: 'manual',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(STATUS_TIMEOUT_MS)])
        : AbortSignal.timeout(STATUS_TIMEOUT_MS),
    })
    const body: unknown = await response.json().catch(() => null)
    const version = isRecord(body) && typeof body.version === 'string' ? body.version : undefined
    return { status: response.status, version: version && printable(version, 40) }
  } catch {
    return null
  }
}

function parseUrl(text: string): URL | null {
  try {
    return new URL(text)
  } catch {
    return null
  }
}

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '127.0.0.1' ||
      host === '[::1]'
    )
  } catch {
    return false
  }
}

/** Why the server-side checks did not run, as a check of its own. */
function refusedCheck(error: unknown): DoctorCheck {
  const base = { id: 'server_checks', source: 'cli' as const }
  if (isTulaAdminError(error)) {
    if (error.status === 404) {
      return {
        ...base,
        status: 'warn',
        summary:
          'The server has no instance admin token, so its own checks (database, migrations, master key, mail, Redis) did not run.',
        fix: 'Set TULA_ADMIN_TOKEN in the API’s environment (`openssl rand -hex 32`), restart it, and set the same value here.',
      }
    }
    if (error.status === 401) {
      return {
        ...base,
        status: 'fail',
        summary: 'The server refused the admin token.',
        fix: 'Set TULA_ADMIN_TOKEN here to the value in the API’s environment (or pass --admin-token-file). After changing it on the server, restart the API.',
      }
    }
    if (error.code === 'service.unavailable') {
      return {
        ...base,
        status: 'fail',
        summary:
          'The API refused the request because the store behind its rate limits (Redis) does not answer.',
        fix: 'Check REDIS_URL in the API’s environment and that Redis is running and reachable from the API. Until it answers, sign-in is refused too.',
      }
    }
    if (error.code === 'rate_limited') {
      return {
        ...base,
        status: 'fail',
        summary: 'The API is rate limiting this machine’s diagnostics requests.',
        fix: 'Wait a minute and run `tula doctor` again.',
      }
    }
    return {
      ...base,
      status: 'fail',
      summary: `The server-side checks could not be read (${printable(error.code, 60)}${error.status > 0 ? `, HTTP ${error.status}` : ''}).`,
      fix: 'Check that TULA_API_URL is the Tula API itself (not a page in front of it) and that the CLI and the server are the same version.',
    }
  }
  return {
    ...base,
    status: 'fail',
    summary: 'The server-side checks could not be read.',
    fix: 'Run `tula doctor` again; if it persists, look at the API’s logs.',
  }
}

/**
 * Examine a deployment: what this machine can see (the API answers, its version, the two
 * clocks, a loopback `PUBLIC_URL`) and what the API reports about itself through
 * `GET /v1/instance/diagnostics`.
 *
 * It never throws for something a check can say: an unreachable API is a failing check.
 *
 * @param input - The API's URL, the instance client (`null` without an admin token), the io,
 *   and optionally a signal: aborting it ends the request in flight, and the run answers with
 *   the failing check an unreachable API gets (`tula mcp` abandons a run that takes too long).
 * @returns The report.
 *
 * @example
 * ```ts
 * const report = await examine({ apiUrl: 'http://localhost:3003', instance, io })
 * ```
 */
export async function examine(input: {
  apiUrl: string
  instance: InstanceClient | null
  io: CliIo
  signal?: AbortSignal
}): Promise<DoctorReport> {
  const { apiUrl, instance, io, signal } = input
  const now = io.now ?? (() => new Date())
  const report: DoctorReport = { apiUrl, checks: [] }

  const answer = await status(io, apiUrl, signal)
  if (answer?.status !== 200) {
    report.checks.push({
      id: 'api',
      source: 'cli',
      status: 'fail',
      summary: answer
        ? `The API URL answers with HTTP ${answer.status} instead of the API’s status.`
        : 'The API cannot be reached from this machine.',
      fix: 'Check TULA_API_URL (or --api-url): it is the address of the Tula API, with no path. Check that the API is running (`tula dev`, or `docker compose ps`) and, for https, that its certificate is valid.',
    })
    return report
  }
  report.version = answer.version
  report.checks.push({
    id: 'api',
    source: 'cli',
    status: 'ok',
    summary: `The API answers${apiUrl.startsWith('https:') ? ' over TLS' : ''}.`,
  })
  report.checks.push(
    answer.version === VERSION
      ? {
          id: 'version',
          source: 'cli',
          status: 'ok',
          summary: `The CLI and the API are the same version (${VERSION}).`,
        }
      : {
          id: 'version',
          source: 'cli',
          status: 'warn',
          summary: `The CLI is version ${VERSION} and the API is ${answer.version ?? 'unknown'}.`,
          fix: 'Use the CLI of the API’s version: a different one may not know every setting or check.',
        }
  )

  if (!instance) {
    report.checks.push({
      id: 'server_checks',
      source: 'cli',
      status: 'warn',
      summary:
        'No admin token here, so the server’s own checks (database, migrations, master key, mail, Redis) did not run.',
      fix: 'Set TULA_ADMIN_TOKEN to the value in the API’s environment, or pass --admin-token-file <path>.',
    })
    return report
  }

  const before = now().getTime()
  let data: unknown
  try {
    data = (await instance.call('getInstanceDiagnostics', { signal })).data
  } catch (error) {
    report.checks.push(refusedCheck(error))
    return report
  }
  const after = now().getTime()
  const body = isRecord(data) ? data : {}
  report.environment = printable(body.environment, 20) || undefined
  const server = serverChecks(data)

  // The server's clock was read somewhere between the two: compare with the middle.
  const serverTime = typeof body.time === 'string' ? Date.parse(body.time) : Number.NaN
  if (!Number.isNaN(serverTime)) {
    const skewMs = Math.abs(serverTime - (before + after) / 2)
    report.checks.push(
      skewMs < SKEW_WARN_MS
        ? {
            id: 'local_clock',
            source: 'cli',
            status: 'ok',
            summary: 'This machine’s clock and the API’s agree.',
          }
        : {
            id: 'local_clock',
            source: 'cli',
            status: skewMs >= SKEW_FAIL_MS ? 'fail' : 'warn',
            summary: `This machine’s clock and the API’s differ by about ${Math.round(skewMs / 1000)} seconds.`,
            fix: 'Synchronize the clocks (NTP). A server that verifies Tula’s tokens on a clock this far off refuses valid ones or accepts expired ones.',
          }
    )
  }

  // A loopback PUBLIC_URL is one the server cannot check from inside a container; this machine
  // can. But the address is the server's word: it is requested only when it is the origin the
  // operator pointed this command at, and then only as `<origin>/v1/status`. Anything else (a
  // port, a path or a query of the server's choosing, credentials) is never requested.
  const skipped = server.find((check) => check.id === 'public_url' && check.status === 'skipped')
  const named = typeof body.publicUrl === 'string' ? parseUrl(body.publicUrl) : null
  if (skipped && named && isLoopback(named.href)) {
    const configured = parseUrl(apiUrl)
    if (
      configured &&
      named.origin === configured.origin &&
      named.username === '' &&
      named.password === ''
    ) {
      const reached =
        apiUrl.replace(/\/+$/, '') === named.origin
          ? answer
          : await status(io, named.origin, signal)
      Object.assign(
        skipped,
        reached?.status === 200
          ? {
              source: 'cli',
              status: 'ok',
              summary: 'PUBLIC_URL is a loopback address and reaches the API from this machine.',
            }
          : {
              source: 'cli',
              status: 'warn',
              summary:
                'PUBLIC_URL is a loopback address that does not reach the API from this machine.',
              fix: 'Set PUBLIC_URL in the API’s environment to the address clients use to reach it (for local development, the port the API is published on), and restart it.',
            }
      )
    } else {
      Object.assign(skipped, {
        source: 'cli',
        status: 'skipped',
        summary:
          'PUBLIC_URL is a loopback address other than the API URL given here, so it was not requested: `tula doctor` asks only the address you give it. If clients reach the API there, run `tula doctor --api-url <PUBLIC_URL>`; if not, set PUBLIC_URL to the address they use.',
      })
    }
  }
  report.checks.push(...server)
  return report
}

/**
 * The exit code of a report: `1` when a check failed, or warned under `--strict`.
 *
 * @param report - The report.
 * @param strict - Whether a warning fails too.
 * @returns `0` or `1`.
 *
 * @example
 * ```ts
 * exitCode(report, flags.strict === true)
 * ```
 */
export function exitCode(report: DoctorReport, strict: boolean): number {
  const failing = (check: DoctorCheck) =>
    check.status === 'fail' || (strict && check.status === 'warn')
  return report.checks.some(failing) ? 1 : 0
}

/**
 * The report as data, for `--json`.
 *
 * @param report - The report.
 * @param strict - Whether a warning fails.
 * @returns A JSON-ready object.
 *
 * @example
 * ```ts
 * output.line(JSON.stringify(reportToJson(report, false), null, 2))
 * ```
 */
export function reportToJson(report: DoctorReport, strict: boolean) {
  return { ...report, ok: exitCode(report, strict) === 0 }
}

/**
 * Print the report as a table, with a fix line under each check that is not ok.
 *
 * @param output - Where to write.
 * @param report - The report.
 *
 * @example
 * ```ts
 * renderReport(output, report)
 * ```
 */
export function renderReport(output: Output, report: DoctorReport): void {
  const { style } = output
  const labels: Record<CheckStatus, string> = {
    ok: style.green('ok     '),
    warn: style.yellow('warn   '),
    fail: style.red('FAIL   '),
    skipped: style.dim('skipped'),
  }
  const about = [report.environment, report.version && `version ${report.version}`]
    .filter(Boolean)
    .join(', ')
  output.line(style.bold(`tula doctor: ${report.apiUrl}${about ? ` (${about})` : ''}`))
  output.line()
  const width = Math.max(...report.checks.map((check) => check.id.length))
  const indent = ' '.repeat(2 + 7 + 2 + width + 2)
  for (const check of report.checks) {
    output.line(`  ${labels[check.status]}  ${check.id.padEnd(width)}  ${check.summary}`)
    for (const value of check.values ?? []) {
      output.line(`${indent}- ${value}`)
    }
    if (check.fix !== undefined && check.status !== 'ok') {
      output.line(`${indent}fix: ${check.fix}`)
    }
  }
  output.line()
  const count = (status: CheckStatus) =>
    report.checks.filter((check) => check.status === status).length
  const warnings = count('warn')
  output.line(
    `${count('ok')} ok, ${count('fail')} failed, ${warnings} warning${warnings === 1 ? '' : 's'}, ${count('skipped')} skipped.`
  )
}
