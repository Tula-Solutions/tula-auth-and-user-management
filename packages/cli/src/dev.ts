import { createAdminClient, isTulaAdminError } from '@tula/admin'
import { UsageError } from './args'
import type { CliIo } from './framework'
import type { Host, RunResult } from './host'
import type { Output } from './output'
import { VERSION } from './version'

/** The file `tula dev` writes the keys to: read by Bun, Vite and Next.js, and ignored by git. */
export const DEV_ENV_FILE = '.env.local'

const BLOCK_START = '# tula:dev:start'
const BLOCK_END = '# tula:dev:end'
const BLOCK_NOTE =
  '# Written by `tula dev`: the local stack’s URL and keys. Lines outside this block are yours.'

/** The port the API listens on inside its container (the image's default `PORT`). */
const API_CONTAINER_PORT = '3003'
const MAILPIT_UI_PORT = '8025'

/** Short commands: a version, a port, a config listing. */
const QUICK_MS = 30_000

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const KEY = {
  publishable: /^tula_pk_[a-z]+_[A-Za-z0-9_-]{16,}$/,
  secret: /^tula_sk_[a-z]+_[A-Za-z0-9_-]{16,}$/,
}

/**
 * The variables in the block `tula dev` manages, or `null` when the file has no block.
 *
 * @param text - The file's contents.
 * @returns The block's variables.
 *
 * @example
 * ```ts
 * parseDevBlock(await Bun.file('.env.local').text())?.TULA_API_URL
 * ```
 */
export function parseDevBlock(text: string): Record<string, string> | null {
  const start = text.indexOf(BLOCK_START)
  const end = text.indexOf(BLOCK_END)
  if (start === -1 || end < start) {
    return null
  }
  const vars: Record<string, string> = {}
  for (const line of text.slice(start, end).split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim())
    if (match) {
      vars[match[1] as string] = match[2] as string
    }
  }
  return vars
}

/**
 * A file's contents without the block `tula dev` manages. Every other line is kept as it is.
 *
 * @param text - The file's contents.
 * @returns The contents without the block.
 *
 * @example
 * ```ts
 * withoutDevBlock('A=1\n# tula:dev:start\nB=2\n# tula:dev:end\n') // 'A=1\n'
 * ```
 */
export function withoutDevBlock(text: string): string {
  const start = text.indexOf(BLOCK_START)
  const end = text.indexOf(BLOCK_END)
  if (start === -1 || end < start) {
    return text
  }
  const after = text.slice(end + BLOCK_END.length).replace(/^\n/, '')
  return `${text.slice(0, start)}${after}`
}

/**
 * A file's contents with the block `tula dev` manages set to `vars`: replaced where it is, or
 * added at the end. Lines outside the block are never changed.
 *
 * @param text - The file's contents (`''` for a new file).
 * @param vars - The block's variables.
 * @returns The new contents.
 *
 * @example
 * ```ts
 * withDevBlock('MINE=1\n', { TULA_API_URL: 'http://localhost:3003' })
 * ```
 */
export function withDevBlock(text: string, vars: Readonly<Record<string, string>>): string {
  const block = [
    BLOCK_START,
    BLOCK_NOTE,
    ...Object.entries(vars).map(([name, value]) => `${name}=${value}`),
    BLOCK_END,
  ].join('\n')
  const start = text.indexOf(BLOCK_START)
  const end = text.indexOf(BLOCK_END)
  if (start !== -1 && end > start) {
    return `${text.slice(0, start)}${block}${text.slice(end + BLOCK_END.length)}`
  }
  const separator = text === '' || text.endsWith('\n') ? '' : '\n'
  return `${text}${separator}${block}\n`
}

