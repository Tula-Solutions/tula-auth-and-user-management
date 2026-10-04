import type { AdminSchemas } from '@tula/admin'
import { type EnvironmentConfig, providerSecret } from '@tula/config'
import {
  type EnvironmentSettings,
  type EnvironmentSettingsInput,
  hasEnabledSignInMethod,
  OAUTH_PROVIDERS,
  type OAuthProvider,
  parseStoredEnvironmentSettings,
  type SettingsManagedBy,
  settingsWeakenings,
} from '@tula/contract'

/**
 * The name `tula apply` records itself under as the manager of an environment's settings.
 *
 * @example
 * ```ts
 * headers['x-tula-managed-by'] = MANAGING_TOOL
 * ```
 */
export const MANAGING_TOOL = 'tula-apply'

/**
 * Lists in the settings document that are **sets**: their order means nothing to the server
 * (an origin is allowed or it is not), so a reordering is not a change, and a change is shown
 * as the entries added and removed. Every other list is compared in order.
 *
 * @example
 * ```ts
 * diffValues(current, desired, SET_PATHS)
 * ```
 */
export const SET_PATHS: readonly string[] = ['urls.allowedOrigins', 'urls.allowedRedirectUrls']

/**
 * Maps whose entries are whole things with a name (a session profile): one that appears or
 * disappears is shown as added or removed. Everywhere else a key the server has and the file's
 * schema does not is a setting this version of the CLI does not know.
 */
const NAMED_ENTRY_PATHS: readonly string[] = ['sessions.profiles']

/** The two settings whose default is the deployment's, which only the server knows. */
const DEPLOYMENT_DEFAULTS = ['password', 'urls.allowedOrigins'] as const

/**
 * One difference between what a server has and what a config says.
 *
 * @example
 * ```ts
 * const change: Change = { path: 'app.name', kind: 'changed', before: 'Tula', after: 'Northline' }
 * ```
 */
export interface Change {
  /** Where, dot-separated. */
  path: string
  /** `added`: only the config has it. `removed`: only the server has it. `changed`: both do. */
  kind: 'added' | 'changed' | 'removed'
  /** The server's value. */
  before?: unknown
  /** The config's value. */
  after?: unknown
  /** For a list that is a set: the entries the config adds. */
  added?: unknown[]
  /** For a list that is a set: the entries the config removes. */
  removed?: unknown[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function diffSets(path: string, before: unknown[], after: unknown[]): Change[] {
  const key = (value: unknown) => JSON.stringify(value)
  const had = new Set(before.map(key))
  const has = new Set(after.map(key))
  const added = after.filter(
    (value, index) =>
      !had.has(key(value)) && after.findIndex((other) => key(other) === key(value)) === index
  )
  const removed = before.filter(
    (value, index) =>
      !has.has(key(value)) && before.findIndex((other) => key(other) === key(value)) === index
  )
  return added.length === 0 && removed.length === 0
    ? []
    : [{ path, kind: 'changed', before, after, added, removed }]
}

function diffAt(
  path: string,
  before: unknown,
  after: unknown,
  setPaths: readonly string[]
): Change[] {
  if (before === undefined && after === undefined) {
    return []
  }
  if (before === undefined) {
    return [{ path, kind: 'added', after }]
  }
  if (after === undefined) {
    return [{ path, kind: 'removed', before }]
  }
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(after), ...Object.keys(before)])]
    return keys.flatMap((key) =>
      diffAt(path === '' ? key : `${path}.${key}`, before[key], after[key], setPaths)
    )
  }
  if (Array.isArray(before) && Array.isArray(after) && setPaths.includes(path)) {
    return diffSets(path, before, after)
  }
  return same(before, after) ? [] : [{ path, kind: 'changed', before, after }]
}

/**
 * The structural difference between two values, by path.
 *
 * Objects are compared key by key at any depth; a key only one side has is `added` or
 * `removed` as a whole. A list on one of `setPaths` is compared as a set; any other list, and
 * every scalar, by value. A key set to `undefined` counts as absent.
 *
 * @param before - What the server has.
 * @param after - What the config says.
 * @param setPaths - Paths of the lists that are sets.
 * @returns The changes, in the order of the config's keys; empty when there are none.
 *
 * @example
 * ```ts
 * diffValues({ app: { name: 'Tula' } }, { app: { name: 'Northline' } })
 * // [{ path: 'app.name', kind: 'changed', before: 'Tula', after: 'Northline' }]
 * ```
 */
