import { PUBLISHABLE_KEY_PREFIX, SECRET_KEY_PREFIX } from '@tula/contract'
import type { Deps, Tenant } from '~/dependencies'
import { ConflictError, NotFoundError } from '~/exceptions'
import { randomToken, sha256Hex } from '~/lib/crypto'
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
 * @returns The stored key plus the full key value.
 * @throws NotFoundError if the environment does not exist in the tenant's project.
 * @throws ConflictError when the environment already has {@link MAX_ACTIVE_KEYS} active keys.
 */
export async function createApiKey(
  deps: Pick<Deps, 'apiKeys' | 'environments' | 'ids' | 'clock'>,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  input: CreateApiKeyRequest
): Promise<CreatedApiKey> {
  const environment = await deps.environments.findById(tenant.environmentId)
  if (!environment || environment.projectId !== tenant.projectId) {
    throw new NotFoundError({ internalMessage: 'environment missing or in another project' })
  }
  // A soft cap: two concurrent creates at the limit can both pass, which is acceptable here.
  const existing = await deps.apiKeys.listByEnvironment(environment.id)
  if (existing.filter((key) => key.revokedAt === null).length >= MAX_ACTIVE_KEYS) {
    throw new ConflictError({
      message: `This environment already has ${MAX_ACTIVE_KEYS} active keys. Revoke one first.`,
      params: { max: MAX_ACTIVE_KEYS },
    })
  }
  const key = generateKey(input.kind, environment.kind)
  const record = await deps.apiKeys.insert({
    id: deps.ids.next(),
    kind: input.kind,
    name: input.name,
    projectId: environment.projectId,
    environmentId: environment.id,
    lastFour: key.slice(-4),
    createdAt: deps.clock.now(),
    keyHash: sha256Hex(key),
  })
  return { ...record, key }
}

/**
 * Revoke an API key in the request's environment. Idempotent.
 *
 * The key making the request cannot revoke itself: rotate by creating a new key, switching to
 * it, then revoking the old one with the new key.
 *
 * @param deps - Key repository and clock.
 * @param tenant - The resolved tenant, including the requesting key.
 * @param id - The key to revoke.
 * @returns The revoked key.
 * @throws ConflictError when `id` is the requesting key.
 * @throws NotFoundError when no key with that id exists in this environment.
 */
export async function revokeApiKey(
  deps: Pick<Deps, 'apiKeys' | 'clock'>,
  tenant: Tenant,
  id: string
): Promise<ApiKey> {
  if (id === tenant.apiKeyId) {
    throw new ConflictError({
      message: 'A key cannot revoke itself. Create a new key and revoke this one with it.',
    })
  }
  const revoked = await deps.apiKeys.revoke(tenant.environmentId, id, deps.clock.now())
  if (!revoked) {
    throw new NotFoundError()
  }
  return revoked
}
