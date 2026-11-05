import { beforeEach, describe, expect, test } from 'bun:test'
import type { AdminFetch } from '@tula-tech/admin'
import { auditExportCursor } from '@tula-tech/contract'
import { createApp } from '../../../apps/api/src/index'
import * as Audit from '../../../apps/api/src/modules/audit/service'
import {
  createTestDeps,
  seedApiKey,
  TEST_TENANT,
  type TestDeps,
} from '../../../apps/api/src/testing'
import { cursorOf } from './commands/audit'
import { COMMANDS, runCli } from './index'

// `tula audit export` against the real API in process (TULA-137).

const SECRET_KEY = 'tula_sk_dev_audittest0000000000000000000000000'
const AGENT_KEY = 'tula_ak_dev_audittest0000000000000000000000000'
const ACTOR = {
  type: 'admin',
  id: '00000000-0000-7000-8000-00000000a001',
  ipAddress: null,
  userAgent: null,
} as const

let deps: TestDeps
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  deps = createTestDeps()
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  await seedApiKey(deps, SECRET_KEY)
  await seedApiKey(deps, AGENT_KEY)
  app = createApp(deps)
})

async function seed(count: number) {
  for (let i = 0; i < count; i += 1) {
    deps.clock.advance('1s')
    await deps.activityLog.append(
      Audit.entry(deps, TEST_TENANT, {
        type: 'user.deleted',
        actor: ACTOR,
        target: { type: 'user', id: '00000000-0000-7000-8000-00000000a002' },
      })
    )
  }
}

async function tula(args: string[], key = SECRET_KEY, stub?: AdminFetch) {
  let stdout = ''
  let stderr = ''
  const fetch: AdminFetch = stub ?? (async (url, init) => app.request(url, init))
  const code = await runCli(
    args,
    {
      stdout: { write: (text) => (stdout += text) },
      stderr: { write: (text) => (stderr += text) },
      env: { TULA_API_URL: 'http://localhost:3003', TULA_SECRET_KEY: key },
      cwd: '/nowhere',
      isTTY: false,
      stdinIsTTY: false,
      fetch,
      now: () => deps.clock.now(),
    },
    COMMANDS
  )
  expect(stdout + stderr).not.toContain(key)
  return { code, stdout, stderr }
}

const ids = (stdout: string) =>
  stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { id: string }).id)

describe('tula audit export', () => {
  test('writes NDJSON to stdout and counts the entries on stderr', async () => {
    await seed(5)
    const run = await tula(['audit', 'export', '--action', 'user.deleted'])
    expect(run.code).toBe(0)
    expect(ids(run.stdout)).toHaveLength(5)
    expect(run.stderr).toContain('5 entries exported')
  })

  test('keeps every NDJSON record when a field holds one quote', async () => {
    const row = (n: number, userAgent: string) =>
      JSON.stringify({
        id: `0198f4a0-0000-7000-8000-00000000000${n}`,
        occurredAt: `2026-01-02T03:04:0${n}.000Z`,
        userAgent,
      })
    const body = `${[row(1, 'a'), row(2, 'Agent "x'), row(3, 'b')].join('\n')}\n`
    const run = await tula(
      ['audit', 'export'],
      SECRET_KEY,
      async () => new Response(body, { headers: { 'content-type': 'application/x-ndjson' } })
    )
    expect(run.stdout).toBe(body)
    expect(run.stderr).toContain('3 entries exported')
    expect(cursorOf(row(3, 'b'), 'ndjson')).toBe(
      auditExportCursor({
        id: '0198f4a0-0000-7000-8000-000000000003',
        occurredAt: '2026-01-02T03:04:03.000Z',
      })
    )
  })

  test('keeps a CSV row whose quoted cell holds a newline', async () => {
    const row = (n: number, userAgent: string) =>
      `0198f4a0-0000-7000-8000-00000000000${n},2026-01-02T03:04:0${n}.000Z,${userAgent}`
    const body = `id,occurredAt,userAgent\n${[row(1, 'a'), row(2, '"line1\nline2"'), row(3, 'b')].join('\n')}\n`
    const run = await tula(
      ['audit', 'export', '--format', 'csv'],
      SECRET_KEY,
      async () => new Response(body, { headers: { 'content-type': 'text/csv' } })
    )
    expect(run.stdout).toBe(body)
    expect(run.stderr).toContain('3 entries exported')
    expect(cursorOf(row(3, 'b'), 'csv')).toBe(
      auditExportCursor({
        id: '0198f4a0-0000-7000-8000-000000000003',
        occurredAt: '2026-01-02T03:04:03.000Z',
      })
    )
  })

  test('csv has a header row and one row per entry', async () => {
    await seed(3)
    const run = await tula(['audit', 'export', '--format', 'csv', '--action', 'user.deleted'])
    expect(run.code).toBe(0)
    const lines = run.stdout.split('\n').filter(Boolean)
    expect(lines[0]).toBe(Audit.EXPORT_CSV_COLUMNS.join(','))
    expect(lines).toHaveLength(4)
    expect(run.stderr).toContain('3 entries exported')
  })

  test('--from and --to bound the entries', async () => {
    await seed(6)
    const all = await tula(['audit', 'export', '--action', 'user.deleted'])
    const rows = all.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { occurredAt: string })
    const from = rows[2]?.occurredAt as string
    const to = rows[5]?.occurredAt as string
    const run = await tula([
      'audit',
      'export',
      '--action',
      'user.deleted',
      '--from',
      from,
      '--to',
      to,
    ])
    expect(ids(run.stdout)).toEqual(ids(all.stdout).slice(2, 5))
  })

  test('--resume with the last cursor continues with no gap and no duplicate', async () => {
    await seed(8)
    const whole = ids((await tula(['audit', 'export', '--action', 'user.deleted'])).stdout)
    const first = (await tula(['audit', 'export', '--action', 'user.deleted'])).stdout
      .split('\n')
      .filter(Boolean)
      .slice(0, 3)
    const last = JSON.parse(first.at(-1) as string) as { id: string; occurredAt: string }
    const rest = await tula([
      'audit',
      'export',
      '--action',
      'user.deleted',
      '--resume',
      `${last.occurredAt}~${last.id}`,
    ])
    expect([...ids(`${first.join('\n')}\n`), ...ids(rest.stdout)]).toEqual(whole)
  })

  test('refuses an agent key with a usage error and exports nothing', async () => {
    await seed(1)
    const run = await tula(['audit', 'export'], AGENT_KEY)
    expect(run.code).not.toBe(0)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain('agent key')
  })

  test('refuses a format it does not know and a missing subcommand', async () => {
    expect((await tula(['audit', 'export', '--format', 'xml'])).code).not.toBe(0)
    expect((await tula(['audit'])).code).not.toBe(0)
  })

  test('the resume cursor of a CSV row reads the columns the server writes, by position', () => {
    // cursorOf reads the first two cells; the server's column order is what it relies on.
    expect(Audit.EXPORT_CSV_COLUMNS.slice(0, 2)).toEqual(['id', 'occurredAt'])
    const cells = Audit.EXPORT_CSV_COLUMNS.map((column) =>
      column === 'id'
        ? '0198f4a0-0000-7000-8000-000000000001'
        : column === 'occurredAt'
          ? '2026-01-02T03:04:05.000Z'
          : ''
    )
    expect(cursorOf(cells.join(','), 'csv')).toBe(
      auditExportCursor({ id: cells[0] as string, occurredAt: cells[1] as string })
    )
    expect(cursorOf(Audit.EXPORT_CSV_COLUMNS.join(','), 'csv')).toBeNull()
  })
})
