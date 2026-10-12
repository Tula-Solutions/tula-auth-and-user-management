import { createAdminClient, isTulaAdminError } from '@tula/admin'
import { environmentIssuer } from '@tula/contract/issuer'
import { UsageError } from './args'
import type { CliIo } from './framework'
import type { Host, RunResult } from './host'
import type { Output } from './output'
import {
  closeTunnel,
  judgeTunnel,
  openTunnel,
  portInUse,
  type TunnelContext,
  type TunnelRoute,
  type TunnelService,
  type TunnelStatus,
  tailscaleFunnel,
  tunnelStatus,
} from './tunnel'
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

/**
 * The variable the project's Compose file takes the API's `PUBLIC_URL` from when it is set.
 * `tula dev --tunnel` sets it for the one `docker compose up` that starts the API, and
 * writes it to its block of `.env.local`.
 *
 * @example
 * ```yaml
 * PUBLIC_URL: ${TULA_PUBLIC_URL:-http://localhost:${API_PORT:-3003}}
 * ```
 */
export const PUBLIC_URL_VARIABLE = 'TULA_PUBLIC_URL'

/** The block's variables that exist only while a tunnel is open. */
const TUNNEL_VARIABLES: readonly string[] = [
  PUBLIC_URL_VARIABLE,
  'TULA_ISSUER',
  'TULA_TUNNEL_TARGET',
]

/** What the Compose file is asked to resolve, to see that it takes the public address. */
const PROBE_PUBLIC_URL = 'https://tula-dev-tunnel-probe.invalid'

/** The line a Compose file needs for `--tunnel`. Fixed text: no value of the project's. */
const COMPOSE_LINE = `PUBLIC_URL: \${${PUBLIC_URL_VARIABLE}:-http://localhost:\${API_PORT:-3003}}`

/** What a tunnel passes a request to: this machine, by address, on the API's published port. */
const TUNNEL_TARGET = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})$/

/** The two files Apple and Android fetch at the root of an app's domain (ADR 0040). */
const ASSOCIATION_FILES = ['apple-app-site-association', 'assetlinks.json'] as const

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const KEY = {
  publishable: /^tula_pk_[a-z]+_[A-Za-z0-9_-]{16,}$/,
  secret: /^tula_sk_[a-z]+_[A-Za-z0-9_-]{16,}$/,
}

/**
 * Where the managed block is: from its start marker to the end of the first end marker
 * **after** it. A marker is a whole line. The end is looked for after the start, never from
 * the top of the file: a line of the user's own that mentions the end marker above the block
 * would otherwise hide it, and every run would add another block.
 */
