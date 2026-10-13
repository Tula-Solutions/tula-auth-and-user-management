import { type AdminClient, isTulaAdminError } from '@tula-tech/admin'
import {
  DEFAULT_CONFIG_FILE,
  type EnvironmentConfig,
  hashEnvironmentConfig,
  loadConfig,
  selectEnvironment,
} from '@tula-tech/config'
import type { EnvironmentSettings, OAuthProvider, SettingsManagedBy } from '@tula-tech/contract'
import type { OptionSpec } from '../args'
import {
  buildPlan,
  DEPENDENTS_UNREAD,
  type Plan,
  providersGoingOff,
  type RemoteDependents,
  type RemoteState,
  readDependentCount,
} from '../diff'
import type { CommandContext } from '../framework'
import { resolveTarget, type Target } from '../target'

/** The options `tula diff` and `tula apply` share. */
export const PLAN_OPTIONS = {
  config: {
    type: 'string',
    short: 'c',
    value: '<path>',
    description: `The config file. Default: ${DEFAULT_CONFIG_FILE} in the current directory.`,
  },
  env: {
    type: 'string',
    short: 'e',
    value: '<name>',
    description: 'The environment in the config. May be left out when the file has one.',
  },
  'api-url': {
    type: 'string',
    value: '<url>',
    description: 'The Tula API. Default: TULA_API_URL_<NAME>, then TULA_API_URL.',
  },
  'insecure-http': {
    type: 'boolean',
    description:
      'Allow a plain http API URL that is not localhost: the secret key then crosses the network in clear text. For a private network you trust.',
  },
  'secret-key-file': {
    type: 'string',
    value: '<path>',
    description:
      'Read the secret key from a file (- for standard input, piped; apply then needs --yes). Default: TULA_SECRET_KEY_<NAME>, then TULA_SECRET_KEY.',
  },
  prune: {
    type: 'boolean',
    description:
      'Delete providers, and remove webhook endpoints, hooks and native apps, that the server has and the file does not list (default: leave them). A file with no webhooks list keeps every endpoint, one with no hooks key every hook, and one with no nativeApps list every app.',
  },
  'rotate-secrets': {
    type: 'boolean',
    description: 'Send every managed provider’s secret again, changed or not.',
  },
  json: { type: 'boolean', description: 'Print the plan as JSON.' },
} as const satisfies Record<string, OptionSpec>

/** Everything `diff` and `apply` need once the config is loaded and the server read. */
export interface Prepared {
  /** The environment's name in the config. */
  name: string
  /** The environment's entry in the config. */
  environment: EnvironmentConfig
  /** The API and the admin client. */
  target: Target
  /** The plan. */
  plan: Plan
}

/**
 * Read an environment's settings (with their revision and manager), its providers and, when
 * the config manages them, its webhook endpoints, its hooks and its native apps.
 *
 * @param admin - The admin client.
 * @param options - `webhooks`, `hooks`, `nativeApps`: whether to read the webhook endpoints,
 *   the hooks and the native apps.
 * @returns The server's state.
 */
export async function readRemote(
  admin: AdminClient,
  options: { webhooks: boolean; hooks: boolean; nativeApps?: boolean }
): Promise<RemoteState> {
  const settings = await admin.call('getEnvironmentSettings')
  const providers = await admin.call('listOAuthProviders')
  // Only for a config that manages them: a file without a `webhooks` list asks nothing about
  // the endpoints, and so also runs against a server that has no such route yet.
  const webhooks = options.webhooks
    ? (await admin.call('listWebhookEndpoints')).data.data
    : undefined
  // The same for hooks: read only for a config that has a `hooks` key.
  const hooks = options.hooks ? (await admin.call('listHooks')).data.data : undefined
  // And for native apps: read only for a config that has a `nativeApps` list.
  const nativeApps = options.nativeApps ? (await admin.call('listNativeApps')).data.data : undefined
  // An older server does not report a manager: the field is then absent, not null.
  const managedBy = (settings.data as { managedBy?: SettingsManagedBy | null }).managedBy
  return {
    revision: settings.data.revision,
    // The API answers the whole document; the generated type marks defaulted fields optional.
    settings: settings.data.settings as unknown as EnvironmentSettings,
    managedBy,
    providers: providers.data.data,
    ...(webhooks !== undefined && { webhooks }),
    ...(hooks !== undefined && { hooks }),
    ...(nativeApps !== undefined && { nativeApps }),
  }
}