/** A value the user set themselves: a `NAME=value` line outside the managed block. */
function userValue(text: string, name: string): string | undefined {
  for (const line of withoutDevBlock(text).split('\n')) {
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim())
    if (match && match[1] === name && (match[2] as string).trim() !== '') {
      return (match[2] as string).trim().replace(/^(['"])(.*)\1$/, '$2')
    }
  }
  return undefined
}

/**
 * What `tula dev` needs from its command: where it runs and how.
 *
 * @example
 * ```ts
 * await startDev({ io, output, host, projectName: 'shop', timeoutMs: 900_000, showKeys: false, rotateKeys: false })
 * ```
 */
export interface DevOptions {
  /** The run's surroundings. */
  io: CliIo
  /** Where to write. */
  output: Output
  /** How Docker is run and files are touched. */
  host: Host
  /** The Compose project name (`-p`); Compose's own default when left out. */
  projectName?: string
  /** How long a long step (pulling, building, migrating, becoming ready) may take. */
  timeoutMs: number
  /** Print the secret key. */
  showKeys: boolean
  /** Mint new keys even when the file has some. */
  rotateKeys: boolean
}

function compose(options: Pick<DevOptions, 'projectName'>, ...args: string[]): string[] {
  return ['docker', 'compose', ...(options.projectName ? ['-p', options.projectName] : []), ...args]
}

/** The last lines of what a command said, with control characters removed. */
function tail(result: RunResult, lines = 12): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
  const clean = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
  return clean(result.stderr || result.stdout)
    .trim()
    .split('\n')
    .slice(-lines)
    .map((line) => `    ${line}`)
    .join('\n')
}

/**
 * Run one step; a failure becomes a `UsageError` that says which step, why, and what Docker
 * said last. `quiet` steps print what they return (a key): their output is never shown.
 */
async function step(
  options: Pick<DevOptions, 'host' | 'io'>,
  what: string,
  command: string[],
  run: { timeoutMs: number; quiet?: boolean }
): Promise<RunResult> {
  let result: RunResult
  try {
    result = await options.host.run(command, { cwd: options.io.cwd, timeoutMs: run.timeoutMs })
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') {
      throw new UsageError(
        'Docker was not found. `tula dev` runs the local stack with Docker Compose: install Docker (https://docs.docker.com/get-docker/) and run it again.'
      )
    }
    if ((error as { code?: unknown }).code === 'ABORT') {
      throw new UsageError(
        'Interrupted. The stack may be partly started: `tula dev` continues it, `tula dev down` stops it.'
      )
    }
    throw error
  }
  if (result.timedOut) {
    throw new UsageError(
      `${what} timed out after ${Math.round(run.timeoutMs / 1000)}s. Run it again (pulled images are kept), or raise --timeout.`
    )
  }
  if (result.code !== 0) {
    const said = `${result.stderr}\n${result.stdout}`
    if (
      /cannot connect to the docker daemon|docker daemon is not running|error during connect/i.test(
        said
      )
    ) {
      throw new UsageError(
        'Docker is not running. Start Docker Desktop (or the Docker daemon) and run `tula dev` again.'
      )
    }
    if (
      /no configuration file provided|no such file or directory.*compose|can't find a suitable configuration file/i.test(
        said
      )
    ) {
      throw new UsageError(
        'There is no Compose file here. Run `tula dev` in a project made by `create-tula` (or in a directory with a compose.yaml that has `api` and `migrate` services).'
      )
    }
    throw new UsageError(
      run.quiet
        ? `${what} failed (exit ${String(result.code)}).`
        : `${what} failed (exit ${String(result.code)}):\n${tail(result)}`
    )
  }
  return result
}

async function publishedUrl(
  options: Pick<DevOptions, 'host' | 'io' | 'projectName'>,
  service: string,
  port: string
): Promise<string | null> {
  const result = await options.host
    .run(compose(options, 'port', service, port), { cwd: options.io.cwd, timeoutMs: QUICK_MS })
    .catch(() => null)
  const match = /:(\d{1,5})\s*$/.exec(result?.code === 0 ? result.stdout.trim() : '')
  return match ? `http://localhost:${match[1]}` : null
}

async function waitUntilReady(options: DevOptions, apiUrl: string): Promise<void> {
  const send = options.io.fetch ?? ((url, init) => fetch(url, init))
  const attempts = Math.max(1, Math.ceil(options.timeoutMs / 1000))
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const ready = await send(`${apiUrl}/v1/ready`, { signal: AbortSignal.timeout(5_000) }).then(
      (response) => response.status === 200,
      () => false
    )
    if (ready) {
      return
    }
    await options.host.sleep(1_000)
  }
  throw new UsageError(
    `The API did not become ready at ${apiUrl}. Look at what it says: \`${compose(options, 'logs', 'api').join(' ')}\`, then \`tula doctor\`.`
  )
}

async function mint(
  options: DevOptions,
  environmentId: string,
  kind: 'publishable' | 'secret'
): Promise<string> {
  const result = await step(
    options,
    `Minting the ${kind} key`,
    compose(
      options,
      'exec',
      '-T',
      'api',
      'bun',
      'run',
      'src/scripts/create-api-key.ts',
      '--environment',
      environmentId,
      '--kind',
      kind,
      '--name',
      'tula dev'
    ),
    { timeoutMs: 60_000, quiet: true }
  )
  const key = result.stdout.trim().split('\n').at(-1)?.trim() ?? ''
  if (!KEY[kind].test(key)) {
    // What came back is not shown: it is where a key would have been.
    throw new UsageError(`Minting the ${kind} key did not answer with a key.`)
  }
  if (kind === 'secret' && !options.showKeys) {
    options.output.redact(key)
  }
  return key
}

