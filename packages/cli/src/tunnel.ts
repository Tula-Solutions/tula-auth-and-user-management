import { UsageError } from './args'
import { printable } from './doctor'
import type { Host, RunResult } from './host'

/**
 * One thing the tunnel answers: a path of the public address, and the local URL a request
 * for it is passed to. `/` is everything no other route names.
 *
 * @example
 * ```ts
 * const root: TunnelRoute = { path: '/', target: 'http://127.0.0.1:3003' }
 * ```
 */
export interface TunnelRoute {
  /** The path on the public address: `/`, or one exact path. */
  path: string
  /** Where it goes: `http://127.0.0.1:<port>`, with a path for an exact route. */
  target: string
}

/**
 * What a tunnel tool says it serves on the tunnel's port.
 *
 * @example
 * ```ts
 * const nothing: TunnelStatus = { endpoints: [], taken: false }
 * ```
 */
export interface TunnelStatus {
  /** Each public name with something on the port, and where each of its paths goes. */
  endpoints: {
    /** The name, lower case, without a port. */
    host: string
    /** Whether the internet reaches it (not only the tool's private network). */
    public: boolean
    /** Path to local URL; `null` for a path that is served some other way (a file, a text). */
    routes: Record<string, string | null>
  }[]
  /** The port is in use by something that is no web endpoint (a TCP forward, a session in the foreground). */
  taken: boolean
}

/**
 * A tunnel service, as `tula dev --tunnel` needs it: how its tool is asked what it serves,
 * told to serve a route and told to stop, and what to say when the tool is missing. One
 * service is built (ADR 0049); another would be another value of this type.
 *
 * The tool's own login and configuration are the developer's: no command here carries a
 * credential, reads one or names a file that holds one. **No command makes the tool rewrite
 * the `Host` header**: the API's development-only routes answer a loopback `Host` only, and
 * that is one of the things that keeps them off a tunnel.
 *
 * @example
 * ```ts
 * tailscaleFunnel.openCommand({ path: '/', target: 'http://127.0.0.1:3003' })
 * // ['tailscale', 'funnel', '--bg', '--yes', '--https=443', 'http://127.0.0.1:3003']
 * ```
 */
export interface TunnelService {
  /** The service's name, for messages. */
  readonly name: string
  /** The executable. */
  readonly binary: string
  /** What is said when the executable is missing: its name and how to install it. Fixed text. */
  readonly missing: string
  /** What is said when the tool starts and reports no address in time. Fixed text. */
  readonly noAddress: string
  /** How to see, by hand, what the tool serves. */
  readonly inspect: string
  /** How to close the tunnel by hand. */
  readonly closeByHand: string
  /** The argument vector that prints what the tool serves. */
  statusCommand(): readonly string[]
  /** The argument vector that serves one route and returns. */
  openCommand(route: TunnelRoute): readonly string[]
  /** The argument vector that stops serving everything on the tunnel's port. */
  closeCommand(): readonly string[]
  /**
   * Read what {@link TunnelService.statusCommand} printed.
   *
   * @param stdout - The tool's standard output.
   * @returns What is served on the tunnel's port, or `null` when the output cannot be read.
   */
  readStatus(stdout: string): TunnelStatus | null
}

/** The one port a Funnel address needs no port number for. */
const FUNNEL_PORT = '443'

/** A tailnet name: labels of letters, digits and hyphens, under `ts.net`. Lower case. */
const TAILNET_HOST =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.ts\.net$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `name:port` of a serve configuration's key, when the port is the tunnel's. */
function hostOnFunnelPort(key: string): string | null {
  const at = key.lastIndexOf(':')
  return at > 0 && key.slice(at + 1) === FUNNEL_PORT ? key.slice(0, at).toLowerCase() : null
}

/** Whether a serve configuration (the node's, or a foreground session's) uses the port. */
function usesFunnelPort(config: Record<string, unknown>): boolean {
  const tcp = isRecord(config.TCP) ? config.TCP : {}
  const web = isRecord(config.Web) ? config.Web : {}
  return (
    Object.hasOwn(tcp, FUNNEL_PORT) ||
    Object.keys(web).some((key) => hostOnFunnelPort(key) !== null)
  )
}

