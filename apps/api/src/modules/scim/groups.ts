import type { Deps } from '~/dependencies'
import { NotFoundError } from '~/exceptions'
import * as Logger from '~/lib/logger'
import * as Audit from '~/modules/audit/service'
import type { ScimGroupRecord } from '~/ports/scim-store'
import { invalidValue, ScimError, uniqueness } from './errors'
import * as Roles from './roles'
import { GROUP_SCHEMA, LIST_SCHEMA, type ScimGroupInput, type ScimGroupResource } from './schema'
import { MAX_COUNT, type ScimContext } from './service'

// The SCIM Groups resource (ADR 0067, "SCIM Groups"). A group's members get the role the
// organization's group mapping gives the groups they are in (`Roles.resolve`, the function an
// SSO sign-in uses). A group name is directory data: it is stored and matched, and is never in
// an audit entry, an event or a log line.

function resource(group: ScimGroupRecord, withMembers: boolean): ScimGroupResource {
  return {
    schemas: [GROUP_SCHEMA],
    id: group.id,
    ...(group.externalId !== null && { externalId: group.externalId }),
    displayName: group.displayName,
    ...(withMembers && { members: group.memberIds.map((value) => ({ value })) }),
    meta: {
      resourceType: 'Group',
      created: group.createdAt.toISOString(),
      lastModified: group.updatedAt.toISOString(),
    },
  }
}

async function load(deps: Deps, ctx: ScimContext, id: string) {
  const group = await deps.scim.findGroup(ctx.tenant.environmentId, ctx.organizationId, id)
  if (!group) {
    throw new NotFoundError()
  }
  return group
}

/** Members must be users this directory manages; one the directory has not pushed is a 400. */
async function checkMembers(deps: Deps, ctx: ScimContext, ids: string[]) {
  for (const id of new Set(ids)) {
    if (!(await deps.scim.findUser(ctx.tenant.environmentId, ctx.organizationId, id))) {
      throw invalidValue('A member is not a user of this directory.')
    }
  }
}

/**
 * Apply a group change: work out the role change of every member whose groups change, make them
 * all through the organization service, then store the group. If one is refused (the last
 * manager), the ones already made are put back in reverse order and nothing is stored, so a
 * change is all or nothing. shortcut: the put-back is a second round of writes (and audit
 * entries), not one transaction; upgrade when the organization store has a batch role change.
 */
async function commit(
  deps: Deps,
  ctx: ScimContext,
  change: {
    oldName: string | null
    newName: string | null
    before: string[]
    after: string[]
    persist: () => Promise<'name_taken' | 'missing' | null>
  }
) {
  const { environmentId } = ctx.tenant
  const before = new Set(change.before)
  const after = new Set(change.after)
  const renamed = change.oldName !== change.newName
  const affected = [...new Set([...before, ...after])].filter(
    (id) => renamed || before.has(id) !== after.has(id)
  )
  const planned: Roles.RoleChange[] = []
  for (const userId of affected) {
    const names = (
      await deps.scim.groupNamesOfUser(environmentId, ctx.organizationId, userId)
    ).filter((name) => name !== change.oldName)
    if (change.newName !== null && after.has(userId)) {
      names.push(change.newName)
    }
    const one = await Roles.plan(deps, ctx, userId, names)
    if (one) {
      planned.push(one)
    }
  }
  const done: Roles.RoleChange[] = []
  const undo = async () => {
    for (const one of done.reverse()) {
      try {
        await Roles.change(deps, ctx, one.userId, one.from)
      } catch (error) {
        Logger.error('a SCIM group change could not be put back', {
          environmentId,
          organizationId: ctx.organizationId,
          reason: error instanceof Error ? error.name : 'unknown',
        })
      }
    }
  }
  try {
    for (const one of planned) {
      await Roles.change(deps, ctx, one.userId, one.to)
      done.push(one)
    }
    const refusal = await change.persist()
    if (refusal === 'name_taken') {
      throw uniqueness()
    }
    if (refusal === 'missing') {
      throw new NotFoundError()
    }
  } catch (error) {
    await undo()
    throw error
  }
}

/**
 * Create a group.
 *
 * @param deps - The dependencies.
 * @param ctx - The environment, the organization and the actor.
 * @param input - The Group the directory sent.
 * @returns The resource.
 * @throws ScimError `uniqueness` (409) for a taken `displayName`.
 * @throws AuthError `organization.last_manager` (409) when a member's new role would demote the last manager.
 */