function findBlock(text: string): { start: number; end: number } | null {
  const start = /^# tula:dev:start[ \t\r]*$/m.exec(text)
  if (!start) {
    return null
  }
  const from = start.index + BLOCK_START.length
  const end = /^# tula:dev:end[ \t]*$/m.exec(text.slice(from))
  if (!end) {
    return null
  }
  return { start: start.index, end: from + end.index + BLOCK_END.length }
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
  const block = findBlock(text)
  if (!block) {
    return null
  }
  const vars: Record<string, string> = {}
  for (const line of text.slice(block.start, block.end).split('\n')) {
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
  const found = findBlock(text)
  if (!found) {
    return text
  }
  const after = text.slice(found.end).replace(/^\r?\n/, '')
  return `${text.slice(0, found.start)}${after}`
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
  const found = findBlock(text)
  if (found) {
    return `${text.slice(0, found.start)}${block}${text.slice(found.end)}`
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
  /** Give the stack a public https address through a tunnel (ADR 0049). */
  tunnel?: boolean
  /** The tunnel service. Default: Tailscale Funnel, the one that is built. */
  tunnelService?: TunnelService
}

function tunnelContext(options: Pick<DevOptions, 'host' | 'io' | 'tunnelService'>): TunnelContext {
  return {
    host: options.host,
    cwd: options.io.cwd,
    service: options.tunnelService ?? tailscaleFunnel,
  }
}

/**
 * What a tunnel for this project answers: everything goes to the API, and the two paths
 * Apple and Android fetch at a domain's root go to the development environment's own
 * association files (the API serves them under the environment's path only, ADR 0040).
 *
 * @param target - `http://127.0.0.1:<the API's published port>`.
 * @param environmentId - The development environment.
 * @returns The routes, `/` first.
 *
 * @example
 * ```ts
 * tunnelRoutes('http://127.0.0.1:3003', environmentId)[0]
 * // { path: '/', target: 'http://127.0.0.1:3003' }
 * ```
 */
export function tunnelRoutes(target: string, environmentId: string): TunnelRoute[] {
  return [
    { path: '/', target },
    ...ASSOCIATION_FILES.map((file) => ({
      path: `/.well-known/${file}`,
      target: `${target}/v1/environments/${environmentId}/.well-known/${file}`,
    })),
  ]
}

/**
 * The tunnel the block says a run opened, or was about to open, when what it says can be
 * used. The record is where the tunnel sends requests and the environment: both are known
 * before a tunnel is opened, which is when the record is written. The public name is not,
 * and is not part of it.
 */
function recordedTunnel(block: Readonly<Record<string, string>>): TunnelRoute[] | null {
  const target = block.TULA_TUNNEL_TARGET ?? ''
  const environmentId = UUID.exec(block.TULA_ENVIRONMENT_ID ?? '')?.[0]
  if (!TUNNEL_TARGET.test(target) || !environmentId) {
    return null
  }
  return tunnelRoutes(target, environmentId)
}

/**
 * Whether the tunnel's port serves something that cannot be this project's tunnel, asked
 * before the seed has said which environment the routes are for: it is judged against the
 * recorded tunnel and against the routes of every environment the block or the port itself
 * names, and is somebody else's only when it fits none.
 */
function servesAnother(
  status: TunnelStatus,
  target: string,
  block: Readonly<Record<string, string>>,
  previous: TunnelRoute[] | null
): boolean {
  const named = status.endpoints
    .flatMap((endpoint) => Object.values(endpoint.routes))
    .map((route) => UUID.exec(route ?? '')?.[0])
  const environments = [UUID.exec(block.TULA_ENVIRONMENT_ID ?? '')?.[0], ...named, NO_ENVIRONMENT]
  const candidates = [
    ...(previous ? [previous] : []),
    ...environments.flatMap((id) => (id ? [tunnelRoutes(target, id)] : [])),
  ]
  return candidates.every((routes) => judgeTunnel(status, routes).kind === 'foreign')
}

/** An environment nothing has: with it, only the route to the API itself can be "ours". */
const NO_ENVIRONMENT = '00000000-0000-0000-0000-000000000000'

/**
 * Close the tunnel an earlier run opened, and say what became of it. A tunnel that cannot
 * be closed is a warning with the command that closes it, never a failed run: stopping the
 * stack must not depend on the tunnel's tool.
 *
 * @returns What became of it. The caller keeps the tunnel's record unless it is `closed` or
 *   `gone`.
 */
async function closeRecorded(
  options: Pick<DevOptions, 'host' | 'io' | 'output' | 'tunnelService'>,
  routes: readonly TunnelRoute[]
): Promise<'closed' | 'gone' | 'foreign' | 'failed'> {
  const { output } = options
  const context = tunnelContext(options)
  const outcome = await closeTunnel(context, routes)
  const warning = output.errorStyle.yellow('warning:')
  if (outcome === 'closed') {
    output.line(
      `${output.style.dim('›')} The tunnel was closed: the public address no longer reaches this machine.`
    )
  } else if (outcome === 'foreign') {
    output.error(
      `${warning} ${context.service.name} now serves something \`tula dev\` did not set up where its tunnel was. It was left alone: \`${context.service.inspect}\` shows it. The tunnel's record stays in ${DEV_ENV_FILE} until a run finds the port free.`
    )
  } else if (outcome === 'failed') {
    output.error(
      `${warning} the tunnel \`tula dev --tunnel\` opened could not be closed. Close it yourself: \`${context.service.closeByHand}\`. Its record stays in ${DEV_ENV_FILE}, so \`tula dev down\` tries again.`
    )
  }
  return outcome
}

/** A value of the resolved Compose file's `environment`, as the text the container gets. */
function composeValue(environment: unknown, name: string): string {
  const value =
    typeof environment === 'object' && environment !== null
      ? (environment as Record<string, unknown>)[name]
      : undefined
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value).trim()
    : ''
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
  run: { timeoutMs: number; quiet?: boolean; env?: Readonly<Record<string, string>> }
): Promise<RunResult> {
  let result: RunResult
  try {
    result = await options.host.run(command, {
      cwd: options.io.cwd,
      timeoutMs: run.timeoutMs,
      ...(run.env && { env: run.env }),
    })
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

/**
 * Before a tunnel is opened: ask Compose what the API would be started with, and refuse
 * what cannot work. Nothing is started, opened or written by it.
 *
 * - The Compose file must take `PUBLIC_URL` from {@link PUBLIC_URL_VARIABLE}: `tula dev`
 *   sets nothing else of the server's, and never edits the file.
 * - The mock OAuth provider and the development SMS inbox must be off. The API refuses to
 *   start with either under an address that is not loopback (`env.ts`), and that rule is the
 *   point: `tula dev` neither loosens it nor switches a line of the developer's off.
 * - The API's port must be published on a fixed port of this machine: what the tunnel reaches.
 *
 * The resolved file holds the stack's secrets: it is parsed here and never printed.
 *
 * @returns Where the tunnel sends requests: `http://127.0.0.1:<port>`.
 */
async function tunnelTarget(options: DevOptions): Promise<string> {
  const result = await step(
    options,
    'Reading the Compose file',
    compose(options, 'config', '--format', 'json'),
    { timeoutMs: QUICK_MS, quiet: true, env: { [PUBLIC_URL_VARIABLE]: PROBE_PUBLIC_URL } }
  )
  const untouched = 'Nothing was started, and .env.local was not changed.'
  let api: unknown
  try {
    api = (JSON.parse(result.stdout) as { services?: Record<string, unknown> }).services?.api
  } catch {
    api = undefined
  }
  if (typeof api !== 'object' || api === null) {
    throw new UsageError(
      `The resolved Compose file could not be read (\`docker compose config --format json\`). \`tula dev --tunnel\` needs it to see how the API is started. ${untouched}`
    )
  }
  const { environment, ports } = api as { environment?: unknown; ports?: unknown }
  if (composeValue(environment, 'PUBLIC_URL') !== PROBE_PUBLIC_URL) {
    throw new UsageError(
      `The Compose file here gives the API a fixed PUBLIC_URL, so it cannot be started under a public address, and \`tula dev\` does not edit the file. In the \`api\` service, change that line to:\n\n    ${COMPOSE_LINE}\n\nand run this again. ${untouched}`
    )
  }
  const on: string[] = []
  if (/^(true|1|yes)$/i.test(composeValue(environment, 'OAUTH_MOCK_PROVIDER'))) {
    on.push('the mock OAuth provider (OAUTH_MOCK_PROVIDER)')
  }
  if (composeValue(environment, 'SMS_PROVIDER').toLowerCase() === 'dev') {
    on.push('the development SMS inbox (SMS_PROVIDER=dev)')
  }
  if (on.length > 0) {
    throw new UsageError(
      `This stack has ${on.join(' and ')} switched on. The API refuses to start with that under a public address: it hands a sign-in, or every texted code, to whoever asks, and is for this machine only. \`tula dev\` does not change your lines. Switch it off in .env (or the Compose file) and run this again, or run \`tula dev\` without --tunnel to keep it. ${untouched}`
    )
  }
  const published = (Array.isArray(ports) ? (ports as unknown[]) : [])
    .filter((port): port is Record<string, unknown> => typeof port === 'object' && port !== null)
    .find((port) => String(port.target) === API_CONTAINER_PORT)?.published
  const port = /^[0-9]{1,5}$/.exec(String(published ?? ''))?.[0]
  if (!port || Number(port) < 1 || Number(port) > 65_535) {
    throw new UsageError(
      `The \`api\` service does not publish its port 3003 on a fixed port of this machine, which is where a tunnel sends requests. Publish it in the Compose file (e.g. \`127.0.0.1:3003:3003\`). ${untouched}`
    )
  }
  return `http://127.0.0.1:${port}`
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

async function waitUntilReady(
  options: DevOptions,
  apiUrl: string,
  halt: () => void
): Promise<void> {
  const send = options.io.fetch ?? ((url, init) => fetch(url, init))
  const attempts = Math.max(1, Math.ceil(options.timeoutMs / 1000))
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    halt()
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
 * With `tunnel` (ADR 0049) the API is started under a public https address: the tunnel is
 * opened through `host` like every other command, the address goes into the block and into
 * the one `docker compose up` that starts the API, and nothing else of the project is
 * changed: no line outside the block, and no setting of the environment (the changes are
 * printed for the developer to make). Without `tunnel`, a tunnel an earlier run opened is
 * closed and the API goes back to its local address. A port that serves something else is
 * refused before anything is started. The API's container is stopped and the tunnel's
 * record (`TULA_TUNNEL_TARGET`) written before the tunnel is opened; a run that fails or
 * receives an interrupt after that closes the tunnel again before it throws, and the
 * record leaves the block only when the tunnel is closed. A process that is killed
 * outright closes nothing: the record is what `tula dev down` then closes by.
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

  const path = `${io.cwd.replace(/\/+$/, '')}/${DEV_ENV_FILE}`
  const raw = await host.readFile(path)
  const existing = raw ?? ''
  const block = parseDevBlock(existing) ?? {}
  const previous = recordedTunnel(block)
  const tunnel = tunnelContext(options)
  let target: string | undefined
  if (options.tunnel) {
    // Said before anything is started or written: a developer who relies on either must
    // know that the stack this run starts cannot have them.
    say(
      'A tunnel gives this stack a public address. Under one the API refuses to start with the mock OAuth provider (OAUTH_MOCK_PROVIDER) or the development SMS inbox (SMS_PROVIDER=dev): both are for this machine only.'
    )
    target = await tunnelTarget(options)
    // Asked now, before the stack is touched: a missing tool is said with how to install
    // it, and a port that serves somebody else's is refused before a container is started.
    // It is asked again when the tunnel is opened: what is served can change in between.
    const status = await tunnelStatus(tunnel)
    if (servesAnother(status, target, block, previous)) {
      throw new UsageError(`${portInUse(tunnel.service)} Nothing was started.`)
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

  if (target !== undefined) {
    await serveThroughTunnel(options, { path, raw, block, previous, target, environmentId })
    return
  }
  // The record of a tunnel that is still there is what `tula dev down` closes it by: it
  // goes only when the tunnel has.
  const outcome = previous ? await closeRecorded(options, previous) : 'gone'
  const still = outcome === 'failed' || outcome === 'foreign'
  await serve(options, {
    path,
    existing,
    block,
    environmentId,
    tunnel: null,
    ...(still && block.TULA_TUNNEL_TARGET && { record: block.TULA_TUNNEL_TARGET }),
    halt: () => {},
  })
}

/** How long stopping the API's container may take. */
const STOP_MS = 300_000

/** What {@link serveThroughTunnel} is handed by {@link startDev}. */
interface TunnelRun {
  /** `.env.local`, absolute. */
  path: string
  /** Its contents when the run began; `null` when there was no file. */
  raw: string | null
  /** The block's variables when the run began. */
  block: Readonly<Record<string, string>>
  /** The tunnel the block recorded when the run began. */
  previous: TunnelRoute[] | null
  /** Where the tunnel sends requests. */
  target: string
  /** The development environment the seed reported. */
  environmentId: string
}

/**
 * The part of `tula dev --tunnel` in which a public address can come to exist: open the
 * tunnel, start the API under its address, and leave nothing public behind that the block
 * does not record.
 *
 * The order is the guarantee (ADR 0049, "What an interrupted run leaves"):
 *
 * 1. the API's container is stopped (an earlier one was started without the tunnel, perhaps
 *    with a development-only route on, and must not be what the address first reaches);
 * 2. the tunnel's record is written to the block: where it sends requests, and the
 *    environment. The public name is not known yet and is not part of the record;
 * 3. the tunnel is opened; 4. the API is started under the address.
 *
 * From before the first of these until the stack is reported, interrupts are listened for
 * through the host: the run stops at its next step, closes what it opened (a close no later
 * interrupt cuts short) and ends as a failed run. The record goes only when the tunnel has:
 * a tunnel that could not be closed stays recorded, for `tula dev down`.
 */
async function serveThroughTunnel(options: DevOptions, run: TunnelRun): Promise<void> {
  const { host, output } = options
  const { path, raw, block, previous, target, environmentId } = run
  const existing = raw ?? ''
  const tunnel = tunnelContext(options)
  const { service } = tunnel
  const routes = tunnelRoutes(target, environmentId)
  const same = previous !== null && JSON.stringify(previous) === JSON.stringify(routes)

  let signals = 0
  let closing = false
  const release = host.onInterrupt(() => {
    signals += 1
    if (closing) {
      output.error('The tunnel is being closed. That is not cut short: one moment.')
    }
  })
  const halt = () => {
    if (signals > 0) {
      throw Object.assign(new Error('interrupted'), { code: 'ABORT' })
    }
  }
  /** What this run wrote before the tunnel was opened, when it wrote anything. */
  let pending: string | null = null
  const record = async (vars: Readonly<Record<string, string>>) => {
    const text = withDevBlock(existing, {
      ...vars,
      TULA_ENVIRONMENT_ID: environmentId,
      TULA_TUNNEL_TARGET: target,
    })
    if (text !== existing) {
      await host.writeSecretFile(path, text)
      pending = text
    }
  }
  let staleClosed = false
  let stopped = false
  let started = false
  let begun = false
  /** The stop was asked for: a stop that fails may still have stopped the container. */
  let stopping = false
  let adopted: 'no' | 'unrecorded' | 'recorded' = 'no'
  try {
    if (previous && !same) {
      // The port or the environment changed since the tunnel was opened: the old routes
      // would otherwise read as somebody else's.
      const outcome = await closeRecorded(options, previous)
      if (outcome === 'failed' || outcome === 'foreign') {
        throw new UsageError(
          'The tunnel an earlier run opened, for another port or environment, is still recorded in .env.local and was not closed, so no new one was opened. The API was not touched.'
        )
      }
      staleClosed = true
    }
    halt()
    output.line(`${output.style.dim('›')} Opening the tunnel (${service.name})…`)
    const answer = await openTunnel({ ...tunnel, halt }, routes, async () => {
      halt()
      stopping = true
      await step(options, 'Stopping the API', compose(options, 'stop', 'api'), {
        timeoutMs: STOP_MS,
      })
      stopped = true
      halt()
      await record(same ? block : withoutTunnelVariables(block))
      begun = true
      // The close runs on `begun`: stopping here opens nothing and takes the record out.
      halt()
    })
    if (!begun) {
      // Open before this run, by an earlier one or by hand with the same routes: recorded
      // all the same, so that it can be closed.
      adopted = 'unrecorded'
      await record(same ? block : withoutTunnelVariables(block))
      adopted = 'recorded'
    }
    halt()
    const now: string = pending ?? existing
    await serve(options, {
      path,
      existing: now,
      block: parseDevBlock(now) ?? {},
      environmentId,
      tunnel: { publicUrl: `https://${answer.host}`, target },
      halt,
      started: () => {
        started = true
      },
    })
  } catch (error) {
    closing = true
    const interrupted = signals > 0 || (error as { code?: unknown }).code === 'ABORT'
    // A public address must not outlive the run that failed to set the stack up for it.
    const outcome = begun
      ? await closeTunnel({ ...tunnel, shielded: true }, routes).catch(() => 'failed' as const)
      : null
    const closed = outcome === 'closed' || outcome === 'gone'
    let dropped = false
    if (begun ? closed : staleClosed) {
      dropped = await dropRecord(host, path, { raw, pending }).catch(() => false)
    }
    if (begun) {
      output.error(
        closed
          ? `The tunnel this run opened was closed again${dropped ? ', and its record was taken out of .env.local' : '. Its record could not be taken out of .env.local: `tula dev down` does that'}.`
          : outcome === 'foreign'
            ? `${service.name} now serves something else where this run was opening its tunnel. It was left alone (\`${service.inspect}\` shows it), and the tunnel's record stays in .env.local until a run finds the port free.`
            : `The tunnel this run opened could not be closed, and may still reach this machine. Its record stays in .env.local: \`tula dev down\` tries again, and \`${service.closeByHand}\` closes it by hand.`
      )
    } else if (adopted === 'recorded') {
      output.error(
        'The tunnel was open before this run and was left open; it is recorded in .env.local. `tula dev down` closes it.'
      )
    } else if (adopted === 'unrecorded') {
      output.error(
        `The tunnel was open before this run and was left open. It could not be recorded in .env.local, so \`tula dev down\` does not know of it: \`${service.closeByHand}\` closes it by hand.`
      )
    }
    if (stopped && !started) {
      output.error(
        'The API was stopped before the tunnel was opened and was not started again: `tula dev` starts it.'
      )
    } else if (stopping && !stopped) {
      output.error(
        'The API may have been stopped (the stop did not end as expected): `tula dev` starts it.'
      )
    }
    if (interrupted && !(error instanceof UsageError)) {
      throw new UsageError(
        'Interrupted. `tula dev` continues where this stopped, `tula dev down` stops the stack.'
      )
    }
    throw error
  } finally {
    release()
  }
}

/** A block's variables without the ones that exist only while a tunnel is open. */
function withoutTunnelVariables(block: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(block).filter(([name]) => !TUNNEL_VARIABLES.includes(name))
  )
}

/**
 * A file's contents with the tunnel's variables out of the block. A block that held the
 * record and nothing else (the record names the environment too) goes with it: that is the
 * block an interrupted run left, in a file that had none.
 */
function withoutTunnelRecord(text: string): string {
  const block = parseDevBlock(text)
  if (!block) {
    return text
  }
  const kept = withoutTunnelVariables(block)
  if (Object.keys(kept).length === Object.keys(block).length) {
    return text
  }
  return Object.keys(kept).every((name) => name === 'TULA_ENVIRONMENT_ID')
    ? withoutDevBlock(text)
    : withDevBlock(text, kept)
}

/**
 * Take a closed tunnel's record out of `.env.local`. A file that holds only what this run
 * wrote before it opened the tunnel goes back to what it was (and is removed when there was
 * none); anything written since keeps everything but the tunnel's variables.
 *
 * @returns Whether the file now records no tunnel.
 */
async function dropRecord(
  host: Host,
  path: string,
  was: { raw: string | null; pending: string | null }
): Promise<boolean> {
  const now = await host.readFile(path)
  if (now === null) {
    return true
  }
  const next = withoutTunnelRecord(now === was.pending ? (was.raw ?? '') : now)
  if (next === '' && was.raw === null) {
    await host.removeFile(path)
  } else if (next !== now) {
    await host.writeSecretFile(path, next)
  }
  return true
}

/** What {@link serve} is handed by {@link startDev}. */
interface ServeState {
  /** `.env.local`, absolute. */
  path: string
  /** Its contents when the run began (`''` when there was none). */
  existing: string
  /** The block's variables when the run began. */
  block: Readonly<Record<string, string>>
  /** The development environment the seed reported. */
  environmentId: string
  /** The open tunnel: its public address and where it sends requests. `null` without one. */
  tunnel: { publicUrl: string; target: string } | null
  /**
   * Without a tunnel: where a tunnel that could not be closed sends requests. It stays in
   * the block, which is what `tula dev down` closes the tunnel by.
   */
  record?: string
  /** Throws when the run was interrupted. Asked between steps, and before the file is written. */
  halt: () => void
  /** Called once the API's container has been started. */
  started?: () => void
}

/** The second half of `tula dev`: start the API, mint or reuse the keys, write, report. */
async function serve(options: DevOptions, state: ServeState): Promise<void> {
  const { io, output, host } = options
  const { path, existing, block, environmentId, tunnel, halt } = state
  const say = (text: string) => output.line(`${output.style.dim('›')} ${text}`)

  halt()
  say('Starting the API…')
  await step(options, 'Starting the API', compose(options, 'up', '-d', 'api'), {
    timeoutMs: options.timeoutMs,
    // Compose puts the process's environment above the project's `.env`: this is how the
    // API gets its public address without a line of the project being changed. Without a
    // tunnel the variable is absent and the Compose file's own default (loopback) applies.
    ...(tunnel && { env: { [PUBLIC_URL_VARIABLE]: tunnel.publicUrl } }),
  })
  state.started?.()
  const apiUrl = await publishedUrl(options, 'api', API_CONTAINER_PORT)
  if (!apiUrl) {
    throw new UsageError(
      'The `api` service does not publish its port 3003, so its URL is unknown. Publish it in the Compose file (e.g. `127.0.0.1:3003:3003`).'
    )
  }
  if (tunnel && new URL(apiUrl).port !== new URL(tunnel.target).port) {
    throw new UsageError(
      'The API is published on another port than the Compose file said, so the tunnel would not reach it.'
    )
  }
  await waitUntilReady(options, apiUrl, halt)
  halt()

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
  if (tunnel) {
    // `TULA_API_URL` stays the local address: `tula` and a server on this machine reach the
    // API there, with no tunnel in between. The public address is what the API calls itself
    // (so what its tokens name as their issuer) and what a phone is pointed at.
    vars[PUBLIC_URL_VARIABLE] = tunnel.publicUrl
    vars.TULA_ISSUER = environmentIssuer(tunnel.publicUrl, environmentId)
    vars.TULA_TUNNEL_TARGET = tunnel.target
  } else if (state.record) {
    vars.TULA_TUNNEL_TARGET = state.record
  }
  halt()
  const next = withDevBlock(existing, vars)
  if (next !== existing) {
    await host.writeSecretFile(path, next)
  } else if (await host.restrictFile(path)) {
    // Nothing to write, but the file holds a secret key: its mode is checked on every run,
    // not only on the runs that change it (a copy, an editor or a restore can widen it).
    output.error(
      `${output.errorStyle.yellow('warning:')} ${DEV_ENV_FILE} holds a secret key and was readable by other users of this machine. It is now readable by you only (mode 0600).`
    )
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
  // The two commands above take an interrupt for "no answer": asked here, so that a signal
  // which arrived during either is not followed by "Tula is running" with a tunnel open.
  halt()
  const { style } = output
  output.line()
  output.line(style.bold('Tula is running.'))
  output.line(`  API              ${apiUrl}`)
  if (tunnel) {
    output.line(`  Public address   ${tunnel.publicUrl}`)
  }
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
  if (tunnel) {
    const name = new URL(tunnel.publicUrl).host
    const { service } = tunnelContext(options)
    output.line()
    output.line(style.bold(`The tunnel is open (${service.name}).`))
    output.line(
      `  ${tunnel.publicUrl} reaches this machine's API, and so does anyone who has that address: the sign-in routes, the dashboard's sign-in and the API reference included. \`tula dev\` without --tunnel, or \`tula dev down\`, closes it.`
    )
    output.line(
      `  The address is in ${DEV_ENV_FILE} as ${PUBLIC_URL_VARIABLE}, and the issuer of this stack's tokens as TULA_ISSUER. TULA_API_URL is still the local address.`
    )
    output.line(
      '  The mock OAuth provider and the development SMS inbox are off under a public address, and their routes answer a local request only.'
    )
    output.line()
    output.line(
      'No setting of the environment was changed. For passkeys and a native app at this address, put this in tula.config.ts and run `tula apply`:'
    )
    output.line(`    passkeys: { rpId: '${name}' },`)
    output.line(
      `    urls: { allowedOrigins: ['${tunnel.publicUrl}' /* and the origins you already allow */] },`
    )
    output.line(
      `  Register the app under \`nativeApps\`; its associated domain is ${name}. /.well-known/apple-app-site-association and /.well-known/assetlinks.json at that address answer with this environment's files.`
    )
    output.line(
      '  A redirect URL or an app link at this address goes in `urls.allowedRedirectUrls`, written out in full.'
    )
    output.line()
    output.line(
      'Not checked: that the address answers from the internet, or from a phone. Open its /v1/status in the phone’s browser to see.'
    )
  }
  output.line(
    'Next: `tula doctor` checks the stack, `tula apply` applies tula.config.ts, `tula dev down` stops it.'
  )
}

/**
 * `tula dev down`: stop the project's stack. With `volumes` the database is deleted too, and
 * the keys `tula dev` wrote (which that database no longer knows) are removed from
 * `.env.local`; every other line of the file stays. A tunnel `tula dev --tunnel` opened is
 * closed first, and its address is taken out of the block.
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
  options: Pick<DevOptions, 'io' | 'output' | 'host' | 'projectName' | 'tunnelService'> & {
    volumes: boolean
  }
): Promise<void> {
  const { io, output, host } = options
  const path = `${io.cwd.replace(/\/+$/, '')}/${DEV_ENV_FILE}`
  const existing = await host.readFile(path)
  const block = existing === null ? null : parseDevBlock(existing)
  const tunnel = block ? recordedTunnel(block) : null
  // First, and whatever Docker then does: a public address must not outlive its stack.
  const outcome = tunnel ? await closeRecorded(options, tunnel) : 'gone'
  // A tunnel that is still there stays recorded: the record is what the next run closes it by.
  const still = block !== null && (outcome === 'failed' || outcome === 'foreign')
  await step(
    options,
    'Stopping the stack',
    compose(options, 'down', ...(options.volumes ? ['--volumes'] : [])),
    { timeoutMs: STOP_MS }
  )
  if (options.volumes) {
    if (existing !== null && block !== null) {
      await host.writeSecretFile(
        path,
        still
          ? withDevBlock(existing, {
              TULA_ENVIRONMENT_ID: block.TULA_ENVIRONMENT_ID ?? '',
              TULA_TUNNEL_TARGET: block.TULA_TUNNEL_TARGET ?? '',
            })
          : withoutDevBlock(existing)
      )
    }
    output.line(
      `Stopped, and the data is deleted. The keys \`tula dev\` wrote were removed from ${DEV_ENV_FILE}.`
    )
  } else {
    if (existing !== null && !still) {
      // The address is no longer this stack's: the next start is a local one unless asked.
      const next = withoutTunnelRecord(existing)
      if (next !== existing) {
        await host.writeSecretFile(path, next)
      }
    }
    output.line('Stopped. The data is kept: `tula dev` starts it again.')
  }
}
