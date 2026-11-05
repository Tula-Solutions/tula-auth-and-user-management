import { beforeEach, describe, expect, test } from 'bun:test'
import { createApp } from '~/index'
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