export function diffValues(
  before: unknown,
  after: unknown,
  setPaths: readonly string[] = SET_PATHS
): Change[] {
  return diffAt('', before, after, setPaths)
}

/**
 * A provider as the admin API lists it.
 *
 * @example
 * ```ts
 * const { data } = await admin.call('listOAuthProviders')
 * const providers: RemoteProvider[] = data.data
 * ```
 */
export type RemoteProvider = AdminSchemas['OAuthProviderSettings']

/**
 * What a server has for one environment: its settings, their revision and manager, and its
 * providers.
 *
 * @example
 * ```ts
 * const state: RemoteState = { ...settingsResponse.data, providers: providersResponse.data.data }
 * ```
 */
export interface RemoteState {
  /** The settings' revision: what the replace is conditional on. */
  revision: number
  /** The settings document in force. */
  settings: EnvironmentSettings
  /** Who manages the settings; `null` for nobody; `undefined` from a server that does not say. */
  managedBy?: SettingsManagedBy | null
  /** Every provider, configured or not. */
  providers: readonly RemoteProvider[]
}

/**
 * What a run does with one provider.
 *
 * @example
 * ```ts
 * const change: ProviderChange = planProviders(remote.providers, environment.providers, {})[0]
 * ```
 */
export interface ProviderChange {
  /** The provider. */
  provider: OAuthProvider
  /**
   * `create`, `update`, `delete`; `none` when it already is as the config says; `unmanaged`
   * when the server has it and the config does not (left alone without `--prune`).
   */
  action: 'create' | 'update' | 'delete' | 'none' | 'unmanaged'
  /** The differences in its fields that are not secret: `clientId`, `teamId`, `keyId`, `enabled`. */
  fields: Change[]
  /**
   * What happens to its secret: `set` (written from the environment variable), `keep` (the
   * stored one stays) or `none` (there is none to speak of). Never the value.
   */
  secret: 'set' | 'keep' | 'none'
  /** The variable the secret is read from, when the config manages the provider. */
  secretEnv?: string
  /** Whether sign-in offers it now. */
  enabledBefore: boolean
  /** Whether sign-in offers it after the run. */
  enabledAfter: boolean
}

/** Options of a plan. */
export interface PlanOptions {
  /** Delete providers the server has and the config does not. */
  prune?: boolean
  /** Send every managed provider's secret again, changed or not. */
  rotateSecrets?: boolean
}

/** The non-secret fields of a provider in a config, in display order. */
function providerFields(
  provider: OAuthProvider,
  providers: EnvironmentConfig['providers']
): Record<string, unknown> | undefined {
  if (provider === 'apple') {
    const apple = providers.apple
    return (
      apple && {
        clientId: apple.clientId,
        teamId: apple.teamId,
        keyId: apple.keyId,
        enabled: apple.enabled,
      }
    )
  }
  const client = providers[provider]
  return client && { clientId: client.clientId, enabled: client.enabled }
}

/**
 * Decide what to do with each provider.
 *
 * A secret cannot be compared: the API never returns one. So it is written when the provider
 * is created, when one of its identifying fields changes (a new client id comes with a new
 * secret) and when `rotateSecrets` asks; switching a provider on or off keeps the stored one.
 * That is what makes a second run a no-op.
 *
 * @param remote - The providers as the server lists them.
 * @param desired - The providers of the config's environment.
 * @param options - `prune`, `rotateSecrets`.
 * @returns One entry per provider that the config or the server knows, by provider name.
 *
 * @example
 * ```ts
 * planProviders(remote.providers, environment.providers, { prune: true })
 * ```
 */
