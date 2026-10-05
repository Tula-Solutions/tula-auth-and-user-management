import { loadScenarios } from './load'
import { mailpitCodes, mailpitLinks } from './mailpit'
import { exitCode, formatResult, runScenario, type Target } from './runner'

/**
 * Run every scenario against a live server: `bun run conformance`.
 *
 * Settings come from the environment:
 * - `CONFORMANCE_BASE_URL` (default `http://localhost:3003`)
 * - `CONFORMANCE_PUBLISHABLE_KEY` (required)
 * - `CONFORMANCE_SECRET_KEY` (optional; admin scenarios are skipped without it)
 * - `CONFORMANCE_MAILPIT_URL` (default `http://localhost:8025`)
 * - `CONFORMANCE_SETTLE_MS` (optional): for a run through one address in front of several
 *   instances; how long to wait after each settings change (see `Target.settleMs`).
 * - `CONFORMANCE_SECOND_BASE_URL` (optional): a second instance of the same deployment. Steps
 *   marked `instance: "second"` go there; without it they go to the first.
 *
 * The server must run with `TRUST_PROXY=true` and deliver mail to that Mailpit.
 */
const publishableKey = process.env.CONFORMANCE_PUBLISHABLE_KEY
if (!publishableKey) {
  process.stderr.write('conformance: set CONFORMANCE_PUBLISHABLE_KEY (see conformance/README.md)\n')
  process.exit(2)
}

const secondBaseUrl = process.env.CONFORMANCE_SECOND_BASE_URL?.replace(/\/+$/, '')

const mailpit = process.env.CONFORMANCE_MAILPIT_URL ?? 'http://localhost:8025'

const settleMs = Number(process.env.CONFORMANCE_SETTLE_MS ?? '0')
if (!Number.isInteger(settleMs) || settleMs < 0 || settleMs > 60_000) {
  process.stderr.write(
    'conformance: CONFORMANCE_SETTLE_MS must be a whole number of milliseconds, at most 60000\n'
  )
  process.exit(2)
}

const target: Target = {
  baseUrl: (process.env.CONFORMANCE_BASE_URL ?? 'http://localhost:3003').replace(/\/+$/, ''),
  second: secondBaseUrl
    ? { baseUrl: secondBaseUrl, fetch: (request) => fetch(request) }
    : undefined,
  publishableKey,
  secretKey: process.env.CONFORMANCE_SECRET_KEY || undefined,
  fetch: (request) => fetch(request),
  emailCode: mailpitCodes(mailpit),
  emailLink: mailpitLinks(mailpit),
  wait: (ms) => Bun.sleep(ms),
  settleMs: settleMs > 0 ? settleMs : undefined,
  // Authenticator codes are computed for the wall clock, which is the server's clock too.
  now: () => Date.now(),
}

const counts = { passed: 0, failed: 0, skipped: 0 }
for (const { scenario } of await loadScenarios()) {
  const result = await runScenario(scenario, target)
  counts[result.status] += 1
  process.stdout.write(`${formatResult(result)}\n`)
}
process.stdout.write(
  `\n${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped against ${target.baseUrl}${
    // Said explicitly, so a run that was meant to cover two instances can be checked for it.
    target.second
      ? ` and ${target.second.baseUrl}`
      : target.settleMs
        ? ` (one address, ${target.settleMs} ms after each settings change)`
        : ' (one instance)'
  }\n`
)
process.exit(exitCode(counts))
