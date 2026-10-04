import type { Readable, Writable } from 'node:stream'
import { type AdminFetch, isTulaAdminError, type TulaAdminError } from '@tula/admin'
import { isConfigError } from '@tula/config'
import { type OptionSpec, type ParsedArgs, parseArgs, UsageError } from './args'
import type { Host } from './host'
import { createOutput, type Output, type Sink } from './output'
import { VERSION } from './version'

/**
 * A run's exit code: `0` success (and, for `tula diff`, "no changes"), `1` an error, `2` "there
 * are changes to apply" (`tula diff`, so that CI can gate on it) and "the password would be
 * refused" (`tula policy test`): an answer, not a failure of the command.
 *
 * @example
 * ```ts
 * process.exit(plan.changes ? EXIT.changes : EXIT.ok)
 * ```
 */
export const EXIT = { ok: 0, error: 1, changes: 2, refused: 2 } as const

/**
 * Everything a run touches outside itself. `main` fills it from the process; a test passes its
 * own, which is how the real CLI entry runs in process against an API mounted in memory.
 *
 * @example
 * ```ts
 * const io: CliIo = { stdout, stderr, env: { TULA_API_URL, TULA_SECRET_KEY }, cwd, isTTY: false, fetch }
 * const code = await runCli(['diff', '--env', 'dev'], io)
 * ```
 */
export interface CliIo {
  /** Results. */
  stdout: Sink
  /** Errors and prompts. */
  stderr: Sink
  /** The environment: where the API URL, the secret key and provider secrets are read from. */
  env: Readonly<Record<string, string | undefined>>
  /** The directory a relative `--config` is resolved against. */
  cwd: string
  /**
   * Whether a person can be asked a question: standard input and standard error are both a
   * terminal (the question is written to standard error, so standard output may be a file).
   */
  isTTY: boolean
  /**
   * Whether standard input is a terminal. A secret key is never read from one
   * (`--secret-key-file -`): it would be shown as it is typed.
   */
  stdinIsTTY?: boolean
  /** The `fetch` the admin client uses. Defaults to the platform's. */
  fetch?: AdminFetch
  /** Ask a question and read one line. Required only where a command prompts on a terminal. */
  prompt?: (question: string) => Promise<string>
  /** Read all of standard input (`--secret-key-file -`). */
  readStdin?: () => Promise<string>
  /** Read a file as text (`--secret-key-file <path>`). */
  readFile?: (path: string) => Promise<string>
  /**
   * Ask for a secret on the terminal without showing what is typed (`tula policy test`).
   * Present only where standard input is a terminal.
   */
  promptSecret?: (question: string) => Promise<string>
  /** This machine's clock (`tula doctor` compares it with the server's). Defaults to the system's. */
  now?: () => Date
  /** How `tula dev` runs `docker compose` and touches the project's files. */
  host?: Host
  /**
   * The process's own standard input and output as streams, and its stop signals, for a
   * command that serves a protocol on them (`tula mcp`). While it does, nothing else may be
   * written to standard output: every other line goes to `stderr`.
   */
  serve?: {
    /** Standard input. */
    input: Readable
    /** Standard output. */
    output: Writable
    /** Call `stop` on SIGTERM or SIGINT. Returns how to stop listening. */
    onTerminate?: (stop: () => void) => () => void
  }
}

/**
 * What a command's `run` receives.
 *
 * @example
 * ```ts
 * async function run({ output, flags }: CommandContext): Promise<number> {
 *   output.line(`env: ${String(flags.env)}`)
 *   return EXIT.ok
 * }
 * ```
 */
export interface CommandContext extends ParsedArgs {
  /** The run's surroundings. */
  io: CliIo
  /** Where to write. */
  output: Output
}

/**
 * One command of the CLI. A new command (`tula dev`, `tula doctor`, …) is an object of this
 * shape added to the list `runCli` is given; nothing else changes.
 *
 * @example
 * ```ts
 * const hello: Command = {
 *   name: 'hello',
 *   summary: 'Say hello.',
 *   usage: 'tula hello [--name <name>]',
 *   options: { name: { type: 'string', value: '<name>', description: 'Who to greet.' } },
 *   run: async ({ output, flags }) => {
 *     output.line(`Hello, ${String(flags.name ?? 'world')}.`)
 *     return EXIT.ok
 *   },
 * }
 * ```
 */
export interface Command {
  /** The word after `tula`. */
  name: string
  /** One line for `tula --help`. */
  summary: string
  /** The usage line for `tula <name> --help`. */
  usage: string
  /** More help: what the command does, its exit codes. */
  description?: string
  /**
   * How many arguments that are not options the command takes (default: none), e.g. the `test`
   * of `tula policy test`. The command checks what they are.
   */
  maxPositionals?: number
  /** The options it takes, by name. `--help` is added to every command. */
  options: Record<string, OptionSpec>
  /** Run the command and answer its exit code. */
  run(context: CommandContext): Promise<number>
}

