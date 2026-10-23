import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { MAX_IMPORT_ROWS } from '@tula-tech/contract'
import { UsageError } from '../args'
import { type Command, type CommandContext, EXIT, reportError } from '../framework'
import { parseAuth0 } from '../import/auth0'
import { parseBetterAuth } from '../import/better-auth'
import { parseClerk } from '../import/clerk'
import { parseFirebase, parseHashConfig } from '../import/firebase'
import { standardBase64 } from '../import/formats'
import { fingerprintOf, newProgress, type Progress, readProgress } from '../import/progress'
import { renderDryRun, renderResult, reportToJson, summarize } from '../import/report'
import { importOrganizations, importUsers, type RunContext } from '../import/run'
import { parseSupabase } from '../import/supabase'
import {
  IMPORT_PROVIDERS,
  type ImportProvider,
  type ParsedExport,
  type ParseInput,
  type Parser,
} from '../import/types'
import { resolveTarget } from '../target'

const USAGE =
  'tula import --from <provider> <export file> [--yes] [--progress-file <path>] [--fresh] [--allow-passwordless]\n' +
  '            [--password-hashes <file>] [--accounts <file>] [--organizations <file>] [--memberships <file>]\n' +
  '            [--firebase-hash-config <file>] [--firebase-rounds <n>] [--firebase-mem-cost <n>]\n' +
  '            [--batch-size <n>] [--max-wait <seconds>] [--env <name>] [--api-url <url>] [--secret-key-file <path>] [--json]'

/** The parser of each provider. A new provider is an entry here, a parser file and a guide. */
const PARSERS: Readonly<Record<ImportProvider, Parser>> = {
  clerk: parseClerk,
  auth0: parseAuth0,
  firebase: parseFirebase,
  supabase: (input) => parseSupabase(input),
  'better-auth': parseBetterAuth,
}

/** The extra files each provider takes, by option name. */
const EXTRA_FILES: Readonly<Record<ImportProvider, readonly string[]>> = {
  clerk: ['organizations', 'memberships'],
  auth0: ['password-hashes'],
  firebase: [],
  supabase: [],
  'better-auth': ['accounts'],
}

const ALL_EXTRA = ['organizations', 'memberships', 'password-hashes', 'accounts'] as const

/** Default for `--max-wait`, in seconds: the longest a `Retry-After` is waited. */
const DEFAULT_MAX_WAIT_SECONDS = 120

function whole(
  flags: CommandContext['flags'],
  name: string,
  min: number,
  max: number
): number | undefined {
  const value = flags[name]
  if (typeof value !== 'string') {
    return undefined
  }
  const number = /^\d{1,6}$/.test(value) ? Number(value) : Number.NaN
  if (!(number >= min && number <= max)) {
    throw new UsageError(`--${name} takes a whole number from ${min} to ${max}.`)
  }
  return number
}

/** Read one input file through the host: never a link, never a pipe. */
async function readInput(context: CommandContext, path: string, option: string): Promise<string> {
  const host = context.io.host
  if (!host) {
    throw new UsageError('This run cannot read files.')
  }
  const found = await host.readFile(resolve(context.io.cwd, path))
  if (found === null) {
    throw new UsageError(`The file given as ${option} does not exist.`)
  }
  return found
}

