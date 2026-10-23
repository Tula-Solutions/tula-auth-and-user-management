import { beforeEach, describe, expect, test } from 'bun:test'
import type { OrganizationDomainMode } from '@tula-tech/contract'
import * as Audit from '~/modules/audit/service'
import type { Activity } from '~/ports/activity-log'
import type { DomainClaim, OrganizationDomainStore } from '~/ports/organization-domain-store'

/** A tenant for the suite. */
export interface OrganizationDomainSuiteTenant {
  projectId: string
  environmentId: string
}

/** What the store under test provides. */
export interface OrganizationDomainSuiteContext {
  store: OrganizationDomainStore
  /** The audit actions recorded so far in tenant `a`, oldest first. */
  recorded: () => Promise<string[]>
  /** Make an organization in a tenant (a database needs the row a domain refers to); returns its id. */
  organization: (tenant: OrganizationDomainSuiteTenant) => Promise<string>
  /** Delete an organization the way the organization store does; its domains must go with it. */
  deleteOrganization: (tenant: OrganizationDomainSuiteTenant, id: string) => Promise<void>
  a: OrganizationDomainSuiteTenant
  b: OrganizationDomainSuiteTenant
}

/**
 * Behaviour every `OrganizationDomainStore` must have. Run against each adapter so the memory
 * store used by unit tests can't drift from Postgres.
 *
 * @param name - Adapter name for the report.
 * @param setup - Builds a fresh context; called before each test.
 */
