import { SCIM_TOKEN_PREFIX } from '@tula-tech/contract'
import type { Deps, Tenant } from '~/dependencies'
import { ConflictError, NotFoundError } from '~/exceptions'
import type { Actor } from '~/lib/actor'
import { randomToken, sha256Hex } from '~/lib/crypto'
import * as Audit from '~/modules/audit/service'
import * as Organizations from '~/modules/organization/service'
import type { ScimTokenRecord } from '~/ports/scim-store'

// SCIM tokens (ADR 0067, "SCIM"): the admin side. What a token opens is `modules/scim`.

/** Most live (not revoked) tokens one organization may hold: a rotation needs two, not fifty. */
export const MAX_LIVE_TOKENS = 10

/** Characters of the token kept for the list: the prefix and the start of the environment. */
const PREFIX_LENGTH = SCIM_TOKEN_PREFIX.length + 4

/** The 32 hex digits of an environment id, which is how a token names its environment. */
const hexOf = (environmentId: string) => environmentId.replaceAll('-', '')

/**
 * The environment a presented SCIM token names, read from the token itself.
 *
 * The token table is behind row-level security, so the lookup needs the environment first;
 * a made-up one finds nothing there. Nothing is trusted from this: the hash decides.
 *
 * @param presented - The raw bearer token.
 * @returns The environment id, or `null` when the token is not shaped like one of ours.
 */
export function environmentOf(presented: string): string | null {
  const match = /^tula_scim_([0-9a-f]{32})_[A-Za-z0-9_-]{20,}$/.exec(presented)
  const hex = match?.[1]
  return hex
    ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    : null
}

/** A token as the admin routes show it: never the secret, never its hash. */
export interface ScimTokenView {
  id: string
  organizationId: string
  name: string
  prefix: string
  lastUsedAt: string | null
  revokedAt: string | null
  createdAt: string
}

function view(record: ScimTokenRecord): ScimTokenView {
  return {
    id: record.id,
    organizationId: record.organizationId,
    name: record.name,
    prefix: record.prefix,
    lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
    revokedAt: record.revokedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
  }
}

async function requireOrganization(
  deps: Pick<Deps, 'organizations' | 'environmentSettings' | 'config'>,
  tenant: Pick<Tenant, 'environmentId'>,
  organizationId: string
): Promise<void> {
  await Organizations.requireEnabled(deps, tenant)
  if (!(await deps.organizations.find(tenant.environmentId, organizationId))) {
    throw new NotFoundError()
  }
}

/**
 * List an organization's SCIM tokens, revoked ones included, newest first.
 *
 * @param deps - Stores and settings.
 * @param tenant - The environment.
 * @param organizationId - The organization.
 * @returns The tokens, without secrets.
 * @throws AuthError `organization.disabled`; NotFoundError for another environment's organization.
 */
export async function list(
  deps: Pick<Deps, 'scim' | 'organizations' | 'environmentSettings' | 'config'>,
  tenant: Pick<Tenant, 'environmentId'>,
  organizationId: string
): Promise<ScimTokenView[]> {
  await requireOrganization(deps, tenant, organizationId)
  return (await deps.scim.listTokens(tenant.environmentId, organizationId)).map(view)
}

/**
 * Create a SCIM token. The secret is returned here and never again; only its hash is stored.
 *
 * @param deps - Stores, ids, clock and settings.
 * @param tenant - The environment.
 * @param input - The organization and a name for the identity provider it is given to.
 * @param actor - Who asked.
 * @returns The token's view and the secret.
 * @throws ConflictError when the organization already holds {@link MAX_LIVE_TOKENS}.
 */
export async function create(
  deps: Pick<Deps, 'scim' | 'organizations' | 'environmentSettings' | 'config' | 'ids' | 'clock'>,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  input: { organizationId: string; name: string },
  actor: Actor
): Promise<ScimTokenView & { token: string }> {
  await requireOrganization(deps, tenant, input.organizationId)
  const live = (await deps.scim.listTokens(tenant.environmentId, input.organizationId)).filter(
    (one) => one.revokedAt === null
  )
  if (live.length >= MAX_LIVE_TOKENS) {
    throw new ConflictError({ message: 'The organization holds the most SCIM tokens allowed.' })
  }
  const token = `${SCIM_TOKEN_PREFIX}${hexOf(tenant.environmentId)}_${randomToken()}`
  const id = deps.ids.next()
  const activity = Audit.entry(deps, tenant, {
    type: 'scim_token.created',
    actor,
    target: { type: 'scim_token', id },
    data: { organizationId: input.organizationId },
  })
  const record: ScimTokenRecord = {
    id,
    projectId: tenant.projectId,
    environmentId: tenant.environmentId,
    organizationId: input.organizationId,
    name: input.name,
    prefix: token.slice(0, PREFIX_LENGTH),
    tokenHash: sha256Hex(token),
    lastUsedAt: null,
    revokedAt: null,
    createdAt: activity.occurredAt,
    updatedAt: activity.occurredAt,
  }
  await deps.scim.insertToken(record, activity)
  return { ...view(record), token }
}

/**
 * Revoke a token: the identity provider holding it is refused from the next request.
 *
 * @param deps - Stores, clock and settings.
 * @param tenant - The environment.
 * @param organizationId - The organization the token belongs to.
 * @param id - The token.
 * @param actor - Who asked.
 * @throws NotFoundError when the token is missing, another organization's or already revoked.
 */
export async function revoke(
  deps: Pick<Deps, 'scim' | 'organizations' | 'environmentSettings' | 'config' | 'ids' | 'clock'>,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  organizationId: string,
  id: string,
  actor: Actor
): Promise<void> {
  await requireOrganization(deps, tenant, organizationId)
  const activity = Audit.entry(deps, tenant, {
    type: 'scim_token.revoked',
    actor,
    target: { type: 'scim_token', id },
    data: { organizationId },
  })
  const revoked = await deps.scim.revokeToken(
    tenant.environmentId,
    organizationId,
    id,
    activity.occurredAt,
    activity
  )
  if (!revoked) {
    throw new NotFoundError()
  }
}
