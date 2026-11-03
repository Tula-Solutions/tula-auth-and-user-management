import type { Deps, Tenant } from '~/dependencies'
import { NotFoundError } from '~/exceptions'
import type { Actor } from '~/lib/actor'
import { parseEmail } from '~/lib/email'
import * as Audit from '~/modules/audit/service'
import * as Organizations from '~/modules/organization/service'
import { lapsed } from '~/modules/organization-domain/service'
import * as Users from '~/modules/user/service'
import type { ScimUserRecord } from '~/ports/scim-store'
import type { UserRecord } from '~/ports/user-repository'
import { invalidValue, ScimError, uniqueness } from './errors'
import { LIST_SCHEMA, type ScimUserInput, type ScimUserResource, USER_SCHEMA } from './schema'

// The SCIM Users resource (ADR 0067, "SCIM"). The directory is the organization's: it can
// provision, deactivate and remove its own people, and can never ban or delete an account it
// did not create or one that belongs to another organization as well.

/** The role a provisioned member gets; an operator changes it afterwards. */
const MEMBER_ROLE = 'member'

/** Most resources one list answers. */
export const MAX_COUNT = 200

/** Who a request acts for. */
export interface ScimContext {
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>
  organizationId: string
  actor: Actor
}

function resource(user: UserRecord, record: ScimUserRecord): ScimUserResource {
  return {
    schemas: [USER_SCHEMA],
    id: user.id,
    ...(record.externalId !== null && { externalId: record.externalId }),
    userName: user.email ?? '',
    name: {
      ...(user.firstName !== null && { givenName: user.firstName }),
      ...(user.lastName !== null && { familyName: user.lastName }),
    },
    emails: user.email === null ? [] : [{ value: user.email, primary: true }],
    active: record.active,
    meta: {
      resourceType: 'User',
      created: record.createdAt.toISOString(),
      lastModified: record.updatedAt.toISOString(),
    },
  }
}

/** The address a User names: `userName`, else the primary of `emails`. */
function emailOf(input: ScimUserInput) {
  const candidates = [
    input.userName,
    ...(input.emails ?? [])
      .sort((a, b) => Number(b.primary) - Number(a.primary))
      .map((e) => e.value),
  ]
  for (const candidate of candidates) {
    const parsed = parseEmail(candidate)
    if (parsed) {
      return parsed
    }
  }
  throw invalidValue('userName must be an email address.')
}

/** Whether the address is on a domain this organization has verified and not let lapse. */
async function onVerifiedDomain(deps: Deps, ctx: ScimContext, normalized: string) {
  const domain = normalized.slice(normalized.lastIndexOf('@') + 1)
  const row = await deps.organizationDomains.findVerified(ctx.tenant.environmentId, domain)
  return row !== null && row.organizationId === ctx.organizationId && !lapsed(row, deps.clock.now())
}

async function load(deps: Deps, ctx: ScimContext, userId: string) {
  const record = await deps.scim.findUser(ctx.tenant.environmentId, ctx.organizationId, userId)
  const user = record && (await deps.users.findById(ctx.tenant.environmentId, userId))
  if (!record || !user) {
    throw new NotFoundError()
  }
  return { record, user }
}

/** Whether the user belongs to some organization. */
async function hasMembership(deps: Deps, ctx: ScimContext, userId: string) {
  const page = await deps.organizations.listUserMemberships(ctx.tenant.environmentId, userId, {
    page: 1,
    size: 1,
  })
  return page.total > 0
}

/**
 * Give or take back access. Deactivating removes the membership (the last manager of the
 * organization cannot be removed: 409) and, only for an account this directory created that
 * has no other membership, bans it, which signs it out and denylists its sessions.
 */