/**
 * Whether a refused count is the answer of a server from before the count: the API's own
 * answer for a route it does not have, which is a 404 in the contract's error envelope
 * with the code `resource.not_found` (`notFound` in the API's handlers; it never answers
 * 405).
 *
 * Nothing else is "this server has no count". A 404 or a 405 with another code, with a
 * page or with no body is something in front of the API speaking (a proxy, an access
 * wall), and says nothing about the server: like a refusal, a limit, a failure and no
 * answer at all it is a count that exists and was not read. The admin client gives an
 * answer that is not the envelope the code `response.invalid`, so the code alone tells.
 */
function isUnknownRoute(error: { status: number; code: string }): boolean {
  return error.status === 404 && error.code === 'resource.not_found'
}

/**
 * Ask the server how many accounts depend on each of some providers: the ones a run would
 * switch off or remove, and no other (ADR 0059).
 *
 * A count that cannot be had is never zero and never the run's failure, and it is one of
 * two things. A server from before the route (it answers its own 404 for an unknown route,
 * {@link isUnknownRoute}) has no count to give: `null`, and the plan judges nothing for
 * that provider. Anything else (a refusal, a limit, a server's failure, no answer, an
 * answer of another shape, a 404 or 405 that is not the API's own) is a count that exists and was
 * not read: `'unread'`, and the plan is flagged, so that `tula apply --yes` is not let
 * through by a request that failed. Nothing of the failure is kept.
 *
 * @param admin - The admin client.
 * @param providers - The providers to ask about.
 * @returns What is known of each: a count, `'unread'` or `null`.
 */
export async function readDependents(
  admin: AdminClient,
  providers: readonly OAuthProvider[]
): Promise<RemoteDependents> {
  const dependents: RemoteDependents = {}
  for (const provider of providers) {
    try {
      const answer = await admin.call('getOAuthProviderDependents', { params: { provider } })
      // An answer that is no count is not a server without one: it had something to say.
      dependents[provider] = readDependentCount(provider, answer.data) ?? DEPENDENTS_UNREAD
    } catch (error) {
      if (!isTulaAdminError(error)) {
        throw error
      }
      dependents[provider] = isUnknownRoute(error) ? null : DEPENDENTS_UNREAD
    }
  }
  return dependents
}

/**
 * Load the config, pick the environment, connect and make the plan: what `diff` prints and
 * `apply` executes.
 *
 * @param context - The command's context.
 * @returns The environment, the target and the plan.
 */
export async function prepare(context: CommandContext): Promise<Prepared> {
  const { flags, io, output } = context
  const path = typeof flags.config === 'string' ? flags.config : DEFAULT_CONFIG_FILE
  const { config } = await loadConfig(path, io.cwd)
  const requested = typeof flags.env === 'string' ? flags.env : undefined
  const environment = selectEnvironment(config, requested)
  const name = requested ?? (Object.keys(config.environments)[0] as string)
  const target = await resolveTarget({ name, environment, flags, io, output })
  const remote = await readRemote(target.admin, {
    webhooks: environment.webhooks !== undefined,
    hooks: environment.hooks !== undefined,
    nativeApps: environment.nativeApps !== undefined,
  })
  const prune = flags.prune === true
  // Counted only for the providers this run takes away from sign-in, before the plan is
  // made: the engine is handed the numbers and asks nothing itself.
  const dependents = await readDependents(
    target.admin,
    providersGoingOff(remote.providers, environment.providers, { prune })
  )
  const plan = buildPlan({ ...remote, dependents }, environment, {
    configHash: await hashEnvironmentConfig(environment),
    prune,
    rotateSecrets: flags['rotate-secrets'] === true,
  })
  return { name, environment, target, plan }
}