/** Firebase's hash parameters from the file, the environment and the flags. Nothing is printed. */
async function firebaseParameters(context: CommandContext): Promise<ParseInput['firebase']> {
  const { flags, io, output } = context
  const file =
    typeof flags['firebase-hash-config'] === 'string' ? flags['firebase-hash-config'] : undefined
  const rounds = whole(flags, 'firebase-rounds', 1, 1000)
  const memCost = whole(flags, 'firebase-mem-cost', 1, 1000)
  const fromEnv = io.env.TULA_FIREBASE_SIGNER_KEY?.trim()
  if (file === undefined && !fromEnv) {
    return undefined
  }
  const config =
    file !== undefined
      ? parseHashConfig(await readInput(context, file, '--firebase-hash-config'))
      : {
          signerKey: standardBase64(fromEnv ?? ''),
          saltSeparator: standardBase64(io.env.TULA_FIREBASE_SALT_SEPARATOR ?? ''),
          rounds: undefined,
          memCost: undefined,
        }
  output.redact(config.signerKey)
  if (fromEnv) {
    output.redact(fromEnv)
  }
  output.redact(config.saltSeparator)
  const finalRounds = rounds ?? config.rounds
  const finalMemCost = memCost ?? config.memCost
  if (finalRounds === undefined || finalMemCost === undefined) {
    throw new UsageError(
      'Firebase’s rounds and mem_cost are needed: put them in the hash config file, or pass --firebase-rounds and --firebase-mem-cost.'
    )
  }
  return {
    signerKey: config.signerKey,
    saltSeparator: config.saltSeparator,
    rounds: finalRounds,
    memCost: finalMemCost,
  }
}

/** Refuse an option that belongs to another provider, before any file is read. */
function checkOptions(provider: ImportProvider, flags: CommandContext['flags']): void {
  for (const name of ALL_EXTRA) {
    if (flags[name] !== undefined && !EXTRA_FILES[provider].includes(name)) {
      throw new UsageError(`--${name} is not used with --from ${provider}.`)
    }
  }
  if (provider !== 'firebase') {
    for (const name of ['firebase-hash-config', 'firebase-rounds', 'firebase-mem-cost']) {
      if (flags[name] !== undefined) {
        throw new UsageError(`--${name} is only used with --from firebase.`)
      }
    }
  }
}

/** Load the export files and parse them. No network. */
async function load(
  context: CommandContext,
  provider: ImportProvider,
  file: string
): Promise<{ parsed: ParsedExport; fingerprint: string }> {
  const { flags } = context
  const text = await readInput(context, file, 'the export file')
  const files: Record<string, string> = {}
  for (const name of EXTRA_FILES[provider]) {
    const path = flags[name]
    if (typeof path === 'string') {
      files[name] = await readInput(context, path, `--${name}`)
    }
  }
  const firebase = provider === 'firebase' ? await firebaseParameters(context) : undefined
  const parsed = PARSERS[provider]({
    text,
    files,
    allowPasswordless: flags['allow-passwordless'] === true,
    firebase,
  })
  const fingerprint = fingerprintOf([
    ['export', text],
    ...Object.entries(files).sort(([left], [right]) => left.localeCompare(right)),
    // What changes which rows are sent, or with what: a run with other settings is another
    // import, never a resume (rows past the old run's offset would be skipped unsent). The
    // Firebase parameters are in it only as a hash.
    [
      'options',
      JSON.stringify({
        passwordless: flags['allow-passwordless'] === true,
        firebase:
          firebase === undefined
            ? null
            : createHash('sha256').update(JSON.stringify(firebase)).digest('hex'),
      }),
    ],
  ])
  return { parsed, fingerprint }
}

/** The progress to continue from, or a fresh one; refuses a progress file that is not this run's. */
async function loadProgress(
  context: CommandContext,
  path: string,
  fresh: Progress
): Promise<Progress> {
  const { host } = context.io
  const existing = await host?.readFile(path)
  if (existing === null || existing === undefined || context.flags.fresh === true) {
    return fresh
  }
  const found = readProgress(existing)
  if (found.provider !== fresh.provider || found.fingerprint !== fresh.fingerprint) {
    throw new UsageError(
      'The progress file belongs to a different export. Nothing was sent. Use the matching export, name another file with --progress-file, or pass --fresh to start over (users that exist are skipped).'
    )
  }
  if (found.target !== fresh.target) {
    throw new UsageError(
      'The progress file was made for a different API or secret key. Nothing was sent. Use the same ones, name another file with --progress-file, or pass --fresh to start over (users that exist are skipped).'
    )
  }
  return found
}