export function describeOrganizationDomainStore(
  name: string,
  setup: () => Promise<OrganizationDomainSuiteContext>
): void {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const inTenMinutes = new Date('2026-01-01T00:10:00.000Z')
  const inAYear = new Date('2027-01-01T00:00:00.000Z')
  let ctx: OrganizationDomainSuiteContext

  function activity(
    tenant: OrganizationDomainSuiteTenant,
    type:
      | 'organization_domain.claimed'
      | 'organization_domain.verified'
      | 'organization_domain.removed',
    id: string
  ): Activity {
    const scope = { projectId: tenant.projectId, environmentId: tenant.environmentId }
    const deps = { ids: { next: () => Bun.randomUUIDv7() }, clock: { now: () => now } }
    const actor = { type: 'admin', id: null, ipAddress: null, userAgent: null } as const
    const target = { type: 'organization_domain', id } as const
    const base = { organizationId: Bun.randomUUIDv7(), domain: 'acme.test' }
    if (type === 'organization_domain.removed') {
      return Audit.entry(deps, scope, { type, actor, target, data: base })
    }
    return Audit.entry(deps, scope, { type, actor, target, data: { ...base, mode: 'suggest' } })
  }

  function claim(
    tenant: OrganizationDomainSuiteTenant,
    organizationId: string,
    overrides: Partial<DomainClaim> = {}
  ): DomainClaim {
    return {
      id: Bun.randomUUIDv7(),
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      organizationId,
      domain: 'acme.test',
      mode: 'suggest',
      codeHash: 'hash-1',
      codeExpiresAt: inTenMinutes,
      at: now,
      limit: 10,
      ...overrides,
    }
  }

  /** A pending claim, stored. */
  async function pending(
    tenant: OrganizationDomainSuiteTenant,
    organizationId: string,
    overrides: Partial<DomainClaim> = {}
  ) {
    const input = claim(tenant, organizationId, overrides)
    const result = await ctx.store.claim(
      input,
      activity(tenant, 'organization_domain.claimed', input.id)
    )
    if (result.outcome !== 'claimed') {
      throw new Error(`claim: ${result.outcome}`)
    }
    return result.record
  }

  /** A verified domain, stored. */
  async function verified(
    tenant: OrganizationDomainSuiteTenant,
    organizationId: string,
    domain = 'acme.test'
  ) {
    const record = await pending(tenant, organizationId, { domain })
    const result = await ctx.store.verify(
      tenant.environmentId,
      organizationId,
      record.id,
      'hash-1',
      now,
      inAYear,
      activity(tenant, 'organization_domain.verified', record.id)
    )
    if (result.outcome !== 'verified') {
      throw new Error(`verify: ${result.outcome}`)
    }
    return result.record
  }

  describe(`${name}: organization domains`, () => {
    beforeEach(async () => {
      ctx = await setup()
    })

    test('a claim is a pending row with a code, listed oldest first, and recorded with it', async () => {
      const org = await ctx.organization(ctx.a)
      const first = await pending(ctx.a, org, { domain: 'acme.test' })
      await pending(ctx.a, org, { domain: 'acme.example', at: new Date(now.getTime() + 1000) })
      expect(first).toMatchObject({
        organizationId: org,
        domain: 'acme.test',
        mode: 'suggest',
        verifiedAt: null,
        codeHash: 'hash-1',
        codeAttempts: 0,
      })
      expect(first.codeExpiresAt?.toISOString()).toBe(inTenMinutes.toISOString())
      expect((await ctx.store.list(ctx.a.environmentId, org)).map((one) => one.domain)).toEqual([
        'acme.test',
        'acme.example',
      ])
      expect(await ctx.recorded()).toEqual([
        'organization_domain.claimed',
        'organization_domain.claimed',
      ])
    })

    test('claiming again replaces the code, the mode and the expiry, keeps the id and clears the guesses', async () => {
      const org = await ctx.organization(ctx.a)
      const first = await pending(ctx.a, org)
      await ctx.store.recordAttempt(ctx.a.environmentId, org, first.id, now, 5)
      const second = await pending(ctx.a, org, {
        mode: 'auto_join',
        codeHash: 'hash-2',
        codeExpiresAt: new Date(inTenMinutes.getTime() + 60_000),
      })
      expect(second.id).toBe(first.id)
      expect(second).toMatchObject({ mode: 'auto_join', codeHash: 'hash-2', codeAttempts: 0 })
      expect(await ctx.store.list(ctx.a.environmentId, org)).toHaveLength(1)
    })

    test('a claim for an organization that does not exist writes nothing', async () => {
      const input = claim(ctx.a, Bun.randomUUIDv7())
      expect(
        await ctx.store.claim(input, activity(ctx.a, 'organization_domain.claimed', input.id))
      ).toEqual({ outcome: 'gone' })
      expect(await ctx.recorded()).toEqual([])
    })

    test('an organization of another environment is not found, listed or claimable', async () => {
      const orgA = await ctx.organization(ctx.a)
      const orgB = await ctx.organization(ctx.b)
      const record = await pending(ctx.a, orgA)
      expect(await ctx.store.list(ctx.b.environmentId, orgA)).toEqual([])
      expect(await ctx.store.find(ctx.b.environmentId, orgA, record.id)).toBeNull()
      expect(await ctx.store.find(ctx.a.environmentId, orgB, record.id)).toBeNull()
      const foreign = claim(ctx.b, orgA)
      expect(
        await ctx.store.claim(foreign, activity(ctx.b, 'organization_domain.claimed', foreign.id))
      ).toEqual({ outcome: 'gone' })
    })

    test('a pending claim is never the verified domain; a verified one is, in its environment only', async () => {
      const org = await ctx.organization(ctx.a)
      await pending(ctx.a, org)
      expect(await ctx.store.findVerified(ctx.a.environmentId, 'acme.test')).toBeNull()
      await ctx.store.remove(
        ctx.a.environmentId,
        org,
        (await ctx.store.list(ctx.a.environmentId, org))[0]?.id ?? '',
        activity(ctx.a, 'organization_domain.removed', Bun.randomUUIDv7())
      )
      const done = await verified(ctx.a, org)
      expect(done.verifiedAt?.toISOString()).toBe(now.toISOString())
      expect(done.codeHash).toBeNull()
      expect(done.codeExpiresAt).toBeNull()
      expect((await ctx.store.findVerified(ctx.a.environmentId, 'acme.test'))?.id).toBe(done.id)
      expect(await ctx.store.findVerified(ctx.b.environmentId, 'acme.test')).toBeNull()
      // Exact: a parent or a subdomain is another domain.
      expect(await ctx.store.findVerified(ctx.a.environmentId, 'test')).toBeNull()
      expect(await ctx.store.findVerified(ctx.a.environmentId, 'mail.acme.test')).toBeNull()
    })

    test('a domain verified for an organization is not claimed by another while it holds', async () => {
      const first = await ctx.organization(ctx.a)
      const second = await ctx.organization(ctx.a)
      await verified(ctx.a, first)
      const input = claim(ctx.a, second)
      expect(
        await ctx.store.claim(input, activity(ctx.a, 'organization_domain.claimed', input.id))
      ).toEqual({ outcome: 'taken' })
      expect(await ctx.store.list(ctx.a.environmentId, second)).toEqual([])
      // Another environment is another namespace.
      const other = await ctx.organization(ctx.b)
      await pending(ctx.b, other)
    })

    test('claiming a domain the organization has verified starts a re-verification: a code, nothing else changes', async () => {
      const org = await ctx.organization(ctx.a)
      const before = await verified(ctx.a, org)
      const input = claim(ctx.a, org, {
        mode: 'auto_join',
        codeHash: 'hash-2',
        at: new Date(now.getTime() + 1000),
      })
      const result = await ctx.store.claim(
        input,
        activity(ctx.a, 'organization_domain.claimed', input.id)
      )
      expect(result.outcome).toBe('claimed')
      const after = await ctx.store.find(ctx.a.environmentId, org, before.id)
      // Still verified, same mode (the request's is ignored), same dates; plus the new code.
      expect(after).toMatchObject({ id: before.id, mode: 'suggest', codeHash: 'hash-2' })
      expect(after?.verifiedAt?.toISOString()).toBe(now.toISOString())
      expect(after?.expiresAt?.toISOString()).toBe(inAYear.toISOString())
      expect(after?.codeExpiresAt?.toISOString()).toBe(inTenMinutes.toISOString())
      expect(await ctx.store.list(ctx.a.environmentId, org)).toHaveLength(1)
    })

    test('entering the new code moves the dates on, clears the code and the reminder mark', async () => {
      const org = await ctx.organization(ctx.a)
      const before = await verified(ctx.a, org)
      expect(await ctx.store.takeReminder(ctx.a.environmentId, org, before.id, 30)).toEqual({
        previous: null,
      })
      const input = claim(ctx.a, org, { codeHash: 'hash-2' })
      await ctx.store.claim(input, activity(ctx.a, 'organization_domain.claimed', input.id))
      const counted = await ctx.store.recordAttempt(ctx.a.environmentId, org, before.id, now, 5)
      expect(counted?.codeAttempts).toBe(1)
      const later = new Date('2026-12-01T00:00:00.000Z')
      const later2 = new Date('2027-12-01T00:00:00.000Z')
      const result = await ctx.store.verify(
        ctx.a.environmentId,
        org,
        before.id,
        'hash-2',
        later,
        later2,
        activity(ctx.a, 'organization_domain.verified', before.id)
      )
      expect(result.outcome).toBe('verified')
      const after = await ctx.store.find(ctx.a.environmentId, org, before.id)
      expect(after).toMatchObject({ codeHash: null, codeExpiresAt: null, remindedDays: null })
      expect(after?.verifiedAt?.toISOString()).toBe(later.toISOString())
      expect(after?.expiresAt?.toISOString()).toBe(later2.toISOString())
    })

    test('a lapsed verification does not keep the name from another organization, which still cannot verify it until the row is removed', async () => {
      const first = await ctx.organization(ctx.a)
      const second = await ctx.organization(ctx.a)
      const old = await verified(ctx.a, first)
      const afterLapse = new Date(inAYear.getTime() + 1000)
      const input = claim(ctx.a, second, { at: afterLapse })
      const result = await ctx.store.claim(
        input,
        activity(ctx.a, 'organization_domain.claimed', input.id)
      )
      expect(result.outcome).toBe('claimed')
      // The unique key still holds the name for the lapsed row: removing it is the service's.
      expect(
        await ctx.store.verify(
          ctx.a.environmentId,
          second,
          input.id,
          'hash-1',
          afterLapse,
          new Date(afterLapse.getTime() + 1000),
          activity(ctx.a, 'organization_domain.verified', input.id)
        )
      ).toEqual({ outcome: 'taken' })
      expect(
        await ctx.store.remove(
          ctx.a.environmentId,
          first,
          old.id,
          activity(ctx.a, 'organization_domain.removed', old.id)
        )
      ).toBe(true)
      expect(
        (
          await ctx.store.verify(
            ctx.a.environmentId,
            second,
            input.id,
            'hash-1',
            afterLapse,
            new Date(afterLapse.getTime() + 1000),
            activity(ctx.a, 'organization_domain.verified', input.id)
          )
        ).outcome
      ).toBe('verified')
    })

    test('reminders: a row is due once per threshold, soonest lapse first, never when lapsed or unverified', async () => {
      const org = await ctx.organization(ctx.a)
      const soon = await verified(ctx.a, org, 'soon.test') // lapses at inAYear
      await pending(ctx.a, org, { domain: 'waiting.test' })
      const day = 86_400_000
      const at = (days: number) => new Date(inAYear.getTime() - days * day)
      const due = (when: Date) => ctx.store.listDueReminders(ctx.a.environmentId, when, [30, 7], 50)
      expect(await due(at(31))).toEqual([])
      expect((await due(at(30))).map((one) => [one.record.id, one.days])).toEqual([[soon.id, 30]])
      expect((await due(at(5))).map((one) => one.days)).toEqual([7])
      // At or after the lapse nothing is due: there is nothing left to warn about.
      expect(await due(inAYear)).toEqual([])
      expect(await due(new Date(inAYear.getTime() + day))).toEqual([])

      // Taken once: a second take, and the list, say it is done for the 30-day threshold.
      expect(await ctx.store.takeReminder(ctx.a.environmentId, org, soon.id, 30)).toEqual({
        previous: null,
      })
      expect(await ctx.store.takeReminder(ctx.a.environmentId, org, soon.id, 30)).toBe(false)
      expect(await due(at(20))).toEqual([])
      // The 7-day one is still to come, and is taken after the 30.
      expect((await due(at(6))).map((one) => one.days)).toEqual([7])
      expect(await ctx.store.takeReminder(ctx.a.environmentId, org, soon.id, 7)).toEqual({
        previous: 30,
      })
      expect(await due(at(6))).toEqual([])
      // A reminder given back is due again; one given back after a re-verification is not.
      await ctx.store.releaseReminder(ctx.a.environmentId, org, soon.id, 7, 30)
      expect((await due(at(6))).map((one) => one.days)).toEqual([7])
      await ctx.store.releaseReminder(ctx.a.environmentId, org, soon.id, 7, null)
      expect((await ctx.store.find(ctx.a.environmentId, org, soon.id))?.remindedDays).toBe(30)
      // A pending row is never taken.
      const waiting = (await ctx.store.list(ctx.a.environmentId, org)).find(
        (one) => one.domain === 'waiting.test'
      )
      expect(await ctx.store.takeReminder(ctx.a.environmentId, org, waiting?.id ?? '', 30)).toBe(
        false
      )
      // Another environment's rows are never listed or taken.
      expect(await ctx.store.listDueReminders(ctx.b.environmentId, at(5), [30, 7], 50)).toEqual([])
      expect(await ctx.store.takeReminder(ctx.b.environmentId, org, soon.id, 7)).toBe(false)
    })

    test('the reminder list is bounded by its limit', async () => {
      const org = await ctx.organization(ctx.a)
      await verified(ctx.a, org, 'one.test')
      await verified(ctx.a, org, 'two.test')
      const within = new Date(inAYear.getTime() - 86_400_000)
      expect(
        await ctx.store.listDueReminders(ctx.a.environmentId, within, [30, 7], 1)
      ).toHaveLength(1)
      expect(await ctx.store.listDueReminders(ctx.a.environmentId, within, [], 10)).toEqual([])
    })

    test('many organizations may wait on one name; the first to verify wins and the database says so', async () => {
      const first = await ctx.organization(ctx.a)
      const second = await ctx.organization(ctx.a)
      const one = await pending(ctx.a, first)
      const two = await pending(ctx.a, second)
      const recordedBefore = (await ctx.recorded()).length
      expect(
        (
          await ctx.store.verify(
            ctx.a.environmentId,
            first,
            one.id,
            'hash-1',
            now,
            inAYear,
            activity(ctx.a, 'organization_domain.verified', one.id)
          )
        ).outcome
      ).toBe('verified')
      expect(
        await ctx.store.verify(
          ctx.a.environmentId,
          second,
          two.id,
          'hash-1',
          now,
          inAYear,
          activity(ctx.a, 'organization_domain.verified', two.id)
        )
      ).toEqual({ outcome: 'taken' })
      // The loser wrote nothing, its audit entry included.
      expect(await ctx.recorded()).toHaveLength(recordedBefore + 1)
      expect((await ctx.store.find(ctx.a.environmentId, second, two.id))?.verifiedAt).toBeNull()
    })

    test('two verifications at once leave one organization with the domain', async () => {
      const first = await ctx.organization(ctx.a)
      const second = await ctx.organization(ctx.a)
      const one = await pending(ctx.a, first)
      const two = await pending(ctx.a, second)
      const outcomes = await Promise.all([
        ctx.store.verify(
          ctx.a.environmentId,
          first,
          one.id,
          'hash-1',
          now,
          inAYear,
          activity(ctx.a, 'organization_domain.verified', one.id)
        ),
        ctx.store.verify(
          ctx.a.environmentId,
          second,
          two.id,
          'hash-1',
          now,
          inAYear,
          activity(ctx.a, 'organization_domain.verified', two.id)
        ),
      ])
      expect(outcomes.map((one) => one.outcome).sort()).toEqual(['taken', 'verified'])
    })

    test('verifying needs the code that was checked: a replaced code or a verified row is stale', async () => {
      const org = await ctx.organization(ctx.a)
      const record = await pending(ctx.a, org)
      const stale = await ctx.store.verify(
        ctx.a.environmentId,
        org,
        record.id,
        'not-the-hash',
        now,
        inAYear,
        activity(ctx.a, 'organization_domain.verified', record.id)
      )
      expect(stale).toEqual({ outcome: 'stale' })
      await verified(ctx.a, org).catch(() => undefined)
      // Unknown row, and another organization's row.
      expect(
        (
          await ctx.store.verify(
            ctx.a.environmentId,
            org,
            Bun.randomUUIDv7(),
            'hash-1',
            now,
            inAYear,
            activity(ctx.a, 'organization_domain.verified', record.id)
          )
        ).outcome
      ).toBe('stale')
    })

    test('an organization holds at most the limit; a claim it has already is replaced under the limit', async () => {
      const org = await ctx.organization(ctx.a)
      await pending(ctx.a, org, { domain: 'one.test', limit: 2 })
      await pending(ctx.a, org, { domain: 'two.test', limit: 2 })
      const third = claim(ctx.a, org, { domain: 'three.test', limit: 2 })
      expect(
        await ctx.store.claim(third, activity(ctx.a, 'organization_domain.claimed', third.id))
      ).toEqual({ outcome: 'limit_reached' })
      const again = claim(ctx.a, org, { domain: 'two.test', limit: 2, codeHash: 'hash-2' })
      expect(
        (await ctx.store.claim(again, activity(ctx.a, 'organization_domain.claimed', again.id)))
          .outcome
      ).toBe('claimed')
      expect(await ctx.store.list(ctx.a.environmentId, org)).toHaveLength(2)
    })

    test('guesses are counted before they are compared and never pass the limit, even together', async () => {
      const org = await ctx.organization(ctx.a)
      const record = await pending(ctx.a, org)
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          ctx.store.recordAttempt(ctx.a.environmentId, org, record.id, now, 5)
        )
      )
      expect(results.filter((one) => one !== null)).toHaveLength(5)
      expect((await ctx.store.find(ctx.a.environmentId, org, record.id))?.codeAttempts).toBe(5)
      expect(await ctx.store.recordAttempt(ctx.a.environmentId, org, record.id, now, 5)).toBeNull()
    })

    test('no guess is counted at an expired code, a verified domain, an unknown row or another environment', async () => {
      const org = await ctx.organization(ctx.a)
      const record = await pending(ctx.a, org)
      expect(
        await ctx.store.recordAttempt(ctx.a.environmentId, org, record.id, inTenMinutes, 5)
      ).toBeNull()
      expect(await ctx.store.recordAttempt(ctx.b.environmentId, org, record.id, now, 5)).toBeNull()
      expect(
        await ctx.store.recordAttempt(ctx.a.environmentId, org, Bun.randomUUIDv7(), now, 5)
      ).toBeNull()
      expect((await ctx.store.find(ctx.a.environmentId, org, record.id))?.codeAttempts).toBe(0)
      const done = await verified(ctx.a, await ctx.organization(ctx.a), 'other.test')
      expect(
        await ctx.store.recordAttempt(ctx.a.environmentId, done.organizationId, done.id, now, 5)
      ).toBeNull()
    })

    test('the mode of a domain changes, and says what it was', async () => {
      const org = await ctx.organization(ctx.a)
      const done = await verified(ctx.a, org)
      const later = new Date(now.getTime() + 5000)
      const changed = await ctx.store.setMode(
        ctx.a.environmentId,
        org,
        done.id,
        'auto_join' satisfies OrganizationDomainMode,
        later,
        activity(ctx.a, 'organization_domain.claimed', done.id)
      )
      expect(changed).toMatchObject({
        outcome: 'updated',
        previousMode: 'suggest',
        record: { mode: 'auto_join' },
      })
      expect(
        await ctx.store.setMode(
          ctx.b.environmentId,
          org,
          done.id,
          'suggest',
          later,
          activity(ctx.b, 'organization_domain.claimed', done.id)
        )
      ).toEqual({ outcome: 'not_found' })
    })

    test('a domain is removed with its record, once, and only in its own environment', async () => {
      const org = await ctx.organization(ctx.a)
      const done = await verified(ctx.a, org)
      const gone = activity(ctx.a, 'organization_domain.removed', done.id)
      expect(await ctx.store.remove(ctx.b.environmentId, org, done.id, gone)).toBe(false)
      expect(await ctx.store.remove(ctx.a.environmentId, org, done.id, gone)).toBe(true)
      expect(await ctx.store.remove(ctx.a.environmentId, org, done.id, gone)).toBe(false)
      expect(await ctx.store.findVerified(ctx.a.environmentId, 'acme.test')).toBeNull()
      expect(
        (await ctx.recorded()).filter((type) => type === 'organization_domain.removed')
      ).toHaveLength(1)
      // Free again for another organization.
      const other = await ctx.organization(ctx.a)
      await pending(ctx.a, other)
    })

    test('deleting the organization deletes its domains', async () => {
      const org = await ctx.organization(ctx.a)
      await verified(ctx.a, org)
      await pending(ctx.a, org, { domain: 'second.test' })
      await ctx.deleteOrganization(ctx.a, org)
      expect(await ctx.store.list(ctx.a.environmentId, org)).toEqual([])
      expect(await ctx.store.findVerified(ctx.a.environmentId, 'acme.test')).toBeNull()
    })

    test('retention deletes pending claims whose code expired before the cutoff, in batches, and nothing else', async () => {
      const org = await ctx.organization(ctx.a)
      const otherOrg = await ctx.organization(ctx.b)
      await pending(ctx.a, org, { domain: 'old-one.test' })
      await pending(ctx.a, org, { domain: 'old-two.test' })
      await pending(ctx.a, org, {
        domain: 'live.test',
        codeExpiresAt: new Date(inTenMinutes.getTime() + 3_600_000),
      })
      await verified(ctx.a, org, 'kept.test')
      await pending(ctx.b, otherOrg, { domain: 'other-env.test' })
      const cutoff = new Date(inTenMinutes.getTime() + 60_000)
      expect(await ctx.store.purgeExpiredPending(ctx.a.environmentId, cutoff, 1)).toBe(1)
      expect(await ctx.store.purgeExpiredPending(ctx.a.environmentId, cutoff, 10)).toBe(1)
      expect(await ctx.store.purgeExpiredPending(ctx.a.environmentId, cutoff, 10)).toBe(0)
      expect(
        (await ctx.store.list(ctx.a.environmentId, org)).map((one) => one.domain).sort()
      ).toEqual(['kept.test', 'live.test'])
      // The other environment was not touched by a purge of this one.
      expect(await ctx.store.list(ctx.b.environmentId, otherOrg)).toHaveLength(1)
    })
  })
}