export function planProviders(
  remote: readonly RemoteProvider[],
  desired: EnvironmentConfig['providers'],
  options: PlanOptions
): ProviderChange[] {
  const plans: ProviderChange[] = []
  for (const provider of [...OAUTH_PROVIDERS].sort()) {
    const current = remote.find((entry) => entry.provider === provider)
    const configured = current?.configured === true
    const enabledBefore = configured && current.enabled
    const fields = providerFields(provider, desired)
    if (!fields) {
      if (configured) {
        plans.push({
          provider,
          action: options.prune ? 'delete' : 'unmanaged',
          fields: [],
          secret: 'none',
          enabledBefore,
          enabledAfter: options.prune ? false : enabledBefore,
        })
      }
      continue
    }
    const secretEnv = providerSecret(desired, provider)?.$env
    const enabledAfter = fields.enabled === true
    if (!configured) {
      plans.push({
        provider,
        action: 'create',
        fields: Object.entries(fields).map(([path, after]) => ({ path, kind: 'added', after })),
        secret: 'set',
        secretEnv,
        enabledBefore,
        enabledAfter,
      })
      continue
    }
    const changes = Object.entries(fields).flatMap(([path, after]): Change[] => {
      const before = (current as Record<string, unknown>)[path]
      return same(before, after) ? [] : [{ path, kind: 'changed', before, after }]
    })
    const identityChanged = changes.some((change) => change.path !== 'enabled')
    const secret = identityChanged || options.rotateSecrets ? 'set' : 'keep'
    plans.push({
      provider,
      action: changes.length > 0 || secret === 'set' ? 'update' : 'none',
      fields: changes,
      secret,
      secretEnv,
      enabledBefore,
      enabledAfter,
    })
  }
  return plans
}

/**
 * Whether the server records this config as the manager of the settings, and why not.
 *
 * @example
 * ```ts
 * if (plan.marker.reason === 'drifted') {
 *   warn('changed outside the config file')
 * }
 * ```
 */
export interface MarkerPlan {
  /** Whether the server reports a manager at all (an older one does not). */
  supported: boolean
  /** Whether a run would record this config as the manager. */
  pending: boolean
  /**
   * Why: `unmanaged` (nobody is on record), `other-tool`, `other-config` (another version of
   * the file was applied), `drifted` (the settings were replaced around the file since), or
   * `none` (it is on record, or the server does not record one).
   */
  reason: 'unmanaged' | 'other-tool' | 'other-config' | 'drifted' | 'none'
  /** The manager on record. */
  current: SettingsManagedBy | null
  /** This config's fingerprint. */
  configHash: string
}

/**
 * Everything a run would do to one environment.
 *
 * @example
 * ```ts
 * const plan: Plan = buildPlan(remote, environment, { configHash })
 * process.exitCode = plan.changes ? 2 : 0
 * ```
 */
export interface Plan {
  /** The settings revision the plan was made against. */
  revision: number
  /** The differences in the settings document. */
  settings: Change[]
  /** Paths where the settings get weaker (the contract's `settingsWeakenings`). */
  weakened: string[]
  /** Settings the file leaves out whose default is the deployment's: kept as the server has them. */
  kept: string[]
  /** Settings the server has that this version of the CLI does not know. */
  unknown: string[]
  /** What happens to each provider. */
  providers: ProviderChange[]
  /** Whether the server records this config as the settings' manager. */
  marker: MarkerPlan
  /** The document a replace would send. */
  body: EnvironmentSettingsInput
  /** Whether a run would change anything. */
  changes: boolean
}

function planMarker(remote: RemoteState, configHash: string): MarkerPlan {
  const current = remote.managedBy
  if (current === undefined) {
    return { supported: false, pending: false, reason: 'none', current: null, configHash }
  }
  const reason: MarkerPlan['reason'] =
    current === null
      ? 'unmanaged'
      : current.tool !== MANAGING_TOOL
        ? 'other-tool'
        : current.configHash !== configHash
          ? 'other-config'
          : current.drifted
            ? 'drifted'
            : 'none'
  return { supported: true, pending: reason !== 'none', reason, current, configHash }
}

function weakenings(before: unknown, after: unknown): string[] {
  try {
    return settingsWeakenings(
      parseStoredEnvironmentSettings(before),
      parseStoredEnvironmentSettings(after)
    )
  } catch {
    // A document this version cannot read as settings at all: nothing to compare. The
    // differences themselves are still listed.
    return []
  }
}

