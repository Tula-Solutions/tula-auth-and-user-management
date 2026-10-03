import { beforeEach, describe, expect, test } from 'bun:test'
import { DEFAULT_ENVIRONMENT_SETTINGS, type EnvironmentSettings } from '@tula/contract'
import type { Activity, ActivityLog } from '~/ports/activity-log'
import type { EnvironmentSettingsStore } from '~/ports/environment-settings-store'

/** A tenant for the suite. */
export interface SettingsSuiteTenant {
  projectId: string
  environmentId: string
}

/** What a store under test provides. */
export interface SettingsSuiteContext {
  store: EnvironmentSettingsStore
  /** The audit log the store records into. */
  log: ActivityLog
  /** A tenant no other test has touched. */
  freshTenant: () => Promise<SettingsSuiteTenant>
}

/**
 * Behaviour every `EnvironmentSettingsStore` must have. Run against the memory adapter and
 * against Postgres (PGlite, as the runtime role), so the store unit tests use cannot drift from
 * the real one.
 *
 * @param name - Adapter name for the report.
 * @param setup - Builds the context; called before each test.
 */
export function describeEnvironmentSettingsStore(
  name: string,
  setup: () => Promise<SettingsSuiteContext>
): void {
  describe(`${name} (EnvironmentSettingsStore)`, () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    let ctx: SettingsSuiteContext
    let a: SettingsSuiteTenant
    let b: SettingsSuiteTenant

    beforeEach(async () => {
      ctx = await setup()
      a = await ctx.freshTenant()
      b = await ctx.freshTenant()
    })

    function named(appName: string, origins: string[] = []): EnvironmentSettings {
      return {
        ...DEFAULT_ENVIRONMENT_SETTINGS,
        app: { name: appName, supportEmail: null },
        urls: { allowedOrigins: origins, allowedRedirectUrls: [] },
      }
    }

    function activity(tenant: SettingsSuiteTenant, changed: string[]): Activity {
      return {
        id: Bun.randomUUIDv7(),
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        type: 'environment.settings_updated',
        actor: { type: 'admin', id: 'key_1' },
        target: { type: 'environment', id: tenant.environmentId },
        ipAddress: '203.0.113.9',
        userAgent: 'suite/1.0',
        data: { changed },
        occurredAt: now,
      }
    }

    const replace = (
      tenant: SettingsSuiteTenant,
      expected: number,
      settings: EnvironmentSettings,
      changed: string[] = ['app.name']
    ) => ctx.store.replace(tenant.environmentId, expected, settings, now, activity(tenant, changed))

    async function audited(tenant: SettingsSuiteTenant) {
      const { entries } = await ctx.log.listAudit(tenant.environmentId, {
        action: 'environment.settings_updated',
        page: 1,
        size: 50,
      })
      return entries.map((entry) => entry.data)
    }

    test('an environment that never saved settings has none', async () => {
      expect(await ctx.store.get(a.environmentId)).toBeNull()
    })

    test('the first save is revision 1 and reads back whole', async () => {
      const saved = await replace(a, 0, named('Acme', ['https://app.acme.test']))
      expect(saved).toEqual({ revision: 1, settings: named('Acme', ['https://app.acme.test']) })
      expect(await ctx.store.get(a.environmentId)).toEqual(saved)
    })

    test('each replace that names the current revision moves to the next one', async () => {
      await replace(a, 0, named('One'))
      expect(await replace(a, 1, named('Two'))).toEqual({ revision: 2, settings: named('Two') })
      expect(await replace(a, 2, named('Three'))).toEqual({
        revision: 3,
        settings: named('Three'),
      })
      expect((await ctx.store.get(a.environmentId))?.settings.app.name).toBe('Three')
    })

    test.each<[string, number]>([
      ['an older revision', 1],
      ['a revision that does not exist yet', 7],
      ['revision 0 once settings exist', 0],
    ])('a replace naming %s changes nothing and records nothing', async (_, expected) => {
      await replace(a, 0, named('One'))
      await replace(a, 1, named('Two'))
      expect(await replace(a, expected, named('Stale'), ['stale'])).toBeNull()
      expect(await ctx.store.get(a.environmentId)).toEqual({ revision: 2, settings: named('Two') })
      expect(await audited(a)).toHaveLength(2)
    })

    test('a replace naming a revision is refused while nothing is saved', async () => {
      expect(await replace(a, 1, named('Early'))).toBeNull()
      expect(await ctx.store.get(a.environmentId)).toBeNull()
      expect(await audited(a)).toEqual([])
    })

    test('of two first saves made at once exactly one wins', async () => {
      const results = await Promise.all([
        replace(a, 0, named('Left'), ['left']),
        replace(a, 0, named('Right'), ['right']),
      ])
      const won = results.filter((result) => result !== null)
      expect(won).toHaveLength(1)
      expect(await ctx.store.get(a.environmentId)).toEqual(won[0] ?? null)
      // Only the winner is on record.
      expect(await audited(a)).toEqual([
        { changed: [won[0]?.settings.app.name === 'Left' ? 'left' : 'right'] },
      ])
    })

    test('of two replaces of the same revision made at once exactly one wins', async () => {
      await replace(a, 0, named('Start'))
      const results = await Promise.all([
        replace(a, 1, named('Left'), ['left']),
        replace(a, 1, named('Right'), ['right']),
      ])
      const won = results.filter((result) => result !== null)
      expect(won).toHaveLength(1)
      expect(won[0]?.revision).toBe(2)
      expect(await ctx.store.get(a.environmentId)).toEqual(won[0] ?? null)
      expect(await audited(a)).toHaveLength(2)
    })

    test('the change is on record with the keys it was given, in the same write', async () => {
      await replace(a, 0, named('Acme'), ['app.name', 'urls.allowedOrigins'])
      expect(await audited(a)).toEqual([{ changed: ['app.name', 'urls.allowedOrigins'] }])
    })

    test('one environment’s settings are invisible to, and untouched by, another', async () => {
      await replace(a, 0, named('A'))
      expect(await ctx.store.get(b.environmentId)).toBeNull()
      // B is still at revision 0, whatever A's revision is.
      expect(await replace(b, 1, named('B'))).toBeNull()
      expect(await replace(b, 0, named('B'))).toEqual({ revision: 1, settings: named('B') })
      expect((await ctx.store.get(a.environmentId))?.settings.app.name).toBe('A')
      expect(await audited(b)).toHaveLength(1)
    })

    test('the allowed origins of every environment are listed once each', async () => {
      await replace(a, 0, named('A', ['https://a.test', 'https://shared.test']))
      await replace(b, 0, named('B', ['https://b.test', 'https://shared.test']))
      const origins = await ctx.store.allowedOrigins()
      for (const origin of ['https://a.test', 'https://b.test', 'https://shared.test']) {
        expect(origins.filter((listed) => listed === origin)).toEqual([origin])
      }
      await replace(a, 1, named('A', []))
      expect(await ctx.store.allowedOrigins()).not.toContain('https://a.test')
      expect(await ctx.store.allowedOrigins()).toContain('https://shared.test')
    })
  })
}
