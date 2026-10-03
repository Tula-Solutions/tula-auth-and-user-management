import { PUBLISHABLE_KEY_PREFIX, SECRET_KEY_PREFIX } from '@tula/contract'
import type { Deps, Tenant } from '~/dependencies'
import { ConflictError, NotFoundError } from '~/exceptions'
import type { Actor } from '~/lib/actor'
import { randomToken, sha256Hex } from '~/lib/crypto'
import * as Audit from '~/modules/audit/service'
import type {
  ApiKey,
  CreateApiKeyRequest,
  CreatedApiKey,
  Environment,
} from '~/modules/project/schema'
import type { ApiKeyKind } from '~/ports/api-key-repository'
import type { EnvironmentKind } from '~/ports/environment-repository'

/** The `<env>` segment of `tula_pk_<env>_…` keys, so a key shows where it belongs at a glance. */
export const KEY_ENVIRONMENT_SEGMENT: Readonly<Record<EnvironmentKind, string>> = {
  development: 'dev',
  production: 'prod',
}

/**
 * Most active (unrevoked) keys one environment may hold. Bounds the damage and cleanup if a
 * secret key leaks and is used to mint more.
 */
export const MAX_ACTIVE_KEYS = 100

/**
 * Most keys one environment may ever hold, revoked ones included. Revoked keys are kept (the API
 * cannot delete them), so without this a leaked secret key could create and revoke in a loop
 * and grow the table, and the key list, without limit.
 */
export const MAX_KEYS = 1_000

/**
 * Mint a new raw API key: prefix, environment segment, then 256 random bits.
 *
 * @param kind - Publishable or secret.
 * @param environment - The environment kind, for the readable segment.
 * @returns The full key, e.g. `tula_sk_prod_<43 base64url chars>`.
 */
export function generateKey(kind: ApiKeyKind, environment: EnvironmentKind): string {
  const prefix = kind === 'secret' ? SECRET_KEY_PREFIX : PUBLISHABLE_KEY_PREFIX
  return `${prefix}${KEY_ENVIRONMENT_SEGMENT[environment]}_${randomToken(32)}`
}

/**
 * List the environments of the project the request's key belongs to.
 *
 * @param deps - Environment repository.
 * @param tenant - The resolved tenant.
 * @returns The environments, development first.
 */
export function listEnvironments(
  deps: Pick<Deps, 'environments'>,
  tenant: Pick<Tenant, 'projectId'>
): Promise<Environment[]> {
  return deps.environments.listByProject(tenant.projectId)
}

/**
 * List the API keys of the request's environment, newest first, including revoked ones.
 *
 * @param deps - Key repository.
 * @param tenant - The resolved tenant.
 * @returns The keys (never the key values or hashes).
 */
export function listApiKeys(
  deps: Pick<Deps, 'apiKeys'>,
  tenant: Pick<Tenant, 'environmentId'>
): Promise<ApiKey[]> {
  return deps.apiKeys.listByEnvironment(tenant.environmentId)
}

/**
 * Create an API key in the request's environment.
 *
 * Only the SHA-256 hash is stored; the returned `key` is the one chance to read it.
 *
 * @param deps - Key and environment repositories, id generator and clock.
 * @param tenant - The environment to create the key in.
 * @param input - Kind and display name.
 * @param actor - Who is creating the key, for the audit log.
 * @returns The stored key plus the full key value.
 * @throws NotFoundError if the environment does not exist in the tenant's project.
 * @throws ConflictError when the environment already has {@link MAX_ACTIVE_KEYS} active keys, or
 *   {@link MAX_KEYS} keys in total.
 */
export async function createApiKey(
  deps: Pick<Deps, 'apiKeys' | 'environments' | 'ids' | 'clock'>,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  input: CreateApiKeyRequest,
  actor: Actor
): Promise<CreatedApiKey> {
  const environment = await deps.environments.findById(tenant.environmentId)
  if (!environment || environment.projectId !== tenant.projectId) {
    throw new NotFoundError({ internalMessage: 'environment missing or in another project' })
  }
  // Soft caps: two concurrent creates at a limit can both pass, which is acceptable here.
  // Counted in the database, so the check costs the same however many keys were ever made.
  const { active, total } = await deps.apiKeys.countByEnvironment(environment.id)
  if (active >= MAX_ACTIVE_KEYS) {
    throw new ConflictError({
      message: `This environment already has ${MAX_ACTIVE_KEYS} active keys. Revoke one first.`,
      params: { max: MAX_ACTIVE_KEYS },
    })
  }
  if (total >= MAX_KEYS) {
    throw new ConflictError({
      message: `This environment has had ${MAX_KEYS} keys, the most it can hold. Remove old revoked keys from the database to create more.`,
      params: { max: MAX_KEYS },
    })
  }
  const key = generateKey(input.kind, environment.kind)
  const id = deps.ids.next()
  const record = await deps.apiKeys.insert(
    {
      id,
      kind: input.kind,
      name: input.name,
      projectId: environment.projectId,
      environmentId: environment.id,
      lastFour: key.slice(-4),
      createdAt: deps.clock.now(),
      keyHash: sha256Hex(key),
    },
    Audit.entry(deps, tenant, {
      type: 'api_key.created',
      actor,
      target: { type: 'api_key', id },
      data: { kind: input.kind },
    })
  )
  return { ...record, key }
}

/**
 * Revoke an API key in the request's environment. Idempotent.
 *
 * The key making the request cannot revoke itself: rotate by creating a new key, switching to
 * it, then revoking the old one with the new key.
 *
 * @param deps - Key repository, ids and clock.
 * @param tenant - The resolved tenant, including the requesting key.
 * @param id - The key to revoke.
 * @param actor - Who is revoking it, for the audit log.
 * @returns The revoked key.
 * @throws ConflictError when `id` is the requesting key.
 * @throws NotFoundError when no key with that id exists in this environment.
 */
export async function revokeApiKey(
  deps: Pick<Deps, 'apiKeys' | 'clock' | 'ids'>,
  tenant: Tenant,
  id: string,
  actor: Actor
): Promise<ApiKey> {
  if (id === tenant.apiKeyId) {
    throw new ConflictError({
      message: 'A key cannot revoke itself. Create a new key and revoke this one with it.',
    })
  }
  const revoked = await deps.apiKeys.revoke(
    tenant.environmentId,
    id,
    deps.clock.now(),
    Audit.entry(deps, tenant, { type: 'api_key.revoked', actor, target: { type: 'api_key', id } })
  )
  if (!revoked) {
    throw new NotFoundError()
  }
  return revoked
}
