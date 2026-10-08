import type { AdminClient } from '@tula/admin'
import {
  DEFAULT_CONFIG_FILE,
  type EnvironmentConfig,
  hashEnvironmentConfig,
  loadConfig,
  selectEnvironment,
} from '@tula/config'
import type { EnvironmentSettings, SettingsManagedBy } from '@tula/contract'
import type { OptionSpec } from '../args'
import { buildPlan, type Plan, type RemoteState } from '../diff'
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
      'Delete providers, and remove webhook endpoints, that the server has and the file does not list (default: leave them). A file with no webhooks list keeps every endpoint.',
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
 * the config manages them, its webhook endpoints.
 *
 * @param admin - The admin client.
 * @param options - `webhooks`: whether to read the webhook endpoints too.
 * @returns The server's state.
 */
export async function readRemote(
  admin: AdminClient,
  options: { webhooks: boolean }
): Promise<RemoteState> {
  const settings = await admin.call('getEnvironmentSettings')
  const providers = await admin.call('listOAuthProviders')
  // Only for a config that manages them: a file without a `webhooks` list asks nothing about
  // the endpoints, and so also runs against a server that has no such route yet.
  const webhooks = options.webhooks
    ? (await admin.call('listWebhookEndpoints')).data.data
    : undefined
  // An older server does not report a manager: the field is then absent, not null.
  const managedBy = (settings.data as { managedBy?: SettingsManagedBy | null }).managedBy
  return {
    revision: settings.data.revision,
    // The API answers the whole document; the generated type marks defaulted fields optional.
    settings: settings.data.settings as unknown as EnvironmentSettings,
    managedBy,
    providers: providers.data.data,
    ...(webhooks !== undefined && { webhooks }),
  }
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
  const remote = await readRemote(target.admin, { webhooks: environment.webhooks !== undefined })
  const plan = buildPlan(remote, environment, {
    configHash: await hashEnvironmentConfig(environment),
    prune: flags.prune === true,
    rotateSecrets: flags['rotate-secrets'] === true,
  })
  return { name, environment, target, plan }
}
