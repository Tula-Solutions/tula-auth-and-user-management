import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { type AuditLog, auditExportCursor } from '@tula-tech/contract'
import { createApp } from '~/index'
import * as Audit from '~/modules/audit/service'
import {
  createInstanceTestDeps,
  dashboardHeaders,
  dashboardSignIn,
  seedApiKey,
  TEST_TENANT,
  type TestDeps,
} from '~/testing'

const SK = 'tula_sk_dev_exporttests00000000000000000000000'
const AK = 'tula_ak_dev_exporttests00000000000000000000000'
const ACTOR = {
  type: 'admin',
  id: '00000000-0000-7000-8000-00000000a001',
  ipAddress: null,
  userAgent: null,
} as const
const OTHER_USER = '00000000-0000-7000-8000-00000000a002'
const ORG = '00000000-0000-7000-8000-00000000a0b1'

let deps: TestDeps
let app: ReturnType<typeof createApp>

async function seedEntries(count: number, overrides: { userAgent?: string } = {}) {
  for (let i = 0; i < count; i += 1) {
    // Many entries share an instant on purpose: the order must break the tie by id.
    if (i % 3 === 0) {
      deps.clock.advance('1s')
    }
    const activity = Audit.entry(deps, TEST_TENANT, {
      type: 'user.deleted',
      actor: { ...ACTOR, userAgent: overrides.userAgent ?? null },
      target: { type: 'user', id: OTHER_USER },
    })
    await deps.activityLog.append(activity)
  }
}

function post(body: unknown, key: string | null = SK) {
  return app.request('/v1/admin/audit-logs/export', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key && { authorization: `Bearer ${key}` }),
    },
    body: JSON.stringify(body),
  })
}

function lines(text: string): AuditLog[] {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AuditLog)
}

async function exportedEntries(): Promise<AuditLog[]> {
  const { entries } = await deps.activityLog.listAudit(TEST_TENANT.environmentId, {
    action: 'audit.exported',
    page: 1,
    size: 100,
  })
  return entries.map((entry) => ({
    id: entry.id,
    action: entry.type,
    actor: entry.actor,
    target: entry.target,
    ipAddress: entry.ipAddress,
    userAgent: entry.userAgent,
    metadata: entry.data,
    occurredAt: entry.occurredAt.toISOString(),
  }))
}

beforeEach(async () => {
  deps = createInstanceTestDeps()
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  await seedApiKey(deps, SK)
  await seedApiKey(deps, AK)
  app = createApp(deps)
})

