import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { DEFAULT_ENVIRONMENT_SETTINGS, type EnvironmentSettings } from '@tula/contract'
import { resetStoredManagerWarnings } from '~/adapters/settings-manager'
import * as logger from '~/lib/logger'
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
  /**
   * Put a managing-tool record on a tenant's saved settings directly, past the store's own
   * write path: what another version, or a hand, may have left there.
   */
  storeManager: (tenant: SettingsSuiteTenant, manager: unknown) => Promise<void>
  /**
   * Put a settings document where a tenant that has saved none keeps its own, directly and
   * at revision 1, past the store's own write path: what another version, or a hand, may
   * have left there. The document is whatever JSON holds, not only what the API would store.
   */
  storeDocument: (tenant: SettingsSuiteTenant, settings: unknown) => Promise<void>
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
        // A whole event of its type: the outbox payload is built from this (ADR 0012).
        data: { revision: 1, changed },
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

    const HASH = `sha256:${'ab'.repeat(32)}`

    test('a replace that names a manager stores it with the revision it wrote', async () => {
      const saved = await ctx.store.replace(
        a.environmentId,
        0,
        named('Managed'),
        now,
        activity(a, ['app.name']),
        { tool: 'tula-apply', configHash: HASH }
      )
      const managedBy = { tool: 'tula-apply', configHash: HASH, at: now.toISOString(), revision: 1 }
      expect(saved?.managedBy).toEqual(managedBy)
      expect((await ctx.store.get(a.environmentId, true))?.managedBy).toEqual(managedBy)
    })

    test('a replace that names no manager keeps the one on record, at its old revision', async () => {
      await ctx.store.replace(a.environmentId, 0, named('Managed'), now, activity(a, []), {
        tool: 'tula-apply',
        configHash: HASH,
      })
      const later = new Date(now.getTime() + 60_000)
      const edited = await ctx.store.replace(
        a.environmentId,
        1,
        named('Edited by hand'),
        later,
        activity(a, ['app.name'])
      )
      expect(edited?.revision).toBe(2)
      expect(edited?.managedBy).toEqual({
        tool: 'tula-apply',
        configHash: HASH,
        at: now.toISOString(),
        revision: 1,
      })
    })

    test('a replace that names `null` removes the manager', async () => {
      await ctx.store.replace(a.environmentId, 0, named('Managed'), now, activity(a, []), {
        tool: 'tula-apply',
        configHash: HASH,
      })
      const detached = await ctx.store.replace(
        a.environmentId,
        1,
        named('Managed'),
        now,
        activity(a, []),
        null
      )
      expect(detached?.managedBy).toBeUndefined()
      expect((await ctx.store.get(a.environmentId, true))?.managedBy).toBeUndefined()
    })

    describe('a stored manager this version would not answer', () => {
      test.each<[string, unknown]>([
        [
          'a tool name outside the pattern',
          { tool: 'Bad Tool!', configHash: 'x', at: 'now', revision: 1 },
        ],
        [
          'a hash that is not one',
          { tool: 'tula-apply', configHash: 'x', at: now.toISOString(), revision: 1 },
        ],
        [
          'a time that is not one',
          { tool: 'tula-apply', configHash: HASH, at: 'now', revision: 1 },
        ],
        [
          'a revision below 1',
          { tool: 'tula-apply', configHash: HASH, at: now.toISOString(), revision: 0 },
        ],
        [
          'a revision that is not whole',
          { tool: 'tula-apply', configHash: HASH, at: now.toISOString(), revision: 1.5 },
        ],
        ['a missing field', { tool: 'tula-apply', configHash: HASH }],
        ['a string', 'tula-apply'],
        ['a list', ['tula-apply']],
      ])('%s reads as unmanaged, and a replace still answers', async (_name, manager) => {
        await replace(a, 0, named('One'))
        await ctx.storeManager(a, manager)
        expect(await ctx.store.get(a.environmentId, true)).toEqual({
          revision: 1,
          settings: named('One'),
        })
        // A replace that names no manager keeps the column as it is: what it answers must
        // still be something the API can send.
        expect(await replace(a, 1, named('Two'))).toEqual({ revision: 2, settings: named('Two') })
        expect(await ctx.store.get(a.environmentId, true)).toEqual({
          revision: 2,
          settings: named('Two'),
        })
      })

      test('it is said once per environment, with none of the record in the log', async () => {
        resetStoredManagerWarnings()
        const warn = spyOn(logger, 'warn').mockImplementation(() => {})
        try {
          await replace(a, 0, named('One'))
          await ctx.storeManager(a, { tool: 'Bad Tool!', configHash: 'x', at: 'now', revision: 1 })
          await ctx.store.get(a.environmentId, true)
          await ctx.store.get(a.environmentId, true)
          await replace(a, 1, named('Two'))
          expect(warn.mock.calls).toEqual([
            [
              'the stored record of which tool manages the settings is not valid; the settings are treated as unmanaged',
              { environmentId: a.environmentId },
            ],
          ])
          expect(JSON.stringify(warn.mock.calls)).not.toContain('Bad Tool!')
        } finally {
          warn.mockRestore()
        }
      })

      test('a replace that names a manager puts a good record in its place', async () => {
        await replace(a, 0, named('One'))
        await ctx.storeManager(a, { tool: 'Bad Tool!', configHash: 'x', at: 'now', revision: 1 })
        const saved = await ctx.store.replace(
          a.environmentId,
          1,
          named('Two'),
          now,
          activity(a, []),
          {
            tool: 'tula-apply',
            configHash: HASH,
          }
        )
        expect(saved?.managedBy).toEqual({
          tool: 'tula-apply',
          configHash: HASH,
          at: now.toISOString(),
          revision: 2,
        })
      })

      test('a record that is valid is still read as it was stored', async () => {
        await replace(a, 0, named('One'))
        const manager = { tool: 'terraform', configHash: HASH, at: now.toISOString(), revision: 1 }
        await ctx.storeManager(a, manager)
        expect((await ctx.store.get(a.environmentId, true))?.managedBy).toEqual(manager)
      })
    })

    // Every adapter reads a stored document the same way (`readStoredRow`): the store unit
    // tests use must not hand a service what the real one would have altered or refused.
    describe('a stored document the API did not write', () => {
      test('one from another version reads with today’s defaults, without the keys this one does not know', async () => {
        await ctx.storeDocument(a, {
          app: { name: 'Acme', logoUrl: 'https://acme.test/logo.png' },
          futureSection: { enabled: true },
        })
        expect(await ctx.store.get(a.environmentId, true)).toEqual({
          revision: 1,
          settings: { ...DEFAULT_ENVIRONMENT_SETTINGS, app: { name: 'Acme', supportEmail: null } },
        })
      })

      test('an empty one is every default', async () => {
        await ctx.storeDocument(a, {})
        expect(await ctx.store.get(a.environmentId, true)).toEqual({
          revision: 1,
          settings: DEFAULT_ENVIRONMENT_SETTINGS,
        })
      })

      test('a list entry settings would refuse is left out, said with a count and never the entry', async () => {
        const warn = spyOn(logger, 'warn').mockImplementation(() => {})
        try {
          await ctx.storeDocument(a, {
            app: { name: 'Acme' },
            urls: {
              allowedOrigins: ['http://app.lan', 'https://app.acme.test', 'https://app.acme.test'],
            },
            sms: { allowedCountries: ['GB', 'not a country'] },
          })
          expect(await ctx.store.get(a.environmentId, true)).toEqual({
            revision: 1,
            settings: {
              ...DEFAULT_ENVIRONMENT_SETTINGS,
              app: { name: 'Acme', supportEmail: null },
              urls: { allowedOrigins: ['https://app.acme.test'], allowedRedirectUrls: [] },
              sms: { ...DEFAULT_ENVIRONMENT_SETTINGS.sms, allowedCountries: ['GB'] },
            },
          })
          expect(warn.mock.calls).toEqual([
            [
              'stored environment settings held list entries that are not valid; they were ignored',
              { environmentId: a.environmentId, dropped: 3 },
            ],
          ])
          // The union for preflights leaves the entry out as well.
          const origins = await ctx.store.allowedOrigins()
          expect(origins).not.toContain('http://app.lan')
          expect(origins.filter((origin) => origin === 'https://app.acme.test')).toHaveLength(1)
        } finally {
          warn.mockRestore()
        }
      })

      test('wording this version cannot use is left out and said by kind, never by its text', async () => {
        const warn = spyOn(logger, 'warn').mockImplementation(() => {})
        const canary = 'canary-wording-2a6c'
        try {
          await ctx.storeDocument(a, {
            emails: {
              templates: {
                step_up: { subject: `${canary} kept`, body: '{{code}}' },
                // A placeholder a later version had, a notice with a link, a kind not known here.
                password_reset: { body: `${canary} {{code}} {{firstName}}` },
                new_sign_in: { body: `${canary} https://evil.test` },
                later_kind: { body: canary },
              },
            },
            sms: {
              templates: {
                sign_in: { text: `Your code is {{code}}` },
                // No code at all, and a kind not known here.
                phone_verification: { text: canary },
                later_kind: { text: `${canary} {{code}}` },
              },
            },
          })
          const read = await ctx.store.get(a.environmentId, true)
          expect(read?.settings.emails).toEqual({
            templates: { step_up: { subject: `${canary} kept`, body: '{{code}}' } },
          })
          expect(read?.settings.sms.templates).toEqual({
            sign_in: { text: 'Your code is {{code}}' },
          })
          expect(warn.mock.calls).toEqual([
            [
              'stored text message template this version cannot use was ignored; the built-in text is sent in its place',
              { environmentId: a.environmentId, kinds: ['phone_verification'], unknownKinds: 1 },
            ],
            [
              'stored email template text this version cannot use was ignored; the built-in copy is sent in its place',
              {
                environmentId: a.environmentId,
                kinds: ['password_reset', 'new_sign_in'],
                unknownKinds: 1,
              },
            ],
          ])
          expect(JSON.stringify(warn.mock.calls).replaceAll(`${canary} kept`, '')).not.toContain(
            canary
          )
        } finally {
          warn.mockRestore()
        }
      })

      // A scalar of a known field that is not valid is not left out and not defaulted: the
      // read throws, in every adapter, and what reads the settings has to stand that.
      test.each<[string, unknown]>([
        [
          'a password history below zero',
          { password: { ...DEFAULT_ENVIRONMENT_SETTINGS.password, history: -1 } },
        ],
        [
          'a password history that is text',
          { password: { ...DEFAULT_ENVIRONMENT_SETTINGS.password, history: '2' } },
        ],
        ['a password policy with a field missing', { password: { minLength: 12 } }],
        ['an audit period of zero', { audit: { retentionDays: 0 } }],
        ['an audit period that is text', { audit: { retentionDays: '30' } }],
        ['an MFA policy this version does not know', { mfa: { policy: 'sometimes' } }],
        ['a document that is a string', 'settings'],
      ])(
        '%s cannot be read: the read throws, and the origins are still listed',
        async (_name, settings) => {
          await ctx.storeDocument(a, settings)
          await replace(b, 0, named('B', ['https://b.test']))
          await expect(ctx.store.get(a.environmentId, true)).rejects.toThrow()
          // Another environment is read as before, and a preflight is still answered.
          expect((await ctx.store.get(b.environmentId, true))?.settings.app.name).toBe('B')
          expect(await ctx.store.allowedOrigins()).toContain('https://b.test')
        }
      )

      test('a replace puts a readable document in the place of one that could not be read', async () => {
        await ctx.storeDocument(a, { audit: { retentionDays: 0 } })
        await expect(ctx.store.get(a.environmentId, true)).rejects.toThrow()
        expect(await replace(a, 1, named('Repaired'))).toEqual({
          revision: 2,
          settings: named('Repaired'),
        })
        expect(await ctx.store.get(a.environmentId, true)).toEqual({
          revision: 2,
          settings: named('Repaired'),
        })
      })

      test('the origin list survives documents of any shape', async () => {
        await ctx.storeDocument(a, {
          urls: { allowedOrigins: ['https://odd-shape.test', 7, null] },
        })
        await ctx.storeDocument(b, { urls: { allowedOrigins: 'https://not-a-list.test' } })
        await ctx.storeDocument(await ctx.freshTenant(), { urls: null })
        await ctx.storeDocument(await ctx.freshTenant(), 'https://not-a-document.test')
        const origins = await ctx.store.allowedOrigins()
        expect(origins).toContain('https://odd-shape.test')
        expect(origins).not.toContain('https://not-a-list.test')
        expect(origins.every((origin) => typeof origin === 'string')).toBe(true)
      })
    })

    test('a refused replace leaves the manager as it was', async () => {
      await ctx.store.replace(a.environmentId, 0, named('Managed'), now, activity(a, []), {
        tool: 'tula-apply',
        configHash: HASH,
      })
      expect(
        await ctx.store.replace(a.environmentId, 0, named('Stale'), now, activity(a, []), null)
      ).toBeNull()
      expect((await ctx.store.get(a.environmentId, true))?.managedBy?.revision).toBe(1)
    })

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
        { revision: 1, changed: [won[0]?.settings.app.name === 'Left' ? 'left' : 'right'] },
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
      expect(await audited(a)).toEqual([
        { revision: 1, changed: ['app.name', 'urls.allowedOrigins'] },
      ])
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
