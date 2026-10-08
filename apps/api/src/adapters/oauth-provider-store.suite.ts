import { beforeEach, describe, expect, test } from 'bun:test'
import * as Audit from '~/modules/audit/service'
import type { Activity } from '~/ports/activity-log'
import type { OAuthProviderRecord, OAuthProviderStore } from '~/ports/oauth-provider-store'

/** A tenant for the suite. */
export interface OAuthSuiteTenant {
  projectId: string
  environmentId: string
}

/** What a store under test provides. */
export interface OAuthSuiteContext {
  store: OAuthProviderStore
  /** The audit actions recorded so far, oldest first. */
  recorded: () => Promise<string[]>
  a: OAuthSuiteTenant
  b: OAuthSuiteTenant
}

/**
 * Behaviour every `OAuthProviderStore` must have. Run against each adapter so the memory store
 * used by unit tests can't drift from Postgres.
 *
 * @param name - Adapter name for the report.
 * @param setup - Builds a fresh context; called before each test.
 */
export function describeOAuthProviderStore(
  name: string,
  setup: () => Promise<OAuthSuiteContext>
): void {
  describe(`${name} (OAuthProviderStore)`, () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    const later = new Date('2026-01-02T00:00:00.000Z')
    let ctx: OAuthSuiteContext

    beforeEach(async () => {
      ctx = await setup()
    })

    function record(
      tenant: OAuthSuiteTenant,
      overrides: Partial<OAuthProviderRecord> = {}
    ): OAuthProviderRecord {
      return {
        id: Bun.randomUUIDv7(),
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        provider: 'google',
        clientId: 'client-id',
        secret: 'v1.sealed.secret',
        config: {},
        enabled: true,
        createdAt: now,
        updatedAt: now,
        ...overrides,
      }
    }

    function activity(tenant: OAuthSuiteTenant, type: Activity['type']): Activity {
      return {
        id: Bun.randomUUIDv7(),
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        type,
        actor: { type: 'admin', id: null },
        target: { type: 'environment', id: tenant.environmentId },
        ipAddress: null,
        userAgent: null,
        data: { provider: 'google' },
        occurredAt: now,
      }
    }

    test('stores a provider and reads it back, in its environment only', async () => {
      const input = record(ctx.a, { provider: 'apple', config: { teamId: 'TEAM', keyId: 'KEY' } })
      expect(await ctx.store.upsert(input, Audit.none('fixture'))).toEqual(input)
      expect(await ctx.store.find(ctx.a.environmentId, 'apple')).toEqual(input)
      expect(await ctx.store.find(ctx.a.environmentId, 'google')).toBeNull()
      expect(await ctx.store.find(ctx.b.environmentId, 'apple')).toBeNull()
      expect(await ctx.store.list(ctx.b.environmentId)).toEqual([])
    })

    test('lists an environment’s providers in a stable order', async () => {
      for (const provider of ['google', 'apple', 'github'] as const) {
        await ctx.store.upsert(record(ctx.a, { provider }), Audit.none('fixture'))
      }
      await ctx.store.upsert(record(ctx.b), Audit.none('fixture'))
      expect((await ctx.store.list(ctx.a.environmentId)).map((row) => row.provider)).toEqual([
        'apple',
        'github',
        'google',
      ])
    })

    test('a second save replaces the credentials and keeps the row’s id and creation time', async () => {
      const first = await ctx.store.upsert(record(ctx.a), Audit.none('fixture'))
      const second = await ctx.store.upsert(
        record(ctx.a, {
          clientId: 'new-client',
          secret: 'v1.other.secret',
          enabled: false,
          createdAt: later,
          updatedAt: later,
        }),
        Audit.none('fixture')
      )
      expect(second).toEqual({
        ...first,
        clientId: 'new-client',
        secret: 'v1.other.secret',
        enabled: false,
        updatedAt: later,
      })
      expect(await ctx.store.list(ctx.a.environmentId)).toHaveLength(1)
    })

    test('two concurrent first saves leave one row', async () => {
      await Promise.all([1, 2].map(() => ctx.store.upsert(record(ctx.a), Audit.none('fixture'))))
      expect(await ctx.store.list(ctx.a.environmentId)).toHaveLength(1)
    })

    test('the same provider in two environments is two rows', async () => {
      await ctx.store.upsert(record(ctx.a, { clientId: 'a' }), Audit.none('fixture'))
      await ctx.store.upsert(record(ctx.b, { clientId: 'b' }), Audit.none('fixture'))
      expect((await ctx.store.find(ctx.a.environmentId, 'google'))?.clientId).toBe('a')
      expect((await ctx.store.find(ctx.b.environmentId, 'google'))?.clientId).toBe('b')
    })

    test('deletes a provider, in its environment only', async () => {
      await ctx.store.upsert(record(ctx.a), Audit.none('fixture'))
      expect(await ctx.store.delete(ctx.b.environmentId, 'google', Audit.none('fixture'))).toBe(
        false
      )
      expect(await ctx.store.delete(ctx.a.environmentId, 'github', Audit.none('fixture'))).toBe(
        false
      )
      expect(await ctx.store.delete(ctx.a.environmentId, 'google', Audit.none('fixture'))).toBe(
        true
      )
      expect(await ctx.store.delete(ctx.a.environmentId, 'google', Audit.none('fixture'))).toBe(
        false
      )
      expect(await ctx.store.find(ctx.a.environmentId, 'google')).toBeNull()
    })

    test('records the activity with the change, and none for a delete that removed nothing', async () => {
      await ctx.store.upsert(record(ctx.a), activity(ctx.a, 'oauth_provider.updated'))
      await ctx.store.delete(
        ctx.a.environmentId,
        'github',
        activity(ctx.a, 'oauth_provider.deleted')
      )
      expect(await ctx.recorded()).toEqual(['oauth_provider.updated'])
      await ctx.store.delete(
        ctx.a.environmentId,
        'google',
        activity(ctx.a, 'oauth_provider.deleted')
      )
      expect(await ctx.recorded()).toEqual(['oauth_provider.updated', 'oauth_provider.deleted'])
    })
  })
}
