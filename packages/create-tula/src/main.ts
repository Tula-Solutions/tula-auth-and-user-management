import { createInterface } from 'node:readline/promises'
import {
  DEFAULT_API_IMAGE,
  FRAMEWORKS,
  type Framework,
  ScaffoldError,
  scaffold,
  VERSION,
  validateProjectName,
} from './scaffold'

/**
 * Everything a run touches outside itself. `main` fills it from the process; a test passes its
 * own.
 *
 * @example
 * ```ts
 * const io: CreateIo = { stdout, stderr, cwd: process.cwd(), isTTY: false }
 * ```
 */
export interface CreateIo {
  /** Results. */
  stdout: { write(text: string): unknown }
  /** Errors and questions. */
  stderr: { write(text: string): unknown }
  /** The directory the project is created in. */
  cwd: string
  /** Whether a person can be asked a question. */
  isTTY: boolean
  /** Ask a question and read one line. */
  prompt?: (question: string) => Promise<string>
}

const HELP = `Usage: create-tula [name] [options]

Scaffolds a Tula Auth project in ./<name>: a Compose file, a .env with generated secrets,
tula.config.ts and an example app. On a terminal it asks for what is left out.

Options:
      --framework <name>      The example app: ${FRAMEWORKS.join(', ')}.
                              react-vite and nextjs are web apps; expo, swiftui and compose
                              are native ones, in a directory of their own in the project.
                              expo needs --tula-packages: Tula's Expo SDK is not released
                              to npm yet.
      --tula-repo <dir>       A checkout of the Tula repository. Needed for swiftui and
                              compose, and only for them: the Swift package and the Kotlin
                              SDK are not published, so the project names them by a path
                              into the checkout.
      --api-image <ref>       The Tula API image. Default: ${DEFAULT_API_IMAGE} (build it from the
                              Tula repository: no image is published yet).
      --api-port <port>       The port the API is published on. Default: 3003.
      --mailpit-port <port>   The port Mailpit's inbox is published on. Default: 8025.
      --tula-packages <dir>   Install the @tula/* packages from tarballs in this directory
                              instead of npm (in a checkout of the Tula repository,
                              \`bun run packages:check\` writes them to .release/).
      --force                 Write into a directory that is not empty (.env is always kept).
  -h, --help                  Show this help.
  -v, --version               Show the version.
`

const VALUE_OPTIONS = [
  'framework',
  'api-image',
  'api-port',
  'mailpit-port',
  'tula-packages',
  'tula-repo',
]

class UsageError extends Error {}

function parse(argv: readonly string[]) {
  const flags: Record<string, string | boolean> = {}
  const positionals: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string
    if (!argument.startsWith('-')) {
      positionals.push(argument)
      continue
    }
    const equals = argument.indexOf('=')
    const name = argument.slice(
      argument.startsWith('--') ? 2 : 1,
      equals === -1 ? undefined : equals
    )
    const long = { h: 'help', v: 'version' }[name] ?? name
    if (long === 'help' || long === 'version' || long === 'force') {
      flags[long] = true
    } else if (VALUE_OPTIONS.includes(long)) {
      const value = equals === -1 ? argv[index + 1] : argument.slice(equals + 1)
      if (value === undefined || (equals === -1 && value.startsWith('-'))) {
        throw new UsageError(`--${long} needs a value.`)
      }
      flags[long] = value
      index += equals === -1 ? 1 : 0
    } else {
      throw new UsageError(`Unknown option ${argument.slice(0, 40).split('=')[0]}.`)
    }
  }
  return { flags, positionals }
}

function portOption(flags: Record<string, string | boolean>, name: string): number | undefined {
  const value = flags[name]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string' || !/^\d{1,5}$/.test(value)) {
    throw new UsageError(`--${name} must be a port number from 1 to 65535.`)
  }
  return Number(value)
}

async function chooseFramework(
  io: CreateIo,
  given: string | boolean | undefined
): Promise<Framework> {
  if (typeof given === 'string') {
    if (!(FRAMEWORKS as readonly string[]).includes(given)) {
      throw new UsageError(`--framework is one of: ${FRAMEWORKS.join(', ')}.`)
    }
    return given as Framework
  }
  if (!io.isTTY || !io.prompt) {
    throw new UsageError(`Pass --framework: one of ${FRAMEWORKS.join(', ')}.`)
  }
  const list = FRAMEWORKS.map((name, index) => `${index + 1}) ${name}`).join('  ')
  const answer = (await io.prompt(`Framework (${list}) [1]: `)).trim()
  const chosen = answer === '' ? FRAMEWORKS[0] : (FRAMEWORKS[Number(answer) - 1] ?? answer)
  if (!(FRAMEWORKS as readonly string[]).includes(chosen)) {
    throw new UsageError(`The framework is one of: ${FRAMEWORKS.join(', ')}.`)
  }
  return chosen as Framework
}