function optionLines(options: Record<string, OptionSpec>): string[] {
  const all: Record<string, OptionSpec> = {
    ...options,
    help: { type: 'boolean', short: 'h', description: 'Show this help.' },
  }
  const rows = Object.entries(all).map(([name, spec]): [string, string] => [
    `${spec.short ? `-${spec.short}, ` : '    '}--${name}${spec.value ? ` ${spec.value}` : ''}`,
    spec.description,
  ])
  const width = Math.max(...rows.map(([left]) => left.length))
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`)
}

function commandHelp(command: Command): string[] {
  return [
    `Usage: ${command.usage}`,
    '',
    command.description ?? command.summary,
    '',
    'Options:',
    ...optionLines(command.options),
  ]
}

function generalHelp(commands: readonly Command[]): string[] {
  const width = Math.max(...commands.map((command) => command.name.length))
  return [
    'Usage: tula <command> [options]',
    '',
    'Commands:',
    ...commands.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`),
    '',
    'Run `tula <command> --help` for a command’s options.',
  ]
}

/** Print an API error: its message and code, then each field with its path. */
function reportAdminError(output: Output, error: TulaAdminError): void {
  const { errorStyle } = output
  const where = error.status > 0 ? ` (${error.code}, HTTP ${error.status})` : ` (${error.code})`
  output.error(`${errorStyle.red('error:')} ${error.message}${where}`)
  for (const problem of error.errors) {
    output.error(`  ${problem.field}: ${problem.message}`)
  }
  if (error.retryAfterMs !== undefined) {
    output.error(`  Try again in ${Math.ceil(error.retryAfterMs / 1000)}s.`)
  }
}

/**
 * Report a failure the way every command does, and answer the exit code for it.
 *
 * @param output - Where to write.
 * @param error - What was thrown.
 * @returns `EXIT.error`.
 *
 * @example
 * ```ts
 * try {
 *   await work()
 * } catch (error) {
 *   return reportError(output, error)
 * }
 * ```
 */
export function reportError(output: Output, error: unknown): number {
  const { errorStyle } = output
  if (isTulaAdminError(error)) {
    reportAdminError(output, error)
  } else if (isConfigError(error) || error instanceof UsageError) {
    output.error(`${errorStyle.red('error:')} ${error.message}`)
  } else {
    // Something this CLI did not foresee. The name and message, through the redacting writer.
    const text = error instanceof Error ? `${error.name}: ${error.message}` : 'an unknown error'
    output.error(`${errorStyle.red('error:')} unexpected failure (${text})`)
  }
  return EXIT.error
}

/**
 * Run the CLI: pick the command, parse its options, run it, and turn whatever it throws into a
 * message and an exit code. It never throws and never exits the process itself.
 *
 * @param argv - The arguments after `tula`.
 * @param io - The run's surroundings.
 * @param commands - The commands the CLI has.
 * @returns The exit code.
 *
 * @example
 * ```ts
 * const code = await runCli(['diff', '--env', 'prod'], io, COMMANDS)
 * ```
 */
export async function runCli(
  argv: readonly string[],
  io: CliIo,
  commands: readonly Command[]
): Promise<number> {
  const output = createOutput(io.stdout, io.stderr, io.env)
  const [name, ...rest] = argv
  if (name === undefined || name === '--help' || name === '-h' || name === 'help') {
    for (const line of generalHelp(commands)) {
      output.line(line)
    }
    return name === undefined ? EXIT.error : EXIT.ok
  }
  if (name === '--version' || name === '-v') {
    output.line(VERSION)
    return EXIT.ok
  }
  const command = commands.find((candidate) => candidate.name === name)
  if (!command) {
    // An option before the command may be a secret passed by mistake: do not repeat it.
    const shown = name.startsWith('-') ? 'an option' : `"${name.slice(0, 40)}"`
    output.error(`${output.errorStyle.red('error:')} ${shown} is not a tula command.`)
    for (const line of generalHelp(commands)) {
      output.error(line)
    }
    return EXIT.error
  }
  try {
    const parsed = parseArgs(rest, {
      ...command.options,
      help: { type: 'boolean', short: 'h', description: 'Show this help.' },
    })
    if (parsed.flags.help) {
      for (const line of commandHelp(command)) {
        output.line(line)
      }
      return EXIT.ok
    }
    const allowed = command.maxPositionals ?? 0
    if (parsed.positionals.length > allowed) {
      // Never repeated: an argument that should not be there may be a secret.
      throw new UsageError(
        allowed === 0
          ? `tula ${command.name} takes no arguments, only options.`
          : `tula ${command.name} takes at most ${allowed} argument${allowed === 1 ? '' : 's'}. Usage: ${command.usage}`
      )
    }
    return await command.run({ ...parsed, io, output })
  } catch (error) {
    return reportError(output, error)
  }
}