/**
 * Tailscale Funnel (ADR 0049): the machine's own `https://<machine>.<tailnet>.ts.net`, the
 * same on every run, with a certificate the public trusts, served by the Tailscale client
 * that is already running. `--bg` makes the client keep serving after the command returns,
 * so there is no child process to hold: the tunnel is closed with a command, as it is opened.
 *
 * @example
 * ```ts
 * tailscaleFunnel.closeCommand() // ['tailscale', 'funnel', '--yes', '--https=443', 'off']
 * ```
 */
export const tailscaleFunnel: TunnelService = {
  name: 'Tailscale Funnel',
  binary: 'tailscale',
  missing:
    '`tailscale` was not found. `tula dev --tunnel` opens the tunnel with Tailscale Funnel: install Tailscale (https://tailscale.com/download), sign this machine in to your tailnet (`tailscale up`), and run this again. Nothing was started, and .env.local was not changed.',
  noAddress:
    'Tailscale did not report a public address for the tunnel in time. Funnel may not be switched on for this machine yet: run `tailscale funnel 443` once by hand (it says what is missing: HTTPS certificates, MagicDNS, or the funnel attribute of your tailnet), stop it with Ctrl-C, and run this again. Whatever this run opened was closed again, and .env.local was not changed.',
  inspect: 'tailscale funnel status',
  closeByHand: `tailscale funnel --https=${FUNNEL_PORT} off`,
  statusCommand: () => ['tailscale', 'funnel', 'status', '--json'],
  openCommand: (route) => [
    'tailscale',
    'funnel',
    '--bg',
    '--yes',
    `--https=${FUNNEL_PORT}`,
    ...(route.path === '/' ? [] : [`--set-path=${route.path}`]),
    route.target,
  ],
  closeCommand: () => ['tailscale', 'funnel', '--yes', `--https=${FUNNEL_PORT}`, 'off'],
  readStatus(stdout) {
    let config: unknown
    try {
      config = JSON.parse(stdout.trim() === '' ? '{}' : stdout)
    } catch {
      return null
    }
    if (!isRecord(config)) {
      return null
    }
    const web = isRecord(config.Web) ? config.Web : {}
    const funnel = isRecord(config.AllowFunnel) ? config.AllowFunnel : {}
    const endpoints: TunnelStatus['endpoints'] = []
    let unreadable = false
    for (const key of Object.keys(web)) {
      const host = hostOnFunnelPort(key)
      const entry = web[key]
      const handlers = isRecord(entry) && isRecord(entry.Handlers) ? entry.Handlers : {}
      if (host === null || Object.keys(handlers).length === 0) {
        continue
      }
      if (!TAILNET_HOST.test(host)) {
        // A name that is not a tailnet's is not one this adapter writes to a file.
        unreadable = true
        continue
      }
      const routes: Record<string, string | null> = {}
      for (const path of Object.keys(handlers)) {
        const handler = handlers[path]
        routes[path] = isRecord(handler) && typeof handler.Proxy === 'string' ? handler.Proxy : null
      }
      endpoints.push({ host, public: funnel[key] === true, routes })
    }
    const tcp = isRecord(config.TCP) ? config.TCP : {}
    const foreground = isRecord(config.Foreground) ? Object.values(config.Foreground) : []
    return {
      endpoints,
      taken:
        unreadable ||
        (Object.hasOwn(tcp, FUNNEL_PORT) && endpoints.length === 0) ||
        foreground.some((session) => isRecord(session) && usesFunnelPort(session)),
    }
  },
}

/** A short command of the tunnel tool: asking what it serves. */
const STATUS_MS = 30_000
/** Serving a route, or stopping: the first one may wait for a certificate. */
const CHANGE_MS = 90_000
/** How often the tool is asked for the address after the routes were opened, a second apart. */
const ADDRESS_TRIES = 15