/**
 * Run `create-tula`: read the name and the options (asking on a terminal for what is missing),
 * scaffold the project and say what to do next. It never throws, never exits the process and
 * never prints a generated secret.
 *
 * @param argv - The arguments after `create-tula`.
 * @param io - The run's surroundings.
 * @returns The exit code: `0` scaffolded, `1` an error.
 *
 * @example
 * ```ts
 * process.exit(await main(process.argv.slice(2), processIo()))
 * ```
 */
export async function main(argv: readonly string[], io: CreateIo): Promise<number> {
  try {
    const { flags, positionals } = parse(argv)
    if (flags.help) {
      io.stdout.write(HELP)
      return 0
    }
    if (flags.version) {
      io.stdout.write(`${VERSION}\n`)
      return 0
    }
    if (positionals.length > 1) {
      throw new UsageError('create-tula takes one name.')
    }
    let name = positionals[0]
    if (name === undefined) {
      if (!io.isTTY || !io.prompt) {
        throw new UsageError('Pass the project’s name: create-tula <name> --framework <framework>.')
      }
      name = (await io.prompt('Project name: ')).trim()
    }
    const problem = validateProjectName(name)
    if (problem !== null) {
      throw new UsageError(`That project name cannot be used. ${problem}`)
    }
    const framework = await chooseFramework(io, flags.framework)
    const result = await scaffold({
      cwd: io.cwd,
      name,
      framework,
      apiImage: typeof flags['api-image'] === 'string' ? flags['api-image'] : undefined,
      apiPort: portOption(flags, 'api-port'),
      mailpitPort: portOption(flags, 'mailpit-port'),
      tulaPackages: typeof flags['tula-packages'] === 'string' ? flags['tula-packages'] : undefined,
      tulaRepo: typeof flags['tula-repo'] === 'string' ? flags['tula-repo'] : undefined,
      force: flags.force === true,
    })
    io.stdout.write(
      [
        `Created ${name} (${framework}): ${result.files.length} files in ${result.directory}`,
        result.keptEnv
          ? 'The existing .env was kept: its secrets are unchanged.'
          : 'Secrets were generated into .env (readable by you only, ignored by git). Back up TULA_MASTER_KEY.',
        '',
        'Next:',
        `  cd ${name}`,
        '  bun install',
        '  bunx tula dev      # starts the stack, migrates, seeds, mints development keys',
        ...result.start.map(([command, what]) => `  ${command.padEnd(18)} # ${what}`),
        '',
        ...(result.appUrl === null
          ? [
              'The README says what a simulator, a phone and each sign-in method need, and which of',
              'those need an Apple, Google or Tailscale account of your own.',
            ]
          : []),
        'The API image is not published yet: see "The API image" in the README.',
        '',
      ].join('\n')
    )
    return 0
  } catch (error) {
    if (error instanceof UsageError || error instanceof ScaffoldError) {
      io.stderr.write(`error: ${error.message}\n`)
    } else {
      io.stderr.write(
        `error: unexpected failure (${error instanceof Error ? `${error.name}: ${error.message}` : 'unknown'})\n`
      )
    }
    return 1
  }
}

/**
 * The surroundings of a real run: the process's streams and directory, and a prompt on the
 * terminal.
 *
 * @param source - The streams and the directory. Defaults to the process's own.
 * @returns The io `main` runs with.
 *
 * @example
 * ```ts
 * process.exit(await main(process.argv.slice(2), processIo()))
 * ```
 */
export function processIo(
  source: {
    stdin: NodeJS.ReadableStream & { isTTY?: boolean }
    stdout: NodeJS.WritableStream
    stderr: NodeJS.WritableStream & { isTTY?: boolean }
    cwd(): string
  } = process
): CreateIo {
  return {
    stdout: source.stdout,
    stderr: source.stderr,
    cwd: source.cwd(),
    // The question is written to standard error, so that is the stream a person must be watching.
    isTTY: source.stdin.isTTY === true && source.stderr.isTTY === true,
    prompt: async (question) => {
      const reader = createInterface({ input: source.stdin, output: source.stderr })
      try {
        return await reader.question(question)
      } finally {
        reader.close()
      }
    },
  }
}
