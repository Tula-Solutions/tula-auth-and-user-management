import { examine, exitCode, renderReport, reportToJson } from '../doctor'
import type { Command } from '../framework'
import { resolveApiUrl, resolveInstance } from '../target'

/**
 * `tula doctor`: check what actually goes wrong in a deployment, each with its fix. The CLI
 * checks what it can see from this machine (the API answers, the versions match, the clocks
 * agree); the API checks itself (`GET /v1/instance/diagnostics`): the database and its
 * migrations, the master key against the stored secrets, the mail relay, Redis, `PUBLIC_URL`
 * and each enabled provider's redirect URI. The CLI never connects to the database.
 *
 * @example
 * ```sh
 * TULA_API_URL=https://auth.example.com TULA_ADMIN_TOKEN=… tula doctor --strict
 * ```
 */
export const doctorCommand: Command = {
  name: 'doctor',
  summary: 'Check a deployment: database, migrations, master key, mail, Redis, URLs.',
  usage: 'tula doctor [--api-url <url>] [--admin-token-file <path>] [--strict] [--json]',
  description:
    'Checks what actually goes wrong in a deployment and prints the fix under each check that ' +
    'is not ok. The API URL comes from --api-url or TULA_API_URL; the instance admin token ' +
    '(the server’s TULA_ADMIN_TOKEN) from TULA_ADMIN_TOKEN or --admin-token-file, never from ' +
    'the command line. Without a token only the checks this machine can make are run.\n\n' +
    'Exit codes: 0 nothing failed, 1 a check failed (or warned, with --strict) or an error.',
  options: {
    'api-url': {
      type: 'string',
      value: '<url>',
      description: 'The Tula API. Default: TULA_API_URL.',
    },
    'admin-token-file': {
      type: 'string',
      value: '<path>',
      description:
        'Read the instance admin token from a file (- for standard input, piped). Default: TULA_ADMIN_TOKEN.',
    },
    'insecure-http': {
      type: 'boolean',
      description:
        'Allow a plain http API URL that is not localhost: the admin token then crosses the network in clear text.',
    },
    strict: { type: 'boolean', description: 'Exit 1 on a warning too.' },
    json: { type: 'boolean', description: 'Print the report as JSON.' },
  },
  run: async ({ flags, io, output }) => {
    const apiUrl = resolveApiUrl(flags, io)
    const instance = await resolveInstance({ apiUrl, flags, io, output })
    const report = await examine({ apiUrl, instance, io })
    const strict = flags.strict === true
    if (flags.json) {
      output.line(JSON.stringify(reportToJson(report, strict), null, 2))
    } else {
      renderReport(output, report)
    }
    return exitCode(report, strict)
  },
}
