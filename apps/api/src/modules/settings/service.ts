import {
  type ClientConfig,
  DEFAULT_ENVIRONMENT_SETTINGS,
  type EnvironmentSettings,
  type SignInMethod,
} from '@tula/contract'
import type { AppConfig, Deps, Tenant } from '~/dependencies'
import { AuthError, ServiceException } from '~/exceptions'
import type { Actor } from '~/lib/actor'
import * as Audit from '~/modules/audit/service'
import type { EnvironmentSettingsState } from '~/modules/settings/schema'

type ReadDeps = Pick<Deps, 'environmentSettings' | 'config'>

/**
 * The settings of an environment that has saved none: the contract's defaults, with the
 * deployment's `PASSWORD_POLICY` and `CORS_ORIGINS`.
 *
 * Those two variables are **defaults, not overrides**: once an environment saves settings, its
 * own document is the whole truth and the variables no longer apply to it. `CORS_ORIGINS` is
 * taken as written, so a default list can hold an entry the settings API would refuse (plain
 * `http` for a non-local host); it has to be fixed when the document is first saved.
 *
 * @param config - The deployment's configuration.
 * @returns The default document.
 */
export function defaults(
  config: Pick<AppConfig, 'passwordPolicy' | 'corsOrigins'>
): EnvironmentSettings {
  return {
    ...DEFAULT_ENVIRONMENT_SETTINGS,
    password: config.passwordPolicy,
    urls: { ...DEFAULT_ENVIRONMENT_SETTINGS.urls, allowedOrigins: [...config.corsOrigins] },
  }
}

async function read(
  deps: ReadDeps,
  tenant: Pick<Tenant, 'environmentId'>,
  fresh: boolean
): Promise<EnvironmentSettingsState> {
  const stored = await deps.environmentSettings.get(tenant.environmentId, fresh)
  return stored ?? { revision: 0, settings: defaults(deps.config) }
}

/**
 * An environment's settings and their revision.
 *
 * By default served from this instance's cache, so they can trail a change made on another
 * instance by the bound documented on `cacheEnvironmentSettings`.
 *
 * @param deps - Settings store and config.
 * @param tenant - The environment.
 * @param fresh - `true` to read past the cache, so the revision is the one a replace will be
 *   checked against. The admin API reads this way; request paths do not.
 * @returns The saved settings, or revision 0 with the {@link defaults}. Do not mutate the result.
 */
export function get(
  deps: ReadDeps,
  tenant: Pick<Tenant, 'environmentId'>,
  fresh = false
): Promise<EnvironmentSettingsState> {
  return read(deps, tenant, fresh)
}

/**
 * The settings that apply in an environment right now. What every other module reads.
 *
 * @param deps - Settings store and config.
 * @param tenant - The environment.
 * @returns The settings. Do not mutate the result.
 *
 * @example
 * ```ts
 * const { password } = await Settings.current(deps, tenant)
 * ```
 */