async function setActive(
  deps: Deps,
  ctx: ScimContext,
  user: UserRecord,
  record: ScimUserRecord,
  active: boolean
) {
  const { environmentId } = ctx.tenant
  const member = await deps.organizations.findMembership(environmentId, ctx.organizationId, user.id)
  const managed = user.managedByDirectoryId === ctx.organizationId
  if (active) {
    if (!member) {
      await Organizations.addMember(
        deps,
        ctx.tenant,
        ctx.organizationId,
        { userId: user.id, role: MEMBER_ROLE },
        ctx.actor
      )
    }
    if (managed && user.bannedAt !== null) {
      await Users.unban(deps, ctx.tenant, user.id, ctx.actor)
    }
  } else {
    if (member) {
      await Organizations.removeMember(deps, ctx.tenant, ctx.organizationId, user.id, ctx.actor)
    }
    if (managed && user.bannedAt === null && !(await hasMembership(deps, ctx, user.id))) {
      await Users.ban(deps, ctx.tenant, user.id, ctx.actor)
    }
  }
  await deps.scim.updateUser(
    environmentId,
    ctx.organizationId,
    user.id,
    { active },
    deps.clock.now()
  )
  record.active = active
}

async function apply(
  deps: Deps,
  ctx: ScimContext,
  userId: string,
  changes: { active?: boolean; externalId?: string | null }
) {
  const { record, user } = await load(deps, ctx, userId)
  const { environmentId } = ctx.tenant
  if (changes.externalId !== undefined && changes.externalId !== record.externalId) {
    const refusal = await deps.scim.updateUser(
      environmentId,
      ctx.organizationId,
      userId,
      { externalId: changes.externalId },
      deps.clock.now()
    )
    if (refusal === 'external_id_taken') {
      throw uniqueness()
    }
  }
  if (changes.active !== undefined && changes.active !== record.active) {
    await setActive(deps, ctx, user, record, changes.active)
  }
  const fresh = await load(deps, ctx, userId)
  return resource(fresh.user, fresh.record)
}

/**
 * Provision a user: a new account this directory manages, or an existing one on a domain the
 * organization has verified, plus the membership.
 *
 * Not one transaction: an account created here and then refused a SCIM row (a racing
 * duplicate `externalId`) is left without a membership. shortcut: the retry finds it by
 * address and, being on no verified domain link, answers 409; upgrade to one store call.
 *
 * @param deps - The dependencies.
 * @param ctx - The environment, the organization and the actor.
 * @param input - The User the directory sent.
 * @returns The resource.
 * @throws ScimError `uniqueness` (409) for a taken `userName` or `externalId`.
 */
export async function create(deps: Deps, ctx: ScimContext, input: ScimUserInput) {
  const { environmentId } = ctx.tenant
  const parsed = emailOf(input)
  const externalId = input.externalId ?? null
  if (
    externalId !== null &&
    (await deps.scim.findUserByExternalId(environmentId, ctx.organizationId, externalId))
  ) {
    throw uniqueness()
  }
  const existing = await deps.users.findByEmail(environmentId, parsed.normalized)
  const verifiedDomain = await onVerifiedDomain(deps, ctx, parsed.normalized)
  const now = deps.clock.now()
  let user: UserRecord
  let method: 'created' | 'linked'
  if (existing) {
    // A known address is never claimed by a directory unless the organization proved the domain.
    if (
      !verifiedDomain ||
      (await deps.scim.findUser(environmentId, ctx.organizationId, existing.id))
    ) {
      throw uniqueness()
    }
    user = existing
    method = 'linked'
  } else {
    user = {
      id: deps.ids.next(),
      projectId: ctx.tenant.projectId,
      environmentId,
      email: parsed.email,
      emailNormalized: parsed.normalized,
      emailVerifiedAt: verifiedDomain ? now : null,
      firstName: input.name?.givenName?.trim() || null,
      lastName: input.name?.familyName?.trim() || null,
      bannedAt: null,
      lastSignInAt: null,
      createdAt: now,
      phoneNumber: null,
      phoneNumberVerifiedAt: null,
      smsFactorEnabledAt: null,
      managedByDirectoryId: ctx.organizationId,
    }
    const created = await deps.users.create(
      { ...user, identityId: deps.ids.next(), credentialId: deps.ids.next(), passwordHash: null },
      Audit.entry(deps, ctx.tenant, {
        type: 'user.created',
        actor: ctx.actor,
        target: { type: 'user', id: user.id },
        data: { method: 'scim', emailVerified: verifiedDomain, passwordless: true },
      })
    )
    if (!created) {
      throw uniqueness()
    }
    method = 'created'
  }
  const wanted = input.active ?? true
  const record: ScimUserRecord = {
    id: deps.ids.next(),
    projectId: ctx.tenant.projectId,
    environmentId,
    organizationId: ctx.organizationId,
    userId: user.id,
    externalId,
    // Stored as the opposite of what is wanted so that `apply` below sees a change and does the
    // work (membership, ban) through the one path.
    active: wanted === false,
    createdAt: now,
    updatedAt: now,
  }
  const refusal = await deps.scim.insertUser(
    record,
    Audit.entry(deps, ctx.tenant, {
      type: 'user.scim_provisioned',
      actor: ctx.actor,
      target: { type: 'user', id: user.id },
      data: { organizationId: ctx.organizationId, method },
    })
  )
  if (refusal) {
    throw uniqueness()
  }
  return apply(deps, ctx, user.id, { active: wanted })
}

