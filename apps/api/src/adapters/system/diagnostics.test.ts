import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SHIPPED_MIGRATIONS } from '@tula/db'
import { createTestDatabase, type TestDatabase } from '@tula/db/testing'
import { sql } from 'drizzle-orm'
import { createDiagnostics, MAX_DOCUMENT_BYTES } from '~/adapters/system/diagnostics'

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

  test('httpDocument: one GET, no redirect followed, no credentials; a 200’s body and type back', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const probe = diagnostics(async (url, init) => {
      calls.push({ url, init })
      return new Response('{"webcredentials":{"apps":["A1B2C3D4E5.com.example.app"]}}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const url = 'https://auth.example.com/v1/environments/e/.well-known/apple-app-site-association'
    expect(await probe.httpDocument(url, 1_000)).toEqual({
      status: 200,
      contentType: 'application/json',
      body: '{"webcredentials":{"apps":["A1B2C3D4E5.com.example.app"]}}',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(url)
    expect(calls[0]?.init.redirect).toBe('manual')
    expect(calls[0]?.init.method).toBe('GET')
    expect(new Headers(calls[0]?.init.headers).has('authorization')).toBe(false)
    expect(new Headers(calls[0]?.init.headers).has('cookie')).toBe(false)
  })

  test('httpDocument: anything but a 200 is its status, and its body is not read', async () => {
    let cancelled = false
    const probe = diagnostics(async () => {
      const body = new ReadableStream({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode('CANARY-page'))
        },
        cancel() {
          cancelled = true
        },
      })
      return new Response(body, { status: 302, headers: { location: 'https://elsewhere.test/' } })
    })
    expect(await probe.httpDocument('https://auth.example.com/x', 1_000)).toEqual({
      status: 302,
      contentType: null,
      body: null,
    })
    expect(cancelled).toBe(true)
  })

  test('httpDocument: a body at the cap is read, one byte more is not and the stream is let go', async () => {
    let cancelled = false
    const answer = (bytes: number) => async () => {
      let sent = 0
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const size = Math.min(64 * 1024, bytes - sent)
          if (size === 0) {
            controller.close()
            return
          }
          sent += size
          controller.enqueue(new Uint8Array(size).fill(0x20))
        },
        cancel() {
          cancelled = true
        },
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const atCap = await diagnostics(answer(MAX_DOCUMENT_BYTES)).httpDocument(
      'https://a.test/',
      1_000
    )
    expect(atCap.body).toHaveLength(MAX_DOCUMENT_BYTES)
    expect(cancelled).toBe(false)
    const over = await diagnostics(answer(MAX_DOCUMENT_BYTES + 1)).httpDocument(
      'https://a.test/',
      1_000
    )
    expect(over).toEqual({ status: 200, contentType: 'application/json', body: null })
    // A body with no end: the read stops at the cap and the stream is told so.
    const endless = await diagnostics(answer(Number.POSITIVE_INFINITY)).httpDocument(
      'https://a.test/',
      1_000
    )
    expect(endless.body).toBeNull()
    expect(cancelled).toBe(true)
  })

  test('httpDocument: a 200 with no body is an empty document', async () => {
    const probe = diagnostics(async () => new Response(null, { status: 200 }))
    expect(await probe.httpDocument('https://a.test/', 1_000)).toEqual({
      status: 200,
      contentType: null,
      body: '',
    })
  })

  test('httpDocument: no answer in time rejects', async () => {
    const probe = diagnostics(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    await expect(probe.httpDocument('https://a.test/', 10)).rejects.toThrow()
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
