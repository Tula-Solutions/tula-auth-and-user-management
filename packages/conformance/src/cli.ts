import { loadScenarios } from './load'
import { mailpitCodes } from './mailpit'
import { formatResult, runScenario, type Target } from './runner'

/**
 * Run every scenario against a live server: `bun run conformance`.
 *
 * Settings come from the environment:
 * - `CONFORMANCE_BASE_URL` (default `http://localhost:3003`)
 * - `CONFORMANCE_PUBLISHABLE_KEY` (required)
 * - `CONFORMANCE_SECRET_KEY` (optional; admin scenarios are skipped without it)
 * - `CONFORMANCE_MAILPIT_URL` (default `http://localhost:8025`)
 *
 * The server must run with `TRUST_PROXY=true` and deliver mail to that Mailpit.
 */
const publishableKey = process.env.CONFORMANCE_PUBLISHABLE_KEY
if (!publishableKey) {
  process.stderr.write('conformance: set CONFORMANCE_PUBLISHABLE_KEY (see conformance/README.md)\n')
  process.exit(2)
}

const target: Target = {
  baseUrl: (process.env.CONFORMANCE_BASE_URL ?? 'http://localhost:3003').replace(/\/+$/, ''),
  publishableKey,
  secretKey: process.env.CONFORMANCE_SECRET_KEY || undefined,
  fetch: (request) => fetch(request),
  emailCode: mailpitCodes(process.env.CONFORMANCE_MAILPIT_URL ?? 'http://localhost:8025'),
  wait: (ms) => Bun.sleep(ms),
}

const counts = { passed: 0, failed: 0, skipped: 0 }
for (const { scenario } of await loadScenarios()) {
  const result = await runScenario(scenario, target)
  counts[result.status] += 1
  process.stdout.write(`${formatResult(result)}\n`)
}
process.stdout.write(
  `\n${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped against ${target.baseUrl}\n`
)
process.exit(counts.failed > 0 ? 1 : 0)
