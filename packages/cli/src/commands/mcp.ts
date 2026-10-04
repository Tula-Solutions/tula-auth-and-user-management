import { isTulaAdminError } from '@tula/admin'
import { UsageError } from '../args'
import { examine } from '../doctor'
import { type Command, type CommandContext, EXIT } from '../framework'
import type { Output } from '../output'
import { resolveApiUrl, resolveInstance, resolveTarget } from '../target'
import { VERSION } from '../version'

// `@tula/mcp` is never imported at the top of this file: it brings the MCP SDK and Zod with
// it, and this module is loaded by every run of `tula` (the command's name, options and help
// are listed by `tula --help`). It is loaded with `import()` when the server is built.

/** `prod-eu` → `PROD_EU`, as `resolveTarget` names an environment's own variables. */
function suffix(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, '_')
}

/** Why a part of the server is not available: a sentence of this CLI's own, never a value. */
function reason(error: unknown): string {
  if (error instanceof UsageError) {
    // Without --env the target is resolved under the name "default"; its variables are not
    // worth suggesting.
    return error.message.replace(/ \(or TULA_[A-Z_]+_DEFAULT\)/g, '')
  }
  if (isTulaAdminError(error)) {
    return `The configured credential or API URL is not usable (${error.code}).`
  }
  throw error
}

/**
 * Build the MCP server `tula mcp` serves, from the same places every other command reads its
 * target: the API URL from `--api-url`, `TULA_API_URL_<NAME>` or `TULA_API_URL`; the secret
 * key from `--secret-key-file`, `TULA_SECRET_KEY_<NAME>` or `TULA_SECRET_KEY`; the instance
 * admin token (for `run_doctor`'s server-side checks only) from `--admin-token-file` or
 * `TULA_ADMIN_TOKEN`. Never from an argument, and never from a tool's input.
 *
 * Nothing is required: what is missing or refused (a plain-http URL that is not this machine)
 * becomes the "not configured" answer of the tools that needed it, and is said once on
 * standard error. The scaffold tools need none of it.
 *
 * This is where `@tula/mcp` is loaded, on first use.
 *
 * @param context - The command's context.
 * @returns The server, not yet connected.
 *
 * @example
 * ```ts
 * const server = await buildMcpServer({ flags: {}, positionals: [], io, output })
 * await server.connect(transport)
 * ```
 */
export async function buildMcpServer(context: CommandContext) {
  const { flags, io } = context
  for (const option of ['secret-key-file', 'admin-token-file']) {
    if (flags[option] === '-') {
      throw new UsageError(
        `--${option} - would read from standard input, which carries the protocol. Use a file or the environment.`
      )
    }
  }
  const { createTulaMcpServer, TOOL_NAMES } = await import('@tula/mcp')
  // Every credential that is resolved is registered for redaction; remember them, so that
  // the server can remove them from results too.
  const secrets: string[] = []
  const output: Output = {
    ...context.output,
    redact: (value, scope) => {
      secrets.push(value)
      context.output.redact(value, scope)
    },
  }
  const name = typeof flags.env === 'string' ? flags.env : 'default'
  const unavailable: { admin?: string; doctor?: string } = {}

  const admin = await resolveTarget({ name, environment: {}, flags, io, output }).then(
    (target) => target.admin,
    (error: unknown) => {
      unavailable.admin = reason(error)
      return null
    }
  )

  let doctor: ((run: { signal: AbortSignal }) => Promise<unknown>) | null = null
  try {
    const named = io.env[`TULA_API_URL_${suffix(name)}`]?.trim()
    const apiUrl = resolveApiUrl(
      flags['api-url'] === undefined && named ? { ...flags, 'api-url': named } : flags,
      io
    )
    const instance = await resolveInstance({ apiUrl, flags, io, output })
    // The server aborts the signal when a run is out of time or its call was cancelled.
    doctor = ({ signal }) => examine({ apiUrl, instance, io, signal })
  } catch (error) {
    unavailable.doctor = reason(error)
  }

  context.output.error(
    `tula mcp: ${TOOL_NAMES.length} tools, all read-only. Read tools: ${
      admin ? 'configured' : 'not configured'
    }. Doctor: ${doctor ? 'configured' : 'not configured'}.`
  )
  for (const why of new Set(Object.values(unavailable))) {
    context.output.error(`tula mcp: ${why}`)
  }
  return createTulaMcpServer({
    admin,
    doctor,
    cwd: io.cwd,
    secrets,
    log: (line) => context.output.error(line),
    unavailable,
    version: VERSION,
  })
}

/**
 * `tula mcp`: serve Tula's Model Context Protocol server on standard input and output, for an
 * MCP client (Claude Code, Claude Desktop, an editor) to start as a child process. Read tools
 * over an environment's users, sessions, audit entries, settings and deployment checks, and
 * scaffold tools that return files for the client to write. No tool changes live data and
 * none returns a secret.
 *
 * @example
 * ```sh
 * TULA_API_URL=https://auth.example.com TULA_SECRET_KEY=… tula mcp
 * ```
 */
export const mcpCommand: Command = {
  name: 'mcp',
  summary: 'Serve the read-only MCP server on standard input and output.',
  usage:
    'tula mcp [--env <name>] [--api-url <url>] [--secret-key-file <path>] [--admin-token-file <path>]',
  description:
    'Serves Tula’s Model Context Protocol server over standard input and output, for an MCP ' +
    'client to start. Read tools: users, sessions, audit entries, settings, OAuth providers ' +
    'and the doctor’s checks. Scaffold tools: the provider, a protected route and a sign-in ' +
    'page, returned as files for the client to write. No tool changes live data, and no tool ' +
    'returns a secret.\n\n' +
    'The API URL comes from --api-url, TULA_API_URL_<NAME> or TULA_API_URL; the secret key ' +
    'from --secret-key-file, TULA_SECRET_KEY_<NAME> or TULA_SECRET_KEY; the instance admin ' +
    'token (run_doctor only) from --admin-token-file or TULA_ADMIN_TOKEN. None is required: ' +
    'without a key the read tools answer "not configured" and the scaffold tools still work. ' +
    'Standard output carries only the protocol; everything else is written to standard error.',
  options: {
    env: {
      type: 'string',
      short: 'e',
      value: '<name>',
      description: 'Read TULA_API_URL_<NAME> and TULA_SECRET_KEY_<NAME> first.',
    },
    'api-url': {
      type: 'string',
      value: '<url>',
      description: 'The Tula API. Default: TULA_API_URL_<NAME>, then TULA_API_URL.',
    },
    'secret-key-file': {
      type: 'string',
      value: '<path>',
      description:
        'Read the secret key from a file. Default: TULA_SECRET_KEY_<NAME>, then TULA_SECRET_KEY.',
    },
    'admin-token-file': {
      type: 'string',
      value: '<path>',
      description: 'Read the instance admin token from a file. Default: TULA_ADMIN_TOKEN.',
    },
    'insecure-http': {
      type: 'boolean',
      description:
        'Allow a plain http API URL that is not localhost: the credentials then cross the network in clear text.',
    },
  },
  run: async (context) => {
    const { serve } = context.io
    if (!serve) {
      throw new UsageError('tula mcp needs the process’s standard input and output.')
    }
    const server = await buildMcpServer(context)
    const { serveOverStdio } = await import('@tula/mcp')
    await serveOverStdio(server, serve)
    return EXIT.ok
  },
}