/**
 * @param deps - The dependencies.
 * @param ctx - The environment, the organization and the actor.
 * @param userId - The user.
 * @returns The resource.
 * @throws NotFoundError when this directory has no such user.
 */
export async function get(deps: Deps, ctx: ScimContext, userId: string) {
  const { record, user } = await load(deps, ctx, userId)
  return resource(user, record)
}

/** Parse `userName eq "x"` / `externalId eq "x"`, the two filters identity providers send. */
function parseFilter(filter: string): { attribute: 'userName' | 'externalId'; value: string } {
  const match = /^\s*(userName|externalId)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter)
  if (!match?.[1] || match[2] === undefined) {
    throw new ScimError(
      'request.malformed',
      'invalidFilter',
      'Only `userName eq "…"` and `externalId eq "…"` are supported.'
    )
  }
  return {
    attribute: match[1].toLowerCase() === 'username' ? 'userName' : 'externalId',
    value: match[2].replace(/\\(.)/g, '$1'),
  }
}

/**
 * List the directory's users, or the one a filter names.
 *
 * @param deps - The dependencies.
 * @param ctx - The environment, the organization and the actor.
 * @param query - `filter`, `startIndex` (from 1) and `count` (0 to {@link MAX_COUNT}).
 * @returns A SCIM ListResponse.
 * @throws ScimError `invalidFilter` for any other filter.
 */
export async function list(
  deps: Deps,
  ctx: ScimContext,
  query: { filter?: string; startIndex?: number; count?: number }
) {
  const { environmentId } = ctx.tenant
  const startIndex = Math.max(query.startIndex ?? 1, 1)
  const count = Math.min(Math.max(query.count ?? 100, 0), MAX_COUNT)
  let records: ScimUserRecord[]
  let total: number
  if (query.filter !== undefined) {
    const { attribute, value } = parseFilter(query.filter)
    let found: ScimUserRecord | null = null
    if (attribute === 'externalId') {
      found = await deps.scim.findUserByExternalId(environmentId, ctx.organizationId, value)
    } else {
      const user = await deps.users.findByEmail(
        environmentId,
        parseEmail(value)?.normalized ?? value.toLowerCase()
      )
      found = user ? await deps.scim.findUser(environmentId, ctx.organizationId, user.id) : null
    }
    records = found ? [found] : []
    total = records.length
    records = records.slice(startIndex - 1, startIndex - 1 + count)
  } else {
    ;({ records, total } = await deps.scim.listUsers(
      environmentId,
      ctx.organizationId,
      startIndex - 1,
      count
    ))
  }
  const users = new Map(
    (
      await deps.users.findByIds(
        environmentId,
        records.map((record) => record.userId)
      )
    ).map((user) => [user.id, user])
  )
  const resources = records.flatMap((record) => {
    const user = users.get(record.userId)
    return user ? [resource(user, record)] : []
  })
  return {
    schemas: [LIST_SCHEMA],
    totalResults: total,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  }
}

