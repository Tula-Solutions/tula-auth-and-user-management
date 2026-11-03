import {
  type CreatedSetupLink,
  SETUP_LINK_TOKEN_PREFIX,
  type SetupLink,
  SSO_MANAGE_PERMISSION,
} from '@tula-tech/contract'
import type { Deps, Tenant } from '~/dependencies'
import { AuthError, ConflictError, ForbiddenError, NotFoundError } from '~/exceptions'
import type { Actor } from '~/lib/actor'
import { randomToken, sha256Hex } from '~/lib/crypto'
import { publicBase } from '~/lib/public-base'
import * as Audit from '~/modules/audit/service'
import * as SsoConnections from '~/modules/sso-connection/service'
import type { SetupLinkRecord } from '~/ports/setup-link-store'

// Setup links (ADR 0067, "Setup links"): the side of an operator or an organization's
// administrator, who makes, lists and revokes them. What a link opens is `./portal`.

const DAY_MS = 86_400_000

/** Most live (not revoked, not expired) links one organization may hold. */
export const MAX_LIVE_LINKS = 10

/** Characters of the token kept for the list: the prefix and the start of the environment. */
const PREFIX_LENGTH = SETUP_LINK_TOKEN_PREFIX.length + 4

/** The path of the portal page in the dashboard build the API serves. */
export const PORTAL_PATH = '/dashboard/setup'

/** The 32 hex digits of an environment id, which is how a token names its environment. */
const hexOf = (environmentId: string) => environmentId.replaceAll('-', '')

/**
 * The environment a presented setup token names, read from the token itself.
 *
 * The table is behind row-level security, so the lookup needs the environment first; a made-up
 * one finds nothing there. Nothing is trusted from this: the hash decides.
 *
 * @param presented - The raw token from the `x-tula-setup-token` header.
 * @returns The environment id, or `null` when the token is not shaped like one of ours.
 */
export function environmentOf(presented: string): string | null {
  const match = /^tula_setup_([0-9a-f]{32})_[A-Za-z0-9_-]{20,}$/.exec(presented)
  const hex = match?.[1]
  return hex
    ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    : null
}

function view(record: SetupLinkRecord): SetupLink {
  return {
    id: record.id,
    organizationId: record.organizationId,
    name: record.name,
    prefix: record.prefix,
    expiresAt: record.expiresAt.toISOString(),
    revokedAt: record.revokedAt?.toISOString() ?? null,
    lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
  }
}

async function requireOrganization(
  deps: Pick<Deps, 'organizations' | 'environmentSettings' | 'config'>,
  tenant: Pick<Tenant, 'environmentId'>,
  organizationId: string
): Promise<void> {
  await SsoConnections.requireEnabled(deps, tenant)
  if (!(await deps.organizations.find(tenant.environmentId, organizationId))) {
    throw new NotFoundError()
  }
}

/**
 * Let a signed-in user manage an organization's setup links: a member whose role, **as stored
 * now**, holds `org:sys:sso:manage`. Never read from the token: a demotion takes effect at once.
 *
 * @param deps - The organization store.
 * @param scope - The environment.
 * @param userId - The signed-in user.
 * @param organizationId - The organization.
 * @throws AuthError `organization.not_a_member` for a user who does not belong to it, and for
 *   an organization that does not exist or is another environment's alike.
 * @throws ForbiddenError (`auth.forbidden`) for a member without the permission.
 */
export async function requireManager(
  deps: Pick<Deps, 'organizations'>,
  scope: Pick<Tenant, 'environmentId'>,
  userId: string,
  organizationId: string
): Promise<void> {
  const held = await deps.organizations.findUserMembership(
    scope.environmentId,
    organizationId,
    userId
  )
  if (!held) {
    throw new AuthError('organization.not_a_member')
  }
  if (!held.permissions.includes(SSO_MANAGE_PERMISSION)) {
    throw new ForbiddenError()
  }
}