/** Whether the stack accepts a secret key: `false` only for `auth.invalid_key`. */
async function accepts(options: DevOptions, apiUrl: string, secretKey: string): Promise<boolean> {
  try {
    const admin = createAdminClient({
      baseUrl: apiUrl,
      secretKey,
      fetch: options.io.fetch,
      userAgent: `tula-cli/${VERSION}`,
    })
    await admin.call('getEnvironmentSettings')
    return true
  } catch (error) {
    if (
      isTulaAdminError(error) &&
      (error.code === 'auth.invalid_key' || error.code === 'client.invalid_key')
    ) {
      return false
    }
    throw error
  }
}

/**
 * `tula dev`: bring the project's local stack up and leave it ready to use.
 *
 * Starts the Compose services, runs the migrations and the seed through the commands the API
 * image ships (the one place the CLI reaches the database, and only through them), waits for
 * the API, mints a publishable and a secret development key unless `.env.local` already holds
 * keys the stack accepts, writes them to its own block of `.env.local` (owner-readable only;
 * lines outside the block are never changed, and a `TULA_SECRET_KEY` of the user's own is
 * used as it is) and prints the URLs. Running it again changes nothing.
 *
 * @param options - Where and how to run.
 * @throws UsageError with the step that failed and what to do.
 *
 * @example
 * ```ts
 * await startDev({ io, output, host, timeoutMs: 900_000, showKeys: false, rotateKeys: false })
 * ```
 */