/**
 * Replace (PUT): `active` and `externalId` are what a directory may change. The address and
 * the names are not (shortcut: a rename in the directory is ignored; upgrade when a name
 * update method exists on the user store).
 *
 * @param deps - The dependencies.
 * @param ctx - The environment, the organization and the actor.
 * @param userId - The user.
 * @param input - The full User.
 * @returns The resource as it now is.
 * @throws ScimError `uniqueness` for an `externalId` another user has.
 */
export async function replace(deps: Deps, ctx: ScimContext, userId: string, input: ScimUserInput) {
  return apply(deps, ctx, userId, {
    active: input.active ?? true,
    externalId: input.externalId ?? null,
  })
}

/** A flag as Okta (a boolean) or Entra (a string, any case) sends it. */
function flag(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'string' && /^(true|false)$/i.test(value)) {
    return value.toLowerCase() === 'true'
  }
  throw invalidValue('active must be true or false.')
}

/**
 * Patch: `active` and `externalId`, by path (`active`) or inside an object value without a
 * path (Okta's and Entra's shapes), with `op` in any case. Other attributes are ignored, as
 * the directory keeps sending them whether or not a server stores them.
 *
 * @param deps - The dependencies.
 * @param ctx - The environment, the organization and the actor.
 * @param userId - The user.
 * @param operations - The `Operations` array.
 * @returns The resource as it now is.
 * @throws ScimError `invalidValue` for an op that is not add, replace or remove.
 */
export async function patch(
  deps: Deps,
  ctx: ScimContext,
  userId: string,
  operations: Array<{ op: string; path?: string; value?: unknown }>
) {
  const changes: { active?: boolean; externalId?: string | null } = {}
  const set = (name: string, value: unknown, removing: boolean) => {
    if (name === 'active') {
      changes.active = removing ? false : flag(value)
    } else if (name === 'externalId') {
      changes.externalId = removing || value === null ? null : String(value).slice(0, 255)
    }
  }
  for (const operation of operations) {
    const op = operation.op.toLowerCase()
    if (op !== 'add' && op !== 'replace' && op !== 'remove') {
      throw invalidValue('op must be add, replace or remove.')
    }
    if (operation.path !== undefined) {
      set(operation.path, operation.value, op === 'remove')
    } else if (operation.value && typeof operation.value === 'object') {
      for (const [name, value] of Object.entries(operation.value)) {
        set(name, value, false)
      }
    }
  }
  return apply(deps, ctx, userId, changes)
}

/**
 * Delete (DELETE): remove the membership; delete the account only when this directory created
 * it and it belongs to no other organization. Any other account stays, with its sessions.
 *
 * @param deps - The dependencies.
 * @param ctx - The environment, the organization and the actor.
 * @param userId - The user.
 * @throws NotFoundError when this directory has no such user.
 * @throws AuthError `organization.last_manager` (409) for the organization's last manager.
 */
export async function remove(deps: Deps, ctx: ScimContext, userId: string) {
  const { environmentId } = ctx.tenant
  const { user } = await load(deps, ctx, userId)
  if (await deps.organizations.findMembership(environmentId, ctx.organizationId, userId)) {
    await Organizations.removeMember(deps, ctx.tenant, ctx.organizationId, userId, ctx.actor)
  }
  if (
    user.managedByDirectoryId === ctx.organizationId &&
    !(await hasMembership(deps, ctx, userId))
  ) {
    await Users.remove(deps, ctx.tenant, userId, ctx.actor)
  } else {
    await deps.scim.deleteUser(environmentId, ctx.organizationId, userId)
  }
}
