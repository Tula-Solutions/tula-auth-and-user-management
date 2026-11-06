import { beforeEach, describe, expect, test } from 'bun:test'
import * as Audit from '~/modules/audit/service'
import type { SetupLinkRecord, SetupLinkStore } from '~/ports/setup-link-store'

/** A tenant for the suite. */
export interface SetupLinkSuiteTenant {
  projectId: string
  environmentId: string
}

/** What the store under test provides. */
export interface SetupLinkSuiteContext {
  store: SetupLinkStore
  /** The audit actions recorded so far in tenant `a`, oldest first. */
  recorded: () => Promise<string[]>
  /** Makes an organization of the tenant and returns its id. */
  organization: (tenant: SetupLinkSuiteTenant) => Promise<string>
  /** Deletes the organization as the database does: the cascade is what is under test. */
  deleteOrganization: (tenant: SetupLinkSuiteTenant, organizationId: string) => Promise<void>
  a: SetupLinkSuiteTenant
  b: SetupLinkSuiteTenant
}

/**
 * Behaviour every `SetupLinkStore` must have. Run against each adapter so the memory store
 * used by unit tests can't drift from Postgres.
 *
 * @param name - Adapter name for the report.
 * @param setup - Builds a fresh context; called before each test.
 */
export function describeSetupLinkStore(
  name: string,
  setup: () => Promise<SetupLinkSuiteContext>
): void {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const later = new Date('2026-01-02T00:00:00.000Z')
  let ctx: SetupLinkSuiteContext
  let org: string

  function activity(
    tenant: SetupLinkSuiteTenant,
    type: 'setup_link.created' | 'setup_link.revoked',
    id: string
  ) {
    const deps = { ids: { next: () => Bun.randomUUIDv7() }, clock: { now: () => now } }
    return Audit.entry(deps, tenant, {
      type,
      actor: { type: 'admin', id: null, ipAddress: null, userAgent: null },
      target: { type: 'setup_link', id },
      data: { organizationId: org },
    })
  }

  function record(
    tenant: SetupLinkSuiteTenant,
    organizationId: string,
    over: Partial<SetupLinkRecord> = {}
  ): SetupLinkRecord {
    const id = over.id ?? Bun.randomUUIDv7()
    return {
      id,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      organizationId,
      name: 'SSO setup',
      prefix: 'tula_setup_',
      tokenHash: `hash-${id}`,
      expiresAt: new Date('2026-01-08T00:00:00.000Z'),
      revokedAt: null,
      lastUsedAt: null,
      createdByType: 'admin',
      createdById: null,
      createdAt: now,
      updatedAt: now,
      ...over,
    }
  }

  async function add(tenant: SetupLinkSuiteTenant, over: Partial<SetupLinkRecord> = {}) {
    const one = record(tenant, over.organizationId ?? org, over)
    await ctx.store.insert(one, activity(tenant, 'setup_link.created', one.id))
    return one
  }

  function revoke(tenant: SetupLinkSuiteTenant, organizationId: string, id: string) {
    return ctx.store.revoke(
      tenant.environmentId,
      organizationId,
      id,
      later,
      activity(tenant, 'setup_link.revoked', id)
    )
  }

  describe(`${name} setup link store`, () => {
    beforeEach(async () => {
      ctx = await setup()
      org = await ctx.organization(ctx.a)
    })

    test('stores a link and finds it by the hash of its token, in its environment only', async () => {
      const one = await add(ctx.a)
      expect(await ctx.store.findByHash(ctx.a.environmentId, one.tokenHash)).toEqual(one)
      expect(await ctx.store.findByHash(ctx.b.environmentId, one.tokenHash)).toBeNull()
      expect(await ctx.store.findByHash(ctx.a.environmentId, 'nope')).toBeNull()
      expect(await ctx.recorded()).toEqual(['setup_link.created'])
    })

    test('lists one organization’s links, newest first, and no other organization’s', async () => {
      const first = await add(ctx.a, { createdAt: now })
      const second = await add(ctx.a, { createdAt: later })
      await add(ctx.a, { organizationId: await ctx.organization(ctx.a) })
      await add(ctx.b, { organizationId: await ctx.organization(ctx.b) })
      const listed = await ctx.store.list(ctx.a.environmentId, org)
      expect(listed.map((one) => one.id)).toEqual([second.id, first.id])
      expect(await ctx.store.list(ctx.b.environmentId, org)).toEqual([])
    })

    test('revokes a link once, records it once, and only for its own organization', async () => {
      const one = await add(ctx.a)
      expect(await revoke(ctx.a, await ctx.organization(ctx.a), one.id)).toBeNull()
      expect(await revoke(ctx.b, org, one.id)).toBeNull()
      expect((await revoke(ctx.a, org, one.id))?.revokedAt).toEqual(later)
      expect(await revoke(ctx.a, org, one.id)).toBeNull()
      expect((await ctx.store.findByHash(ctx.a.environmentId, one.tokenHash))?.revokedAt).toEqual(
        later
      )
      expect(await ctx.recorded()).toEqual(['setup_link.created', 'setup_link.revoked'])
    })

    test('notes the time of use on the link', async () => {
      const one = await add(ctx.a)
      await ctx.store.touch(ctx.a.environmentId, one.id, later)
      expect((await ctx.store.findByHash(ctx.a.environmentId, one.tokenHash))?.lastUsedAt).toEqual(
        later
      )
    })

    test('deletes links that expired before the cutoff, in a batch, per environment', async () => {
      const lapsed = await add(ctx.a, { expiresAt: new Date('2025-12-01T00:00:00.000Z') })
      const lapsed2 = await add(ctx.a, { expiresAt: new Date('2025-12-02T00:00:00.000Z') })
      const open = await add(ctx.a)
      const theirs = await add(ctx.b, {
        organizationId: await ctx.organization(ctx.b),
        expiresAt: new Date('2025-12-01T00:00:00.000Z'),
      })
      const cutoff = new Date('2025-12-31T00:00:00.000Z')
      expect(await ctx.store.deleteExpiredBefore(ctx.a.environmentId, cutoff, 1)).toBe(1)
      expect(await ctx.store.deleteExpiredBefore(ctx.a.environmentId, cutoff, 10)).toBe(1)
      expect(await ctx.store.deleteExpiredBefore(ctx.a.environmentId, cutoff, 10)).toBe(0)
      expect(await ctx.store.findByHash(ctx.a.environmentId, lapsed.tokenHash)).toBeNull()
      expect(await ctx.store.findByHash(ctx.a.environmentId, lapsed2.tokenHash)).toBeNull()
      expect(await ctx.store.findByHash(ctx.a.environmentId, open.tokenHash)).not.toBeNull()
      expect(await ctx.store.findByHash(ctx.b.environmentId, theirs.tokenHash)).not.toBeNull()
    })

    test('deleting the organization removes its setup links', async () => {
      const one = await add(ctx.a)
      await ctx.deleteOrganization(ctx.a, org)
      expect(await ctx.store.findByHash(ctx.a.environmentId, one.tokenHash)).toBeNull()
      expect(await ctx.store.list(ctx.a.environmentId, org)).toEqual([])
    })
  })
}