export async function current(
  deps: ReadDeps,
  tenant: Pick<Tenant, 'environmentId'>
): Promise<EnvironmentSettings> {
  return (await read(deps, tenant, false)).settings
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function flatten(value: unknown, path: string, into: Map<string, string>): void {
  if (!isRecord(value)) {
    // Lists are compared whole: "the allowed origins changed", not which entry.
    into.set(path, JSON.stringify(value))
    return
  }
  for (const [key, child] of Object.entries(value)) {
    flatten(child, path ? `${path}.${key}` : key, into)
  }
}

/**
 * Which settings differ between two documents, as dotted keys.
 *
 * Only the keys: this is what the audit log records, and a value can be something an operator
 * would not want copied there (an origin list, a support address).
 *
 * @param before - The document being replaced.
 * @param after - The new document.
 * @returns The changed keys, sorted, e.g. `['password.minLength', 'urls.allowedOrigins']`.
 */
export function changedKeys(before: EnvironmentSettings, after: EnvironmentSettings): string[] {
  const [was, is] = [new Map<string, string>(), new Map<string, string>()]
  flatten(before, '', was)
  flatten(after, '', is)
  return [...new Set([...was.keys(), ...is.keys()])]
    .filter((key) => was.get(key) !== is.get(key))
    .sort()
}

/** A replace of an environment's settings. */
export interface ReplaceInput {
  /** The revision the caller read, from `If-Match`. */
  expectedRevision: number
  /** The whole new document, already validated. */
  settings: EnvironmentSettings
}

/**
 * Replace an environment's settings, if they are still at the revision the caller read.
 *
 * The change is recorded as `environment.settings_updated` in the same transaction, with the
 * keys that changed and never their values. A document identical to the current one changes
 * nothing: no new revision and no audit entry.
 *
 * @param deps - Settings store, config, ids and clock.
 * @param tenant - The environment.
 * @param input - The revision being replaced and the new document.
 * @param actor - Who is changing the settings, for the audit log.
 * @returns The settings now in force and their revision.
 * @throws ServiceException `precondition.failed` (412) when the settings are no longer at
 *   `expectedRevision`; `params.revision` is the current one.
 */
export async function replace(
  deps: ReadDeps & Pick<Deps, 'ids' | 'clock'>,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  input: ReplaceInput,
  actor: Actor
): Promise<EnvironmentSettingsState> {
  // Read past the cache: both the revision check and the list of changed keys must be made
  // against what is really stored, not against what this instance last saw.
  const before = await read(deps, tenant, true)
  if (before.revision !== input.expectedRevision) {
    throw new ServiceException('precondition.failed', { params: { revision: before.revision } })
  }
  const changed = changedKeys(before.settings, input.settings)
  if (changed.length === 0) {
    return before
  }
  const replaced = await deps.environmentSettings.replace(
    tenant.environmentId,
    input.expectedRevision,
    input.settings,
    deps.clock.now(),
    Audit.entry(deps, tenant, {
      type: 'environment.settings_updated',
      actor,
      target: { type: 'environment', id: tenant.environmentId },
      data: { revision: input.expectedRevision + 1, changed },
    })
  )
  if (!replaced) {
    // Another writer got in between the read and the write.
    throw new ServiceException('precondition.failed')
  }
  return replaced
}

/**
 * Read the revision out of an `If-Match` header.
 *
 * The header must be the quoted revision exactly as `ETag` gave it, e.g. `"3"`. `*` and weak
 * validators are not accepted: either would let a write through without naming what it replaces.
 *
 * @param header - The header value, if present.
 * @returns The revision the caller expects.
 * @throws ServiceException `precondition.required` (428) when the header is missing, or
 *   `precondition.failed` (412) when it is not a quoted revision (it cannot match any).
 */
export function expectedRevision(header: string | undefined): number {
  if (header === undefined || header.trim() === '') {
    throw new ServiceException('precondition.required')
  }
  const matched = /^"(0|[1-9][0-9]{0,8})"$/.exec(header.trim())
  if (!matched) {
    throw new ServiceException('precondition.failed')
  }
  return Number(matched[1])
}

/**
 * The `ETag` of a settings revision.
 *
 * @param revision - The revision.
 * @returns The quoted revision, e.g. `"3"`.
 */
export function etag(revision: number): string {
  return `"${revision}"`
}

/**
 * What a client may know about an environment: enough to draw a sign-in screen.
 *
 * @param settings - The environment's settings.
 * @returns App name and support address, enabled sign-in methods and the password policy.
 */
export function clientConfig(settings: EnvironmentSettings): ClientConfig {
  return {
    app: { name: settings.app.name, supportEmail: settings.app.supportEmail },
    signIn: {
      methods: Object.entries(settings.signIn.methods)
        .filter(([, method]) => method.enabled)
        .map(([name]) => name),
    },
    password: settings.password,
  }
}

/**
 * Refuse a request for a sign-in method the environment has switched off.
 *
 * The one place a method's switch is checked: every flow that starts with a given method calls
 * this first, before it looks at the identifier, so the answer says nothing about any account.
 *
 * @param deps - Settings store and config.
 * @param tenant - The environment.
 * @param method - The method the request uses.
 * @throws AuthError `auth.method_disabled` (403) when the method is not enabled.
 */
export async function requireMethod(
  deps: ReadDeps,
  tenant: Pick<Tenant, 'environmentId'>,
  method: SignInMethod
): Promise<void> {
  const { signIn } = await current(deps, tenant)
  if (!signIn.methods[method].enabled) {
    throw new AuthError('auth.method_disabled', { method })
  }
}