export async function create(deps: Deps, ctx: ScimContext, input: ScimGroupInput) {
  const memberIds = [...new Set((input.members ?? []).map((m) => m.value))]
  await checkMembers(deps, ctx, memberIds)
  const now = deps.clock.now()
  const group: ScimGroupRecord = {
    id: deps.ids.next(),
    projectId: ctx.tenant.projectId,
    environmentId: ctx.tenant.environmentId,
    organizationId: ctx.organizationId,
    displayName: input.displayName,
    externalId: input.externalId ?? null,
    memberIds,
    createdAt: now,
    updatedAt: now,
  }
  await commit(deps, ctx, {
    oldName: null,
    newName: group.displayName,
    before: [],
    after: memberIds,
    persist: () =>
      deps.scim.insertGroup(
        group,
        Audit.entry(deps, ctx.tenant, {
          type: 'scim_group.created',
          actor: ctx.actor,
          target: { type: 'scim_group', id: group.id },
          data: { organizationId: ctx.organizationId },
        })
      ),
  })
  return resource(group, true)
}

/**
 * @param deps - The dependencies.
 * @param ctx - The environment, the organization and the actor.
 * @param id - The group.
 * @returns The resource.
 * @throws NotFoundError when this directory has no such group.
 */
export async function get(deps: Deps, ctx: ScimContext, id: string) {
  return resource(await load(deps, ctx, id), true)
}

/** Parse `displayName eq "x"`, the one filter identity providers send for groups. */
function parseFilter(filter: string): string {
  const match = /^\s*displayName\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter)
  if (match?.[1] === undefined) {
    throw new ScimError(
      'request.malformed',
      'invalidFilter',
      'Only `displayName eq "…"` is supported.'
    )
  }
  return match[1].replace(/\\(.)/g, '$1')
}

/**
 * List the directory's groups, or the one a filter names.
 *
 * @param deps - The dependencies.
 * @param ctx - The environment, the organization and the actor.
 * @param query - `filter`, `startIndex` (from 1), `count` (0 to {@link MAX_COUNT}) and `excludedAttributes`.
 * @returns A SCIM ListResponse.
 * @throws ScimError `invalidFilter` for any other filter.
 */
export async function list(
  deps: Deps,
  ctx: ScimContext,
  query: { filter?: string; startIndex?: number; count?: number; excludedAttributes?: string }
) {
  const { environmentId } = ctx.tenant
  const startIndex = Math.max(query.startIndex ?? 1, 1)
  const count = Math.min(Math.max(query.count ?? 100, 0), MAX_COUNT)
  let records: ScimGroupRecord[]
  let total: number
  if (query.filter !== undefined) {
    const found = await deps.scim.findGroupByName(
      environmentId,
      ctx.organizationId,
      parseFilter(query.filter)
    )
    total = found ? 1 : 0
    records = found ? [found].slice(startIndex - 1, startIndex - 1 + count) : []
  } else {
    ;({ records, total } = await deps.scim.listGroups(
      environmentId,
      ctx.organizationId,
      startIndex - 1,
      count
    ))
  }
  const withMembers = !/(^|,)\s*members\s*(,|$)/i.test(query.excludedAttributes ?? '')
  return {
    schemas: [LIST_SCHEMA],
    totalResults: total,
    startIndex,
    itemsPerPage: records.length,
    Resources: records.map((one) => resource(one, withMembers)),
  }
}

/** Replace one group's state and answer the resource as it now is. */
async function write(
  deps: Deps,
  ctx: ScimContext,
  current: ScimGroupRecord,
  next: { displayName: string; externalId: string | null; memberIds: string[] }
) {
  const memberIds = [...new Set(next.memberIds)]
  await checkMembers(deps, ctx, memberIds)
  const changed = [
    ...(next.displayName !== current.displayName ? (['displayName'] as const) : []),
    ...(next.externalId !== current.externalId ? (['externalId'] as const) : []),
    ...(memberIds.length !== current.memberIds.length ||
    memberIds.some((id) => !current.memberIds.includes(id))
      ? (['members'] as const)
      : []),
  ]
  if (changed.length === 0) {
    return resource(current, true)
  }
  const at = deps.clock.now()
  await commit(deps, ctx, {
    oldName: current.displayName,
    newName: next.displayName,
    before: current.memberIds,
    after: memberIds,
    persist: () =>
      deps.scim.replaceGroup(
        ctx.tenant.environmentId,
        ctx.organizationId,
        current.id,
        { ...next, memberIds },
        at,
        Audit.entry(deps, ctx.tenant, {
          type: 'scim_group.updated',
          actor: ctx.actor,
          target: { type: 'scim_group', id: current.id },
          data: { organizationId: ctx.organizationId, changed },
        })
      ),
  })
  return resource({ ...current, ...next, memberIds, updatedAt: at }, true)
}