/**
 * What a tunnel is opened or closed with.
 *
 * @example
 * ```ts
 * const context: TunnelContext = { host, cwd: '/work/shop', service: tailscaleFunnel }
 * ```
 */
export interface TunnelContext {
  /** How the tool is run: an argument vector, a timeout, never a shell line. */
  host: Host
  /** The working directory of the run. */
  cwd: string
  /** The service. */
  service: TunnelService
}

const sameTarget = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '')

/**
 * Compare what the tool serves with the routes `tula dev` wants.
 *
 * `ours` means every path served on the port is one of `routes`, going where `routes` says:
 * nothing of anybody else's is there, so opening the rest or closing the port touches only
 * what `tula dev` set up. Anything else on the port is `foreign` and is never changed.
 *
 * @param status - What the tool reported.
 * @param routes - The routes of this project's tunnel.
 * @returns `absent`, `foreign`, or `ours` with the public name and the routes still missing.
 *
 * @example
 * ```ts
 * judgeTunnel({ endpoints: [], taken: false }, routes) // { kind: 'absent' }
 * ```
 */
export function judgeTunnel(
  status: TunnelStatus,
  routes: readonly TunnelRoute[]
):
  | { kind: 'absent' }
  | { kind: 'foreign' }
  | { kind: 'ours'; host: string; public: boolean; missing: TunnelRoute[] } {
  if (status.taken || status.endpoints.length > 1) {
    return { kind: 'foreign' }
  }
  const [endpoint] = status.endpoints
  if (!endpoint) {
    return { kind: 'absent' }
  }
  for (const [path, target] of Object.entries(endpoint.routes)) {
    const wanted = routes.find((route) => route.path === path)
    if (!wanted || target === null || !sameTarget(wanted.target, target)) {
      return { kind: 'foreign' }
    }
  }
  return {
    kind: 'ours',
    host: endpoint.host,
    public: endpoint.public,
    missing: routes.filter((route) => !Object.hasOwn(endpoint.routes, route.path)),
  }
}

/** The last lines of what the tool said, cleaned for a terminal. */
function said(result: RunResult): string {
  return (result.stderr || result.stdout)
    .trim()
    .split('\n')
    .slice(-6)
    .map((line) => `    ${printable(line, 300)}`)
    .join('\n')
}

async function run(
  context: TunnelContext,
  command: readonly string[],
  timeoutMs: number
): Promise<RunResult> {
  try {
    return await context.host.run(command, { cwd: context.cwd, timeoutMs })
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') {
      throw new UsageError(context.service.missing)
    }
    throw error
  }
}

/**
 * Ask the tool what it serves on the tunnel's port.
 *
 * @param context - The host and the service.
 * @returns What it serves.
 * @throws UsageError when the tool is missing (how to install it), does not answer in time,
 *   fails, or prints what cannot be read.
 *
 * @example
 * ```ts
 * const status = await tunnelStatus({ host, cwd, service: tailscaleFunnel })
 * ```
 */
export async function tunnelStatus(context: TunnelContext): Promise<TunnelStatus> {
  const { service } = context
  const result = await run(context, service.statusCommand(), STATUS_MS)
  if (result.timedOut) {
    throw new UsageError(
      `\`${service.inspect}\` did not answer in ${STATUS_MS / 1000}s. Is ${service.binary} running on this machine?`
    )
  }
  if (result.code !== 0) {
    throw new UsageError(
      `\`${service.inspect}\` failed (exit ${String(result.code)}). Is this machine signed in to ${service.name}?\n${said(result)}`
    )
  }
  const status = service.readStatus(result.stdout)
  if (!status) {
    throw new UsageError(
      `\`${service.inspect}\` printed something \`tula dev\` cannot read. Nothing was changed.`
    )
  }
  return status
}

