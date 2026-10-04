/**
 * A mistake in how the CLI was called: an unknown option, a missing value, a missing setting.
 * Reported as `error: …` with exit code 1.
 *
 * @example
 * ```ts
 * throw new UsageError('Set TULA_API_URL, or pass --api-url.')
 * ```
 */
export class UsageError extends Error {
  /** @param message - What was wrong, and what to do instead. */
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

/**
 * One option of a command.
 *
 * @example
 * ```ts
 * const yes: OptionSpec = { type: 'boolean', short: 'y', description: 'Do not ask.' }
 * ```
 */
export interface OptionSpec {
  /** `boolean` for a flag, `string` for an option that takes a value. */
  type: 'boolean' | 'string'
  /** A one-letter alias, e.g. `y` for `-y`. */
  short?: string
  /** The value's name in the help text, e.g. `<name>`. */
  value?: string
  /** One line for the help text. */
  description: string
}

/**
 * Parsed arguments.
 *
 * @example
 * ```ts
 * const { flags } = parseArgs(['--env', 'prod', '--yes'], options)
 * flags.env // 'prod'
 * ```
 */
export interface ParsedArgs {
  /** Options by name: `true` for a flag that was given, the value for an option. */
  flags: Record<string, string | boolean | undefined>
  /** Everything that is not an option. */
  positionals: string[]
}

// Flags that look like the obvious way to pass a secret, and must not exist: a command line
// ends up in the shell's history, in `ps` output and in CI logs. Each says what to do instead.
const KEY_ADVICE = 'Set TULA_SECRET_KEY, or pass --secret-key-file <path> (- for standard input).'
const SECRET_FLAGS: ReadonlyMap<string, string> = new Map([
  ['secret-key', KEY_ADVICE],
  ['key', KEY_ADVICE],
  ['secret', KEY_ADVICE],
  ['token', KEY_ADVICE],
  [
    'admin-token',
    'Set TULA_ADMIN_TOKEN, or pass --admin-token-file <path> (- for standard input).',
  ],
  [
    'password',
    'Run `tula policy test` and type it at the prompt, or pipe it in: `printf %s "$PW" | tula policy test`.',
  ],
])

/**
 * Parse a command's arguments: `--name`, `--name value`, `--name=value`, `-y`, and `--` to end
 * the options. No abbreviations and no grouped short flags, so what a script passes means one
 * thing.
 *
 * An error names the option and never repeats a value: what follows an option may be a secret
 * passed by mistake.
 *
 * @param argv - The arguments after the command's name.
 * @param options - The options the command takes, by name.
 * @returns The options that were given and the positional arguments.
 * @throws UsageError for an unknown option, a missing value, or a value given to a flag.
 *
 * @example
 * ```ts
 * parseArgs(['--env=prod', '-y'], { env: { type: 'string', description: '' }, yes: { type: 'boolean', short: 'y', description: '' } })
 * // { flags: { env: 'prod', yes: true }, positionals: [] }
 * ```
 */
export function parseArgs(
  argv: readonly string[],
  options: Record<string, OptionSpec>
): ParsedArgs {
  const flags: ParsedArgs['flags'] = {}
  const positionals: string[] = []
  const byShort = new Map(
    Object.entries(options).flatMap(([name, spec]) => (spec.short ? [[spec.short, name]] : []))
  )
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string
    if (argument === '--') {
      positionals.push(...argv.slice(index + 1))
      break
    }
    if (!argument.startsWith('-') || argument === '-') {
      positionals.push(argument)
      continue
    }
    const long = argument.startsWith('--')
    const equals = long ? argument.indexOf('=') : -1
    const given = long ? argument.slice(2, equals === -1 ? undefined : equals) : argument.slice(1)
    const name = long ? given : byShort.get(given)
    const spec = name !== undefined && Object.hasOwn(options, name) ? options[name] : undefined
    if (name === undefined || !spec) {
      const advice = SECRET_FLAGS.get(given)
      if (advice !== undefined) {
        throw new UsageError(
          `There is no --${given} option: a secret on the command line ends up in shell history ` +
            `and process lists. ${advice}`
        )
      }
      // The name only, cut at a sensible length: never what came after an `=`.
      throw new UsageError(`Unknown option ${long ? '--' : '-'}${given.slice(0, 40)}.`)
    }
    if (spec.type === 'boolean') {
      if (equals !== -1) {
        throw new UsageError(`--${name} takes no value.`)
      }
      flags[name] = true
      continue
    }
    const value = equals === -1 ? argv[index + 1] : argument.slice(equals + 1)
    if (value === undefined || (equals === -1 && value.startsWith('--'))) {
      throw new UsageError(`--${name} needs a value.`)
    }
    flags[name] = value
    if (equals === -1) {
      index += 1
    }
  }
  return { flags, positionals }
}