describe('POST /v1/admin/audit-logs/export', () => {
  test('streams more rows than one page, oldest first, with no repeat', async () => {
    await seedEntries(2500)
    const res = await post({ format: 'ndjson', action: 'user.deleted' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/x-ndjson')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const rows = lines(await res.text())
    expect(rows).toHaveLength(2500)
    expect(new Set(rows.map((row) => row.id)).size).toBe(2500)
    const keys = rows.map((row) => `${row.occurredAt}~${row.id}`)
    expect(keys).toEqual([...keys].sort())
  })

  test('a resume from the last row continues with no gap and no duplicate', async () => {
    await seedEntries(30)
    const whole = lines(await (await post({ action: 'user.deleted' })).text())
    const first = whole.slice(0, 12)
    const last = first.at(-1) as AuditLog
    const rest = lines(
      await (await post({ action: 'user.deleted', after: auditExportCursor(last) })).text()
    )
    expect([...first, ...rest].map((row) => row.id)).toEqual(whole.map((row) => row.id))
  })

  test('rows hold exactly the fields of the list', async () => {
    await seedEntries(1)
    const listed = (await (
      await app.request('/v1/admin/audit-logs?action=user.deleted', {
        headers: { authorization: `Bearer ${SK}` },
      })
    ).json()) as { data: AuditLog[] }
    const [row] = lines(await (await post({ action: 'user.deleted' })).text())
    expect(row).toEqual(listed.data[0] as AuditLog)
  })

  test('filters by organization: the entries whose target it is, and no others', async () => {
    await seedEntries(2)
    await deps.activityLog.append(
      Audit.entry(deps, TEST_TENANT, {
        type: 'organization.created',
        actor: ACTOR,
        target: { type: 'organization', id: ORG },
      })
    )
    const rows = lines(await (await post({ organizationId: ORG })).text())
    expect(rows.map((row) => row.action)).toEqual(['organization.created'])
  })

  test('csv has a header, one row per entry and escapes what a spreadsheet would run', async () => {
    await seedEntries(2, { userAgent: '=HYPERLINK("http://evil")' })
    const res = await post({ format: 'csv', action: 'user.deleted' })
    expect(res.headers.get('content-type')).toContain('text/csv')
    const rows = (await res.text()).split('\r\n').filter(Boolean)
    expect(rows[0]).toBe(Audit.EXPORT_CSV_COLUMNS.join(','))
    expect(rows).toHaveLength(3)
    expect(rows[1]).toContain(`"'=HYPERLINK(""http://evil"")"`)
  })

  test.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx'])('csvCell prefixes %j', (cell) => {
    expect(Audit.csvCell(cell).replace(/^"/, '').startsWith("'")).toBe(true)
  })

  test('csvCell quotes commas, quotes and line breaks and leaves plain text alone', () => {
    expect(Audit.csvCell('a,b')).toBe('"a,b"')
    expect(Audit.csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(Audit.csvCell('two\nlines')).toBe('"two\nlines"')
    expect(Audit.csvCell('plain')).toBe('plain')
    expect(Audit.csvCell(null)).toBe('')
  })

  test('records a started entry up front and a finished one with the filters and the row count', async () => {
    await seedEntries(5)
    const from = '2000-01-01T00:00:00.000Z'
    const res = await post({ format: 'csv', action: 'user.deleted', from })
    await res.text()
    const recorded = await exportedEntries()
    expect(recorded).toHaveLength(2)
    const byPhase = (phase: string) => recorded.find((r) => r.metadata.phase === phase)
    const filters = { format: 'csv', resumed: false, action: 'user.deleted', from }
    expect(byPhase('started')?.metadata).toEqual({ ...filters, phase: 'started', rowCount: 0 })
    expect(byPhase('finished')?.metadata).toEqual({ ...filters, phase: 'finished', rowCount: 5 })
    expect(recorded[0]?.actor.type).toBe('admin')
  })

  test('a stream that fails mid-way still leaves the started entry with its filters', async () => {
    await seedEntries(3)
    const spy = spyOn(deps.activityLog, 'listAuditAfter').mockRejectedValue(new Error('db down'))
    const res = await post({ action: 'user.deleted' })
    await res.text().catch(() => undefined)
    spy.mockRestore()
    const started = (await exportedEntries()).filter((r) => r.metadata.phase === 'started')
    expect(started).toHaveLength(1)
    expect(started[0]?.metadata.action).toBe('user.deleted')
  })

  test('an export the reader abandons counts the rows it got', async () => {
    await seedEntries(3000)
    const res = await post({ action: 'user.deleted' })
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    await reader.read()
    await reader.cancel()
    const recorded = (await exportedEntries()).find((r) => r.metadata.phase === 'finished')
    expect(recorded?.metadata.resumed).toBe(false)
    expect(Number(recorded?.metadata.rowCount)).toBeLessThan(3000)
  })

  test('refuses an agent key, and records nothing', async () => {
    await seedEntries(1)
    const res = await post({}, AK)
    expect(res.status).toBe(401)
    expect(((await res.json()) as { code: string }).code).toBe('auth.invalid_key')
    expect(await exportedEntries()).toHaveLength(0)
  })

  test('refuses a request with no key and a malformed cursor', async () => {
    expect((await post({}, null)).status).toBe(401)
    expect((await post({ after: 'not-a-cursor' })).status).toBe(422)
  })

  test('takes a dashboard session with an environment, and records it as the dashboard', async () => {
    await seedEntries(2)
    const cookie = await dashboardSignIn(app)
    const res = await app.request('/v1/admin/audit-logs/export', {
      method: 'POST',
      headers: dashboardHeaders(cookie, TEST_TENANT.environmentId),
      body: JSON.stringify({ action: 'user.deleted' }),
    })
    expect(res.status).toBe(200)
    expect(lines(await res.text())).toHaveLength(2)
    const [recorded] = await exportedEntries()
    expect(recorded?.actor.type).toBe('instance_admin')
  })
})