/**
 * List an organization's setup links, revoked and expired ones included, newest first.
 *
 * @param deps - Stores and settings.
 * @param tenant - The environment.
 * @param organizationId - The organization.
 * @returns The links, never with a token.
 * @throws AuthError `sso.disabled`, `organization.disabled`; NotFoundError for another
 *   environment's organization.
 */
export async function list(
  deps: Pick<Deps, 'setupLinks' | 'organizations' | 'environmentSettings' | 'config'>,
  tenant: Pick<Tenant, 'environmentId'>,
  organizationId: string
): Promise<SetupLink[]> {
  await requireOrganization(deps, tenant, organizationId)
  return (await deps.setupLinks.list(tenant.environmentId, organizationId)).map(view)
}

/**
 * Create a setup link. The token is returned here and never again; only its hash is stored.
 *
 * The address is built by the server from `PUBLIC_URL`, with the token in its fragment, so that
 * the token is not sent to a server, a log or a `Referer` by opening the page. No client builds
 * it from `window.location`.
 *
 * @param deps - Stores, ids, clock and settings.
 * @param tenant - The environment.
 * @param input - The organization, a name and how many days the link lives.
 * @param actor - Who asked.
 * @returns The link's view, the token and the address.
 * @throws ConflictError when the organization already holds {@link MAX_LIVE_LINKS}.
 */
export async function create(
  deps: Pick<
    Deps,
    'setupLinks' | 'organizations' | 'environmentSettings' | 'config' | 'ids' | 'clock'
  >,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  input: { organizationId: string; name: string; expiresInDays: number },
  actor: Actor
): Promise<CreatedSetupLink> {
  await requireOrganization(deps, tenant, input.organizationId)
  const now = deps.clock.now()
  const live = (await deps.setupLinks.list(tenant.environmentId, input.organizationId)).filter(
    (one) => one.revokedAt === null && one.expiresAt.getTime() > now.getTime()
  )
  if (live.length >= MAX_LIVE_LINKS) {
    throw new ConflictError({ message: 'The organization holds the most setup links allowed.' })
  }
  const token = `${SETUP_LINK_TOKEN_PREFIX}${hexOf(tenant.environmentId)}_${randomToken()}`
  const id = deps.ids.next()
  const activity = Audit.entry(deps, tenant, {
    type: 'setup_link.created',
    actor,
    target: { type: 'setup_link', id },
    data: { organizationId: input.organizationId },
  })
  const record: SetupLinkRecord = {
    id,
    projectId: tenant.projectId,
    environmentId: tenant.environmentId,
    organizationId: input.organizationId,
    name: input.name,
    prefix: token.slice(0, PREFIX_LENGTH),
    tokenHash: sha256Hex(token),
    expiresAt: new Date(activity.occurredAt.getTime() + input.expiresInDays * DAY_MS),
    revokedAt: null,
    lastUsedAt: null,
    createdByType: actor.type,
    createdById: actor.id,
    createdAt: activity.occurredAt,
    updatedAt: activity.occurredAt,
  }
  await deps.setupLinks.insert(record, activity)
  const base = publicBase(deps.config)
  return { ...view(record), token, url: `${base}${PORTAL_PATH}#token=${token}` }
}

/**
 * Revoke a link: whoever holds it is refused from the next request.
 *
 * @param deps - Stores, clock and settings.
 * @param tenant - The environment.
 * @param organizationId - The organization the link belongs to.
 * @param id - The link.
 * @param actor - Who asked.
 * @throws NotFoundError when the link is missing, another organization's or already revoked.
 */
export async function revoke(
  deps: Pick<
    Deps,
    'setupLinks' | 'organizations' | 'environmentSettings' | 'config' | 'ids' | 'clock'
  >,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  organizationId: string,
  id: string,
  actor: Actor
): Promise<void> {
  await requireOrganization(deps, tenant, organizationId)
  const activity = Audit.entry(deps, tenant, {
    type: 'setup_link.revoked',
    actor,
    target: { type: 'setup_link', id },
    data: { organizationId },
  })
  const revoked = await deps.setupLinks.revoke(
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