/**
 * `tula import`: move users from another provider. It reads the provider's own export on this
 * machine (no request to the old provider), prints a dry-run report, and with `--yes` imports
 * the users through `POST /v1/admin/users/import` in batches, keeping a progress file so that an
 * interrupted run continues where it stopped. A Clerk export's organizations and memberships go
 * through the organization admin routes.
 *
 * @example
 * ```sh
 * tula import --from supabase users.csv          # dry run: a report, nothing sent
 * tula import --from supabase users.csv --yes    # import; run again after an interruption
 * ```
 */
export const importCommand: Command = {
  name: 'import',
  summary: 'Import users from Clerk, Auth0, Firebase, Supabase or better-auth.',
  usage: USAGE,
  description:
    'Reads the provider’s export file on this machine, with no request to the old provider, ' +
    'and prints a report of what would be imported and what is refused (row number, code, and a ' +
    'masked address). With --yes it sends the users in batches of up to 500 to ' +
    'POST /v1/admin/users/import with the secret key from TULA_SECRET_KEY or ' +
    '--secret-key-file, waiting out the rate limit.\n\n' +
    'A progress file (default: <export file>.tula-import-progress.json) holds row numbers, ' +
    'counts, codes and ids, never a password hash or an address; run the same command again ' +
    'after an interruption and it continues. A user whose address exists is skipped, so ' +
    'running it again is safe. The progress file is bound to the export and to the API and ' +
    'key; --fresh ignores it.\n\n' +
    'Providers: clerk (CSV or JSON, with --organizations and --memberships), auth0 (NDJSON or ' +
    'JSON, with --password-hashes), firebase (auth:export JSON, with --firebase-hash-config), ' +
    'supabase (auth.users CSV or JSON) and better-auth (user table, with --accounts). ' +
    'A password hash the server cannot read refuses its row, or with --allow-passwordless ' +
    'imports the user without a password.\n\n' +
    'Firebase’s signer key is never taken on the command line: it is in the hash config file, ' +
    'or in TULA_FIREBASE_SIGNER_KEY (and TULA_FIREBASE_SALT_SEPARATOR).\n\n' +
    'Exit codes: 0 done and nothing refused, 2 something was refused (a report, not a failure), ' +
    '1 an error (the progress file keeps what was done).',
  maxPositionals: 1,
  options: {
    from: {
      type: 'string',
      value: '<provider>',
      description: `The provider: ${IMPORT_PROVIDERS.join(', ')}.`,
    },
    yes: {
      type: 'boolean',
      short: 'y',
      description: 'Import. Without it only the report is printed.',
    },
    'progress-file': {
      type: 'string',
      value: '<path>',
      description: 'Where the progress is kept. Default: <export file>.tula-import-progress.json.',
    },
    fresh: { type: 'boolean', description: 'Ignore an existing progress file and start over.' },
    'allow-passwordless': {
      type: 'boolean',
      description:
        'Import a user whose password hash cannot be carried over without a password, instead of refusing the row.',
    },
    'password-hashes': {
      type: 'string',
      value: '<file>',
      description: 'Auth0: the password hash export from Auth0 support (NDJSON).',
    },
    accounts: {
      type: 'string',
      value: '<file>',
      description: 'better-auth: the account table, which holds the password hashes.',
    },
    organizations: {
      type: 'string',
      value: '<file>',
      description: 'Clerk: the organizations (JSON from the Backend API).',
    },
    memberships: {
      type: 'string',
      value: '<file>',
      description: 'Clerk: the organization memberships (JSON from the Backend API).',
    },
    'firebase-hash-config': {
      type: 'string',
      value: '<file>',
      description:
        'Firebase: the project’s password hash parameters (base64_signer_key, base64_salt_separator, rounds, mem_cost).',
    },
    'firebase-rounds': {
      type: 'string',
      value: '<n>',
      description: 'Firebase: rounds, when the config file lacks it.',
    },
    'firebase-mem-cost': {
      type: 'string',
      value: '<n>',
      description: 'Firebase: mem_cost, when the config file lacks it.',
    },
    'batch-size': {
      type: 'string',
      value: '<n>',
      description: `Users per request, at most ${MAX_IMPORT_ROWS} (the default).`,
    },
    'max-wait': {
      type: 'string',
      value: '<seconds>',
      description: `The longest a Retry-After is waited. Default: ${DEFAULT_MAX_WAIT_SECONDS}.`,
    },
    env: {
      type: 'string',
      short: 'e',
      value: '<name>',
      description: 'Names the TULA_API_URL_<NAME> and TULA_SECRET_KEY_<NAME> variables read.',
    },
    'api-url': {
      type: 'string',
      value: '<url>',
      description: 'The Tula API. Default: TULA_API_URL_<NAME>, then TULA_API_URL.',
    },
    'insecure-http': {
      type: 'boolean',
      description:
        'Allow a plain http API URL that is not localhost: the secret key then crosses the network in clear text.',
    },
    'secret-key-file': {
      type: 'string',
      value: '<path>',
      description: 'Read the secret key from a file (- for standard input, piped).',
    },
    json: { type: 'boolean', description: 'Print the report as JSON.' },
  },
  run: async (context) => {
    const { flags, positionals, io, output } = context
    const provider = flags.from
    if (typeof provider !== 'string' || !IMPORT_PROVIDERS.includes(provider as ImportProvider)) {
      throw new UsageError(
        `--from names the provider: one of ${IMPORT_PROVIDERS.join(', ')}. Usage: ${USAGE}`
      )
    }
    const source = provider as ImportProvider
    const file = positionals[0]
    if (file === undefined) {
      throw new UsageError(`Name the export file. Usage: ${USAGE}`)
    }
    const batchSize = whole(flags, 'batch-size', 1, MAX_IMPORT_ROWS) ?? MAX_IMPORT_ROWS
    const maxWait = whole(flags, 'max-wait', 0, 3600) ?? DEFAULT_MAX_WAIT_SECONDS
    checkOptions(source, flags)
    const { parsed, fingerprint } = await load(context, source, file)
    const summary = summarize(parsed)
    if (flags.yes !== true) {
      if (flags.json) {
        output.line(JSON.stringify(reportToJson(source, parsed, summary), null, 2))
      } else {
        renderDryRun(output, source, parsed, summary)
      }
      return summary.refused.length > 0 ? EXIT.refused : EXIT.ok
    }

    const target = await resolveTarget({
      name: typeof flags.env === 'string' ? flags.env : 'default',
      environment: {},
      flags,
      io,
      output,
    })
    const host = io.host
    if (!host) {
      throw new UsageError('This run cannot write files.')
    }
    const progressPath = resolve(
      io.cwd,
      typeof flags['progress-file'] === 'string'
        ? flags['progress-file']
        : `${file}.tula-import-progress.json`
    )
    const progress = await loadProgress(
      context,
      progressPath,
      newProgress(source, fingerprint, target.fingerprint)
    )
    if (progress.batches > 0 || progress.organizations.cursor > 0) {
      output.error(`Continuing from the progress file (after user row ${progress.doneThrough}).`)
    }
    const run: RunContext = {
      admin: target.admin,
      host,
      output,
      progressPath,
      batchSize,
      maxWaitMs: maxWait * 1000,
    }
    try {
      await importUsers(run, parsed, progress)
      await importOrganizations(run, parsed, progress)
    } catch (error) {
      const code = reportError(output, error)
      output.error(
        `Stopped. The progress file keeps what was done (${progress.counts.created + progress.counts.skipped + progress.counts.refused} users answered); run the same command again to continue.`
      )
      return code
    }
    if (flags.json) {
      output.line(JSON.stringify(reportToJson(source, parsed, summary, progress), null, 2))
      return summary.refused.length + progress.counts.refused > 0 ||
        progress.organizations.failed.length + progress.memberships.failed.length > 0
        ? EXIT.refused
        : EXIT.ok
    }
    return renderResult(output, source, parsed, summary, progress) > 0 ? EXIT.refused : EXIT.ok
  },
}