/**
 * Close this project's tunnel, if it is the only thing on the tunnel's port.
 *
 * @param context - The host and the service.
 * @param routes - The routes `tula dev` opened.
 * @returns `closed`; `gone` when nothing was there; `foreign` when the port now serves
 *   something else, which is left alone; `failed` when the tool could not be asked or what
 *   was opened is still there.
 *
 * @example
 * ```ts
 * await closeTunnel(context, routes) // 'closed'
 * ```
 */
export async function closeTunnel(
  context: TunnelContext,
  routes: readonly TunnelRoute[]
): Promise<'closed' | 'gone' | 'foreign' | 'failed'> {
  try {
    const before = judgeTunnel(await tunnelStatus(context), routes)
    if (before.kind !== 'ours') {
      return before.kind === 'absent' ? 'gone' : 'foreign'
    }
    await run(context, context.service.closeCommand(), CHANGE_MS)
    const after = judgeTunnel(await tunnelStatus(context), routes)
    return after.kind === 'absent' ? 'closed' : 'failed'
  } catch (error) {
    // Interrupted is still interrupted; everything else is "could not be closed".
    if ((error as { code?: unknown }).code === 'ABORT') {
      throw error
    }
    return 'failed'
  }
}

/**
 * Open this project's tunnel and read its public name.
 *
 * Routes that are already served as wanted are left as they are, so a second run starts
 * nothing. A port that serves anything else is refused and not touched. When a route cannot
 * be opened, or no address is reported in time, what this call opened is closed again
 * before it throws.
 *
 * @param context - The host and the service.
 * @param routes - The routes to serve; the first is `/`.
 * @returns The public host name, and whether this call opened anything.
 * @throws UsageError with fixed words for a missing tool, a port in use and no address.
 *
 * @example
 * ```ts
 * const { host } = await openTunnel(context, [{ path: '/', target: 'http://127.0.0.1:3003' }])
 * ```
 */
export async function openTunnel(
  context: TunnelContext,
  routes: readonly TunnelRoute[]
): Promise<{ host: string; opened: boolean }> {
  const { service } = context
  const before = judgeTunnel(await tunnelStatus(context), routes)
  if (before.kind === 'foreign') {
    throw new UsageError(
      `${service.name} already serves something else on this machine's port ${FUNNEL_PORT}, which \`tula dev --tunnel\` would use. It was left alone, and .env.local was not changed. \`${service.inspect}\` shows it; \`${service.closeByHand}\` removes it.`
    )
  }
  if (before.kind === 'ours' && before.public && before.missing.length === 0) {
    return { host: before.host, opened: false }
  }
  const missing = before.kind === 'ours' ? before.missing : [...routes]
  // Also when every route is there and only the public part is not: the first is asked again.
  const toOpen = missing.length > 0 ? missing : routes.slice(0, 1)
  let cleaned = false
  const giveUp = async (message: string): Promise<never> => {
    cleaned = true
    const closed = await closeTunnel(context, routes).catch(() => 'failed' as const)
    throw new UsageError(
      closed === 'failed'
        ? `${message}\nThe tunnel may be partly open: \`${service.closeByHand}\` closes it.`
        : message
    )
  }
  try {
    for (const route of toOpen) {
      const result = await run(context, service.openCommand(route), CHANGE_MS)
      if (result.timedOut) {
        return await giveUp(service.noAddress)
      }
      if (result.code !== 0) {
        return await giveUp(
          `${service.name} refused to open the tunnel (exit ${String(result.code)}). What this run opened was closed again, and .env.local was not changed. It said:\n${said(result)}`
        )
      }
    }
    for (let attempt = 0; attempt < ADDRESS_TRIES; attempt += 1) {
      const now = judgeTunnel(await tunnelStatus(context), routes)
      if (now.kind === 'ours' && now.public && now.missing.length === 0) {
        return { host: now.host, opened: true }
      }
      await context.host.sleep(1_000)
    }
  } catch (error) {
    if (!cleaned) {
      // Interrupted, or the tool stopped answering: do not leave a public address behind.
      await closeTunnel(context, routes).catch(() => 'failed')
    }
    throw error
  }
  return await giveUp(service.noAddress)
}