/**
 * Replace (PUT): name, external id and the whole member list.
 *
 * @param deps - The dependencies.
 * @param ctx - The environment, the organization and the actor.
 * @param id - The group.
 * @param input - The full Group.
 * @returns The resource as it now is.
 * @throws ScimError `uniqueness` for a taken name; `invalidValue` for a member that is not a directory user.
 * @throws AuthError `organization.last_manager` (409), with nothing changed.
 */
export async function replace(deps: Deps, ctx: ScimContext, id: string, input: ScimGroupInput) {
  return write(deps, ctx, await load(deps, ctx, id), {
    displayName: input.displayName,
    externalId: input.externalId ?? null,
    memberIds: (input.members ?? []).map((m) => m.value),
  })
}

/** The user ids a `members` value names: an array of `{ value }`, one object, or nothing. */
function idsOf(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value == null ? [] : [value]
  return list.flatMap((one) =>
    one && typeof one === 'object' && typeof (one as { value?: unknown }).value === 'string'
      ? [(one as { value: string }).value]
      : []
  )
}

/**
 * Patch: `members` added, removed or replaced (Okta's `members[value eq "id"]` path and Entra's
 * `value` arrays, `op` in any case), and `displayName` / `externalId`, by path or inside an
 * object value. The whole patch is applied together or not at all.
 *
 * @param deps - The dependencies.
 * @param ctx - The environment, the organization and the actor.
 * @param id - The group.
 * @param operations - The `Operations` array.
 * @returns The resource as it now is.
 * @throws ScimError `invalidValue` for an op that is not add, replace or remove.
 * @throws AuthError `organization.last_manager` (409), with nothing changed.
 */
export async function patch(
  deps: Deps,
  ctx: ScimContext,
  id: string,
  operations: Array<{ op: string; path?: string; value?: unknown }>
) {
  const current = await load(deps, ctx, id)
  const next = {
    displayName: current.displayName,
    externalId: current.externalId,
    memberIds: [...current.memberIds],
  }
  const apply = (op: string, path: string, value: unknown) => {
    const filtered = /^members\[\s*value\s+eq\s+"([^"]*)"\s*\]$/i.exec(path)
    if (filtered?.[1] !== undefined) {
      if (op === 'remove') {
        next.memberIds = next.memberIds.filter((one) => one !== filtered[1])
      }
      return
    }
    switch (path.toLowerCase()) {
      case 'members': {
        const ids = idsOf(value)
        if (op === 'add') {
          next.memberIds.push(...ids)
        } else if (op === 'remove') {
          next.memberIds =
            ids.length === 0 ? [] : next.memberIds.filter((one) => !ids.includes(one))
        } else {
          next.memberIds = ids
        }
        return
      }
      case 'displayname':
        if (op !== 'remove') {
          if (typeof value !== 'string' || value.trim() === '' || value.length > 256) {
            throw invalidValue('displayName must be a non-empty string.')
          }
          next.displayName = value.trim()
        }
        return
      case 'externalid':
        next.externalId = op === 'remove' || value == null ? null : String(value).slice(0, 255)
        return
    }
  }
  for (const operation of operations) {
    const op = operation.op.toLowerCase()
    if (op !== 'add' && op !== 'replace' && op !== 'remove') {
      throw invalidValue('op must be add, replace or remove.')
    }
    if (operation.path !== undefined) {
      apply(op, operation.path, operation.value)
    } else if (operation.value && typeof operation.value === 'object') {
      for (const [name, value] of Object.entries(operation.value)) {
        apply(op, name, value)
      }
    }
  }
  return write(deps, ctx, current, next)
}

/**
 * Delete (DELETE): the group goes and its members fall back to the roles their other groups give.
 *
 * @param deps - The dependencies.
 * @param ctx - The environment, the organization and the actor.
 * @param id - The group.
 * @throws NotFoundError when this directory has no such group.
 * @throws AuthError `organization.last_manager` (409), with nothing changed.
 */
export async function remove(deps: Deps, ctx: ScimContext, id: string) {
  const current = await load(deps, ctx, id)
  await commit(deps, ctx, {
    oldName: current.displayName,
    newName: null,
    before: current.memberIds,
    after: [],
    persist: async () =>
      (await deps.scim.deleteGroup(
        ctx.tenant.environmentId,
        ctx.organizationId,
        id,
        Audit.entry(deps, ctx.tenant, {
          type: 'scim_group.deleted',
          actor: ctx.actor,
          target: { type: 'scim_group', id },
          data: { organizationId: ctx.organizationId },
        })
      ))
        ? null
        : 'missing',
  })
}
