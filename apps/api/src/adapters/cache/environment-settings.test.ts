import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { DEFAULT_ENVIRONMENT_SETTINGS, type EnvironmentSettings } from '@tula/contract'
import { ALL_ORIGINS, cacheEnvironmentSettings } from '~/adapters/cache/environment-settings'
import type { Versions } from '~/adapters/cache/versioned'
import { describeEnvironmentSettingsStore } from '~/adapters/environment-settings-store.suite'
import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { FixedClock } from '~/adapters/memory/clock'
import { MemoryEnvironmentSettingsStore } from '~/adapters/memory/environment-settings'
import { FakeRedis } from '~/adapters/redis/fake'
import { RedisVersions } from '~/adapters/redis/versions'
import * as logger from '~/lib/logger'
import type { Activity } from '~/ports/activity-log'
import type { EnvironmentSettingsStore } from '~/ports/environment-settings-store'

const TTL_MS = 30_000
const CHECK_MS = 5_000
const E1 = '00000000-0000-7000-8000-00000000e001'
const E2 = '00000000-0000-7000-8000-00000000e002'

// The cache must behave exactly like the store it wraps.
describeEnvironmentSettingsStore('cacheEnvironmentSettings over memory', async () => {
  const log = new MemoryActivityLog()
  const inner = new MemoryEnvironmentSettingsStore(log)
  return {
    store: cacheEnvironmentSettings(inner, new FixedClock(), TTL_MS),
    log,
    storeManager: async (tenant, manager) => inner.seedManager(tenant.environmentId, manager),
    freshTenant: async () => ({
      projectId: '00000000-0000-7000-8000-00000000a001',
      environmentId: Bun.randomUUIDv7(),
    }),
  }
})

let clock: FixedClock
let store: MemoryEnvironmentSettingsStore
let reads: { get: number; origins: number }
let counted: EnvironmentSettingsStore

function named(name: string, origins: string[] = []): EnvironmentSettings {
  return {
    ...DEFAULT_ENVIRONMENT_SETTINGS,
    app: { name, supportEmail: null },
    urls: { allowedOrigins: origins, allowedRedirectUrls: [] },
  }
}

function activity(environmentId: string): Activity {
  return {
    id: Bun.randomUUIDv7(),
    projectId: '00000000-0000-7000-8000-00000000a001',
    environmentId,
    type: 'environment.settings_updated',
    actor: { type: 'admin', id: 'key_1' },
    target: { type: 'environment', id: environmentId },
    ipAddress: null,
    userAgent: null,
    data: { revision: 1, changed: ['app.name'] },
    occurredAt: clock.now(),
  }
}

const save = (
  through: EnvironmentSettingsStore,
  environmentId: string,
  expected: number,
  settings: EnvironmentSettings
) => through.replace(environmentId, expected, settings, clock.now(), activity(environmentId))

beforeEach(() => {
  clock = new FixedClock()
  store = new MemoryEnvironmentSettingsStore()
  reads = { get: 0, origins: 0 }
  counted = {
    get: (environmentId) => {
      reads.get += 1
      return store.get(environmentId)
    },
    replace: (...args) => store.replace(...args),
    allowedOrigins: () => {
      reads.origins += 1
      return store.allowedOrigins()
    },
  }
})

const instance = (versions?: Versions) =>
  cacheEnvironmentSettings(counted, clock, TTL_MS, versions && { versions, checkEveryMs: CHECK_MS })

describe('one instance', () => {
  test('reads the store once per TTL, including for an environment with nothing saved', async () => {
    const cache = instance()
    expect(await cache.get(E1)).toBeNull()
    expect(await cache.get(E1)).toBeNull()
    expect(reads.get).toBe(1)
    clock.advance(TTL_MS - 1)
    await cache.get(E1)
    expect(reads.get).toBe(1)
    clock.advance(1)
    await cache.get(E1)
    expect(reads.get).toBe(2)
  })

  test('environments are cached apart', async () => {
    const cache = instance()
    await save(cache, E1, 0, named('One'))
    expect((await cache.get(E1))?.settings.app.name).toBe('One')
    expect(await cache.get(E2)).toBeNull()
  })

  test('concurrent misses share one read', async () => {
    const cache = instance()
    await Promise.all([cache.get(E1), cache.get(E1), cache.get(E1)])
    expect(reads.get).toBe(1)
  })

  test('its own write is visible to it immediately', async () => {
    const cache = instance()
    expect(await cache.get(E1)).toBeNull()
    await save(cache, E1, 0, named('Acme', ['https://acme.test']))
    expect(await cache.get(E1)).toEqual({
      revision: 1,
      settings: named('Acme', ['https://acme.test']),
    })
    expect(await cache.allowedOrigins()).toEqual(['https://acme.test'])
    await save(cache, E1, 1, named('Acme', []))
    expect(await cache.allowedOrigins()).toEqual([])
  })

  test('a replace that loses the compare-and-set also drops the stale entry', async () => {
    const cache = instance()
    expect(await cache.get(E1)).toBeNull()
    // Another instance saves; this one still has "nothing saved" cached.
    await save(store, E1, 0, named('Elsewhere'))
    expect(await save(cache, E1, 0, named('Mine'))).toBeNull()
    expect((await cache.get(E1))?.settings.app.name).toBe('Elsewhere')
  })

  test('a replace that fails still drops the entry, and the failure reaches the caller', async () => {
    const cache = instance()
    await cache.get(E1)
    counted.replace = async () => {
      throw new Error('connection lost')
    }
    await expect(save(cache, E1, 0, named('Mine'))).rejects.toThrow('connection lost')
    await cache.get(E1)
    expect(reads.get).toBe(2)
  })

  test('a fresh read goes to the store and refills the cache', async () => {
    const cache = instance()
    expect(await cache.get(E1)).toBeNull()
    await save(store, E1, 0, named('Elsewhere'))
    expect(await cache.get(E1)).toBeNull()
    expect((await cache.get(E1, true))?.settings.app.name).toBe('Elsewhere')
    expect((await cache.get(E1))?.settings.app.name).toBe('Elsewhere')
    expect(reads.get).toBe(2)
  })

  test('a failed read is not cached', async () => {
    const cache = instance()
    const get = counted.get
    counted.get = async () => {
      throw new Error('connection lost')
    }
    await expect(cache.get(E1)).rejects.toThrow('connection lost')
    counted.get = get
    expect(await cache.get(E1)).toBeNull()
  })

  test('the origin union is read once per TTL', async () => {
    const cache = instance()
    await save(store, E1, 0, named('One', ['https://one.test']))
    expect(await cache.allowedOrigins()).toEqual(['https://one.test'])
    await cache.allowedOrigins()
    expect(reads.origins).toBe(1)
    clock.advance(TTL_MS)
    await cache.allowedOrigins()
    expect(reads.origins).toBe(2)
  })
})

