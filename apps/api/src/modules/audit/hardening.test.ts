import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { ServiceUnavailableError } from '~/exceptions'
import { createApp } from '~/index'
import * as logger from '~/lib/logger'
import * as Audit from '~/modules/audit/service'
import { createInstanceTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'

const SK = 'tula_sk_dev_hardeningtests000000000000000000000'
const ACTOR = {
  type: 'admin',
  id: '00000000-0000-7000-8000-00000000b001',
  ipAddress: null,
  userAgent: null,
} as const

let deps: TestDeps
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  deps = createInstanceTestDeps()
  await seedApiKey(deps, SK)
  app = createApp(deps)
})

describe('csvCell (H-173)', () => {
  test.each([' =1+1', ' =1+1', '​@SUM(A1)', '  -2+3', '﻿+1', '＝1+1', '＠SUM(A1)'])(
    'neutralizes %j',
    (cell) => {
      expect(Audit.csvCell(cell).replace(/^"/, '').startsWith("'")).toBe(true)
    }
  )

  test('leaves ordinary text with inner formula characters alone', () => {
    expect(Audit.csvCell('a=b')).toBe('a=b')
    expect(Audit.csvCell(' plain')).toBe(' plain')
  })
})

describe('the metadata cell (H-176)', () => {
  test('is written through csvCell: quoted, with its quotes doubled', async () => {
    const activity = Audit.entry(deps, TEST_TENANT, {
      type: 'user.imported',
      actor: ACTOR,
      target: { type: 'user', id: ACTOR.id },
      data: { emailVerified: true },
    })
    await deps.activityLog.append(activity)
    const res = await app.request('/v1/admin/audit-logs/export', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SK}` },
      body: JSON.stringify({ format: 'csv', action: 'user.imported' }),
    })
    const row = (await res.text()).split('\r\n')[1] ?? ''
    expect(row).toContain('"{""emailVerified"":true}"')
  })
})

describe('audit metadata allow-list (H-172)', () => {
  test('a key the contract does not name never reaches the list or an export', async () => {
    const activity = Audit.entry(deps, TEST_TENANT, {
      type: 'user.imported',
      actor: ACTOR,
      target: { type: 'user', id: ACTOR.id },
      data: { emailVerified: true, leaked: 'secret-value' } as never,
    })
    await deps.activityLog.append(activity)
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${SK}` }
    const list = await app.request('/v1/admin/audit-logs?action=user.imported', { headers })
    const listed = await list.text()
    expect(listed).toContain('emailVerified')
    expect(listed).not.toContain('secret-value')
    const res = await app.request('/v1/admin/audit-logs/export', {
      method: 'POST',
      headers,
      body: JSON.stringify({ format: 'ndjson', action: 'user.imported' }),
    })
    expect(await res.text()).not.toContain('secret-value')
  })
})

describe('concurrent exports (H-168)', () => {
  test('a third export waits while two are open, and a finished one frees its slot', async () => {
    // An empty log ends at the first pull, which a stream makes on creation: seed entries so
    // the exports stay open until they are read.
    for (let i = 0; i < 3; i++) {
      await deps.activityLog.append(
        Audit.entry(deps, TEST_TENANT, {
          type: 'user.deleted',
          actor: ACTOR,
          target: { type: 'user', id: ACTOR.id },
        })
      )
    }
    const start = () =>
      app.request('/v1/admin/audit-logs/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${SK}` },
        body: JSON.stringify({ format: 'ndjson' }),
      })
    const open = [await start(), await start()]
    expect(open.map((r) => r.status)).toEqual([200, 200])
    const refused = await start()
    expect(refused.status).toBe(429)
    await open[0]?.text()
    const again = await start()
    expect(again.status).toBe(200)
    await again.body?.cancel()
    await open[1]?.body?.cancel()
  })

  const start = () =>
    app.request('/v1/admin/audit-logs/export', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SK}` },
      body: JSON.stringify({ format: 'ndjson' }),
    })
  const seed = async () => {
    await deps.activityLog.append(
      Audit.entry(deps, TEST_TENANT, {
        type: 'user.deleted',
        actor: ACTOR,
        target: { type: 'user', id: ACTOR.id },
      })
    )
  }

  test('slots another instance holds count: the shared lease store decides', async () => {
    const env = TEST_TENANT.environmentId
    await deps.exportLeases.acquire(env, 2, 60_000)
    await deps.exportLeases.acquire(env, 2, 60_000)
    expect((await start()).status).toBe(429)
  })

  test('a client that disconnects frees its slot', async () => {
    await seed()
    const open = [await start(), await start()]
    await open[0]?.body?.cancel()
    const again = await start()
    expect(again.status).toBe(200)
    await again.body?.cancel()
    await open[1]?.body?.cancel()
  })

  test('a stream that fails frees its slot', async () => {
    await seed()
    const release = spyOn(deps.exportLeases, 'release')
    spyOn(deps.activityLog, 'listAuditAfter' as never).mockImplementation((() => {
      throw new Error('db down')
    }) as never)
    const res = await start()
    await res.text().catch(() => null)
    expect(release).toHaveBeenCalledTimes(1)
  })

  test('a lease store that cannot answer refuses the export with 503', async () => {
    spyOn(deps.exportLeases, 'acquire').mockRejectedValue(new ServiceUnavailableError())
    const res = await start()
    expect(res.status).toBe(503)
  })

  test('a long export renews its lease while it streams', async () => {
    await seed()
    const renew = spyOn(deps.exportLeases, 'renew')
    const res = await start()
    deps.clock.advance(11 * 60_000)
    await res.text()
    expect(renew).toHaveBeenCalled()
  })

  test('a renewal the store refuses is logged with ids only', async () => {
    await seed()
    spyOn(deps.exportLeases, 'renew').mockResolvedValue(false)
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      const res = await start()
      deps.clock.advance(11 * 60_000)
      await res.text()
      expect(warn).toHaveBeenCalledWith('audit export lease lost', {
        environmentId: TEST_TENANT.environmentId,
      })
    } finally {
      warn.mockRestore()
    }
  })
})
