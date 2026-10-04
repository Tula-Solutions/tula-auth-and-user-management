import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SHIPPED_MIGRATIONS } from '@tula/db'
import { createTestDatabase, type TestDatabase } from '@tula/db/testing'
import { sql } from 'drizzle-orm'
import { createDiagnostics } from '~/adapters/system/diagnostics'

// PGlite is real Postgres with every migration applied, connected as the runtime role: the
// probe's SQL and the grant behind it are what is under test.
let testDb: TestDatabase

beforeAll(async () => {
  testDb = await createTestDatabase()
})

afterAll(async () => {
  await testDb.close()
})

function diagnostics(fetch?: (url: string, init: RequestInit) => Promise<Response>) {
  return createDiagnostics({
    db: testDb.db,
    mailer: { verify: async () => {} },
    redis: null,
    fetch,
  })
}

describe('createDiagnostics', () => {
  test('ships the journal’s migrations', () => {
    expect(diagnostics().shippedMigrations).toEqual(SHIPPED_MIGRATIONS.map((m) => m.when))
    expect(diagnostics().shippedMigrations.length).toBeGreaterThan(10)
  })

  test('database: the runtime role reads the applied migrations and the clock', async () => {
    const result = await diagnostics().database()
    expect(result.appliedMigrations).toEqual(SHIPPED_MIGRATIONS.map((m) => m.when))
    expect(Math.abs(result.now.getTime() - Date.now())).toBeLessThan(60_000)
  })

  test('database: a history that cannot be read is null, not an error', async () => {
    await testDb.setRole('postgres')
    await testDb.db.execute(sql`alter function tula.applied_migrations() rename to hidden`)
    await testDb.setRole('tula_app')
    try {
      expect((await diagnostics().database()).appliedMigrations).toBeNull()
    } finally {
      await testDb.setRole('postgres')
      await testDb.db.execute(sql`alter function tula.hidden() rename to applied_migrations`)
      await testDb.setRole('tula_app')
    }
  })

  test('httpStatus: one GET, no redirect followed, no credentials, the status back', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const probe = diagnostics(async (url, init) => {
      calls.push({ url, init })
      return new Response('', { status: 302, headers: { location: 'https://elsewhere.test/' } })
    })
    expect(await probe.httpStatus('https://auth.example.com/v1/status', 1_000)).toBe(302)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://auth.example.com/v1/status')
    expect(calls[0]?.init.redirect).toBe('manual')
    expect(calls[0]?.init.method).toBe('GET')
    expect(new Headers(calls[0]?.init.headers).has('authorization')).toBe(false)
  })

  test('database: any other failure is thrown, for the caller to log', async () => {
    const broken = createDiagnostics({
      db: {
        execute: async () => {
          throw Object.assign(new Error('boom'), { cause: { code: '08006' } })
        },
      } as unknown as TestDatabase['db'],
      mailer: { verify: async () => {} },
      redis: null,
    })
    await expect(broken.database()).rejects.toThrow('boom')
  })

  test('httpStatus: uses the platform’s fetch when none is given', async () => {
    const original = globalThis.fetch
    const seen: string[] = []
    globalThis.fetch = (async (url: string) => {
      seen.push(String(url))
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    try {
      expect(await diagnostics().httpStatus('https://auth.example.com/v1/status', 1_000)).toBe(204)
    } finally {
      globalThis.fetch = original
    }
    expect(seen).toEqual(['https://auth.example.com/v1/status'])
  })

  test('httpStatus: no answer in time rejects', async () => {
    const probe = diagnostics(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    await expect(probe.httpStatus('https://auth.example.com/v1/status', 10)).rejects.toThrow()
  })

  test('smtp and redis are the deployment’s own probes', async () => {
    let pinged = 0
    const probe = createDiagnostics({
      db: testDb.db,
      mailer: {
        verify: async () => {
          throw new Error('refused')
        },
      },
      redis: {
        name: 'redis',
        check: async () => {
          pinged += 1
        },
      },
    })
    await expect(probe.smtp()).rejects.toThrow('refused')
    await probe.redis?.()
    expect(pinged).toBe(1)
  })
})