export async function startDev(options: DevOptions): Promise<void> {
  const { io, output, host } = options
  const say = (text: string) => output.line(`${output.style.dim('›')} ${text}`)

  await step(options, 'Checking Docker Compose', ['docker', 'compose', 'version'], {
    timeoutMs: QUICK_MS,
  })
  const services = (
    await step(options, 'Reading the Compose file', compose(options, 'config', '--services'), {
      timeoutMs: QUICK_MS,
    })
  ).stdout
    .split('\n')
    .map((line) => line.trim())
  for (const service of ['api', 'migrate']) {
    if (!services.includes(service)) {
      throw new UsageError(
        `The Compose file here has no \`${service}\` service. \`tula dev\` runs a project made by \`create-tula\`: a Compose file with \`api\` and \`migrate\` services built from the Tula API image.`
      )
    }
  }

  say('Starting the database and running migrations (the first run pulls images)…')
  await step(options, 'Running the migrations', compose(options, 'run', '--rm', 'migrate'), {
    timeoutMs: options.timeoutMs,
  })

  say('Seeding the default project and its environments…')
  const seed = await step(
    options,
    'Seeding',
    compose(
      options,
      'run',
      '--rm',
      '--no-deps',
      'api',
      'bun',
      'run',
      '../../packages/db/src/scripts/seed.ts'
    ),
    { timeoutMs: options.timeoutMs }
  )
  const environmentId = UUID.exec(
    /development environment\s+(\S+)/.exec(seed.stdout)?.[1] ?? ''
  )?.[0]
  if (!environmentId) {
    throw new UsageError('The seed did not report a development environment.')
  }

  say('Starting the API…')
  await step(options, 'Starting the API', compose(options, 'up', '-d', 'api'), {
    timeoutMs: options.timeoutMs,
  })
  const apiUrl = await publishedUrl(options, 'api', API_CONTAINER_PORT)
  if (!apiUrl) {
    throw new UsageError(
      'The `api` service does not publish its port 3003, so its URL is unknown. Publish it in the Compose file (e.g. `127.0.0.1:3003:3003`).'
    )
  }
  await waitUntilReady(options, apiUrl)

  const path = `${io.cwd.replace(/\/+$/, '')}/${DEV_ENV_FILE}`
  const existing = (await host.readFile(path)) ?? ''
  const block = parseDevBlock(existing) ?? {}
  const own = {
    secret: userValue(existing, 'TULA_SECRET_KEY'),
    publishable: userValue(existing, 'TULA_PUBLISHABLE_KEY'),
  }
  // The user's own key is never shown. The one `tula dev` wrote is, when it was asked for.
  for (const value of [own.secret, options.showKeys ? undefined : block.TULA_SECRET_KEY]) {
    if (value) {
      output.redact(value)
    }
  }

  let secretKey = options.rotateKeys ? undefined : block.TULA_SECRET_KEY
  let publishableKey = options.rotateKeys ? undefined : block.TULA_PUBLISHABLE_KEY
  let minted = false
  if (own.secret) {
    // The user's own line wins and is never rewritten; whether it works is theirs to see.
    if (!(await accepts(options, apiUrl, own.secret))) {
      output.error(
        `${output.errorStyle.yellow('warning:')} the TULA_SECRET_KEY you set in ${DEV_ENV_FILE} is not accepted by this stack. \`tula dev\` does not change your lines: remove that line to have a key minted.`
      )
    }
    secretKey = undefined
  } else if (secretKey && publishableKey) {
    if (!(await accepts(options, apiUrl, secretKey))) {
      throw new UsageError(
        `The keys in ${DEV_ENV_FILE} are not accepted by this stack (was its database wiped?). Nothing was changed. Run \`tula dev --rotate-keys\` to mint new ones.`
      )
    }
  } else {
    say('Minting development keys…')
    publishableKey = await mint(options, environmentId, 'publishable')
    secretKey = await mint(options, environmentId, 'secret')
    minted = true
  }
  if (!publishableKey && !own.publishable) {
    publishableKey = await mint(options, environmentId, 'publishable')
    minted = true
  }

  const vars: Record<string, string> = { TULA_API_URL: apiUrl, TULA_ENVIRONMENT_ID: environmentId }
  if (publishableKey) {
    vars.TULA_PUBLISHABLE_KEY = publishableKey
  }
  if (secretKey) {
    vars.TULA_SECRET_KEY = secretKey
  }
  vars.VITE_TULA_API_URL = apiUrl
  const shownKey = publishableKey ?? own.publishable
  if (shownKey) {
    vars.VITE_TULA_PUBLISHABLE_KEY = shownKey
    vars.NEXT_PUBLIC_TULA_PUBLISHABLE_KEY = shownKey
  }
  const next = withDevBlock(existing, vars)
  if (next !== existing) {
    await host.writeSecretFile(path, next)
  }

  const ignored = await host
    .run(['git', 'check-ignore', '-q', DEV_ENV_FILE], { cwd: io.cwd, timeoutMs: QUICK_MS })
    .then(
      (result) => result.code,
      () => null
    )
  if (ignored === 1) {
    output.error(
      `${output.errorStyle.yellow('warning:')} ${DEV_ENV_FILE} holds a secret key and is not ignored by git. Add it to .gitignore before you commit.`
    )
  }

  const mailUrl = await publishedUrl(options, 'mailpit', MAILPIT_UI_PORT)
  const { style } = output
  output.line()
  output.line(style.bold('Tula is running.'))
  output.line(`  API              ${apiUrl}`)
  output.line(`  API reference    ${apiUrl}/v1/docs`)
  if (mailUrl) {
    output.line(`  Mail (Mailpit)   ${mailUrl}`)
  }
  output.line(`  Environment      ${environmentId} (development)`)
  if (shownKey) {
    output.line(`  Publishable key  ${shownKey}`)
  }
  output.line(
    secretKey && options.showKeys
      ? `  Secret key       ${secretKey}`
      : `  Secret key       in ${DEV_ENV_FILE}${own.secret ? ' (your own line)' : ''}; --show-keys prints it`
  )
  output.line()
  output.line(
    minted
      ? `Keys were minted and written to ${DEV_ENV_FILE} (readable by you only).`
      : `Keys in ${DEV_ENV_FILE} were reused: nothing was minted.`
  )
  output.line(
    'Next: `tula doctor` checks the stack, `tula apply` applies tula.config.ts, `tula dev down` stops it.'
  )
}

/**
 * `tula dev down`: stop the project's stack. With `volumes` the database is deleted too, and
 * the keys `tula dev` wrote (which that database no longer knows) are removed from
 * `.env.local`; every other line of the file stays.
 *
 * @param options - Where and how to run, and whether to delete the data.
 * @throws UsageError when Docker fails.
 *
 * @example
 * ```ts
 * await stopDev({ io, output, host, projectName: 'shop', volumes: false })
 * ```
 */
export async function stopDev(
  options: Pick<DevOptions, 'io' | 'output' | 'host' | 'projectName'> & { volumes: boolean }
): Promise<void> {
  const { io, output, host } = options
  await step(
    options,
    'Stopping the stack',
    compose(options, 'down', ...(options.volumes ? ['--volumes'] : [])),
    { timeoutMs: 300_000 }
  )
  if (options.volumes) {
    const path = `${io.cwd.replace(/\/+$/, '')}/${DEV_ENV_FILE}`
    const existing = await host.readFile(path)
    if (existing !== null && parseDevBlock(existing) !== null) {
      await host.writeSecretFile(path, withoutDevBlock(existing))
    }
    output.line(
      `Stopped, and the data is deleted. The keys \`tula dev\` wrote were removed from ${DEV_ENV_FILE}.`
    )
  } else {
    output.line('Stopped. The data is kept: `tula dev` starts it again.')
  }
}