describe('two instances without a shared marker', () => {
  test('the other instance applies a change once its entry expires, and no later', async () => {
    const [a, b] = [instance(), instance()]
    expect(await b.get(E1)).toBeNull()
    expect(await b.allowedOrigins()).toEqual([])
    await save(a, E1, 0, named('Acme', ['https://acme.test']))
    clock.advance(TTL_MS - 1)
    expect(await b.get(E1)).toBeNull()
    expect(await b.allowedOrigins()).toEqual([])
    clock.advance(1)
    expect((await b.get(E1))?.settings.app.name).toBe('Acme')
    expect(await b.allowedOrigins()).toEqual(['https://acme.test'])
  })
})

describe('two instances sharing a marker', () => {
  let redis: FakeRedis
  const versions = () => new RedisVersions(redis, 'es')

  beforeEach(() => {
    redis = new FakeRedis(clock)
  })

  test('the other instance applies a change within the check interval', async () => {
    const [a, b] = [instance(versions()), instance(versions())]
    expect(await b.get(E1)).toBeNull()
    expect(await b.allowedOrigins()).toEqual([])
    await save(a, E1, 0, named('Acme', ['https://acme.test']))
    expect((await a.get(E1))?.revision).toBe(1)

    clock.advance(CHECK_MS - 1)
    expect(await b.get(E1)).toBeNull()
    clock.advance(1)
    expect(await b.get(E1)).toEqual({ revision: 1, settings: named('Acme', ['https://acme.test']) })
    expect(await b.allowedOrigins()).toEqual(['https://acme.test'])
  })

  test('markers are kept per environment, plus one for the origin union', async () => {
    const a = instance(versions())
    await save(a, E1, 0, named('Acme'))
    expect(redis.keys().sort()).toEqual([`tula:es:${ALL_ORIGINS}`, `tula:es:${E1}`].sort())
  })

  test('a change to one environment does not make the others reload', async () => {
    const [a, b] = [instance(versions()), instance(versions())]
    await b.get(E2)
    await save(a, E1, 0, named('Acme'))
    clock.advance(CHECK_MS)
    await b.get(E2)
    expect(reads.get).toBe(1)
  })

  test('a replace that changed nothing announces nothing', async () => {
    const a = instance(versions())
    expect(await save(a, E1, 3, named('Never'))).toBeNull()
    expect(redis.keys()).toEqual([])
  })

  test('a write still succeeds when it cannot be announced, and says so without the values', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    const broken: Versions = {
      current: async () => null,
      bump: async () => {
        throw new Error('redis down')
      },
    }
    const saved = await save(instance(broken), E1, 0, named('Acme', ['https://acme.test']))
    expect(saved?.revision).toBe(1)
    expect(warn.mock.calls).toEqual([
      [
        'could not announce new environment settings; other instances catch up at cache expiry',
        { environmentId: E1, reason: 'Error' },
      ],
      [
        'could not announce new allowed origins; other instances catch up at cache expiry',
        { environmentId: ALL_ORIGINS, reason: 'Error' },
      ],
    ])
    warn.mockRestore()
  })

  test('while the marker cannot be read the cached copy is served until it expires', async () => {
    let down = false
    const flaky: Versions = {
      current: async () => {
        if (down) {
          throw new Error('redis down')
        }
        return null
      },
      bump: async () => undefined,
    }
    const b = instance(flaky)
    expect(await b.get(E1)).toBeNull()
    await save(store, E1, 0, named('Acme'))
    down = true
    clock.advance(CHECK_MS)
    expect(await b.get(E1)).toBeNull()
    clock.advance(TTL_MS)
    expect((await b.get(E1))?.settings.app.name).toBe('Acme')
  })
})