/**
 * Compare a server's state with a config's environment.
 *
 * The file is the whole truth for what it can express: a setting it leaves out goes back to
 * its default. The exceptions are the two settings whose default is the **deployment's**
 * (`password`, `urls.allowedOrigins`), which only the server knows: left out, they are kept as
 * the server has them and listed in `kept`.
 *
 * @param remote - What the server has.
 * @param environment - The config's environment.
 * @param options - The config's fingerprint, `prune`, `rotateSecrets`.
 * @returns The plan.
 *
 * @example
 * ```ts
 * const plan = buildPlan(remote, selectEnvironment(config, 'prod'), { configHash })
 * ```
 */
export function buildPlan(
  remote: RemoteState,
  environment: EnvironmentConfig,
  options: PlanOptions & { configHash: string }
): Plan {
  const kept: string[] = []
  const body: EnvironmentSettingsInput = structuredClone(environment.settings)
  if (body.password === undefined) {
    body.password = structuredClone(remote.settings.password)
    kept.push(DEPLOYMENT_DEFAULTS[0])
  }
  if (body.urls.allowedOrigins === undefined) {
    body.urls.allowedOrigins = [...remote.settings.urls.allowedOrigins]
    kept.push(DEPLOYMENT_DEFAULTS[1])
  }
  const settings = diffValues(remote.settings, body)
  const unknown = settings
    .filter(
      (change) =>
        change.kind === 'removed' &&
        !NAMED_ENTRY_PATHS.some((prefix) => change.path.startsWith(`${prefix}.`))
    )
    .map((change) => change.path)
  const providers = planProviders(remote.providers, environment.providers, options)
  const marker = planMarker(remote, options.configHash)
  return {
    revision: remote.revision,
    settings,
    weakened: weakenings(remote.settings, body),
    kept,
    unknown,
    providers,
    marker,
    body,
    changes:
      settings.length > 0 ||
      marker.pending ||
      providers.some((provider) => ['create', 'update', 'delete'].includes(provider.action)),
  }
}

/**
 * One write of a run.
 *
 * @example
 * ```ts
 * for (const operation of orderOperations(plan)) {
 *   await run(operation)
 * }
 * ```
 */
export type Operation =
  | { kind: 'settings' }
  | { kind: 'provider.set'; provider: OAuthProvider; change: ProviderChange }
  | { kind: 'provider.delete'; provider: OAuthProvider; change: ProviderChange }

/**
 * The writes of a plan, in an order in which every intermediate state is one the server
 * accepts.
 *
 * The server refuses to leave an environment with no way to sign in: its settings need a
 * native method (password, email code, passkey) or an enabled OAuth provider. So:
 *
 * 1. writes that add a way in or change none: creating a provider, enabling one, new
 *    credentials;
 * 2. writes that take one away: switching a provider off, then deleting providers.
 *
 * and the settings go **first** whenever the document they produce has a native method of its
 * own: nothing after them can then be refused for want of a way in, and a settings revision
 * that turned out stale stops the run before anything was written. Only when the file
 * switches every native method off do the settings wait for the providers they rely on.
 *
 * @param plan - The plan.
 * @returns The writes, in order; empty when the plan changes nothing.
 *
 * @example
 * ```ts
 * orderOperations(plan).map((operation) => operation.kind) // ['settings', 'provider.set']
 * ```
 */
export function orderOperations(plan: Plan): Operation[] {
  const settings: Operation[] =
    plan.settings.length > 0 || plan.marker.pending ? [{ kind: 'settings' }] : []
  const writes = plan.providers.filter(
    (change) => change.action === 'create' || change.action === 'update'
  )
  const takesAway = (change: ProviderChange) => change.enabledBefore && !change.enabledAfter
  const set = (change: ProviderChange): Operation => ({
    kind: 'provider.set',
    provider: change.provider,
    change,
  })
  const adding = writes.filter((change) => !takesAway(change)).map(set)
  const removing = writes.filter(takesAway).map(set)
  const deleting = plan.providers
    .filter((change) => change.action === 'delete')
    .map((change): Operation => ({ kind: 'provider.delete', provider: change.provider, change }))
  return hasEnabledSignInMethod(plan.body)
    ? [...settings, ...adding, ...removing, ...deleting]
    : [...adding, ...settings, ...removing, ...deleting]
}
