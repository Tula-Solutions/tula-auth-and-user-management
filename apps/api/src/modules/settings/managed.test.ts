import { beforeEach, describe, expect, test } from 'bun:test'
import { CONFIG_HASH_HEADER, CONFIG_MANAGED_BY_HEADER } from '@tula/contract'
import { createApp } from '~/index'
import { createTestDeps, seedApiKey, type TestDeps } from '~/testing'

// The "managed by a config file" marker on an environment's settings (ADR 0030): who set it,
// what keeps it, what clears it, and how a change made around the config file shows.

const SK = 'tula_sk_dev_managed0000000000000000000000000000'
const ADMIN = '/v1/admin/settings'
const HASH = `sha256:${'1f'.repeat(32)}`
const OTHER_HASH = `sha256:${'2e'.repeat(32)}`

let deps: TestDeps
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  deps = createTestDeps()
  await seedApiKey(deps, SK)
  app = createApp(deps)
})

interface ManagedBy {
  tool: string
  configHash: string
  at: string
  revision: number
  drifted: boolean
}

interface State {
  revision: number
  settings: { app: { name: string } }
  managedBy: ManagedBy | null
}

async function read(): Promise<State> {
  const res = await app.request(ADMIN, { headers: { authorization: `Bearer ${SK}` } })
  return (await res.json()) as State
}

function put(body: unknown, revision: number, headers: Record<string, string> = {}) {
  return app.request(ADMIN, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${SK}`,
      'if-match': `"${revision}"`,
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

const managed = (configHash = HASH, tool = 'tula-apply') => ({
  [CONFIG_MANAGED_BY_HEADER]: tool,
  [CONFIG_HASH_HEADER]: configHash,
})

async function audited(): Promise<Record<string, unknown>[]> {
  const res = await app.request('/v1/admin/audit-logs?action=environment.settings_updated', {
    headers: { authorization: `Bearer ${SK}` },
  })
  const body = (await res.json()) as { data: { metadata: Record<string, unknown> }[] }
  return body.data.map((entry) => entry.metadata)
}

describe('settings managed by a config file', () => {
  test('settings nobody manages say so', async () => {
    expect((await read()).managedBy).toBeNull()
    const res = await put({ app: { name: 'By hand' } }, 0)
    expect(((await res.json()) as State).managedBy).toBeNull()
  })

  test('a replace that names its tool and config hash is recorded as the manager', async () => {
    const res = await put({ app: { name: 'Northline' } }, 0, managed())
    expect(res.status).toBe(200)
    const state = (await res.json()) as State
    expect(state.revision).toBe(1)
    expect(state.managedBy).toEqual({
      tool: 'tula-apply',
      configHash: HASH,
      at: deps.clock.now().toISOString(),
      revision: 1,
      drifted: false,
    })
    expect((await read()).managedBy).toEqual(state.managedBy)
    const [entry] = await audited()
    expect(entry).toMatchObject({ revision: 1, changed: ['app.name'], managedBy: 'tula-apply' })
    expect(JSON.stringify(entry)).not.toContain('Northline')
  })

  test('recording the manager of an unchanged document is a write of its own', async () => {
    await put({ app: { name: 'Northline' } }, 0)
    const res = await put({ app: { name: 'Northline' } }, 1, managed())
    const state = (await res.json()) as State
    expect(state.revision).toBe(2)
    expect(state.managedBy).toMatchObject({ configHash: HASH, revision: 2, drifted: false })
    expect((await audited()).at(0)).toMatchObject({
      revision: 2,
      changed: [],
      managedBy: 'tula-apply',
    })
  })

  test('the same document from the same config changes nothing', async () => {
    await put({ app: { name: 'Northline' } }, 0, managed())
    const res = await put({ app: { name: 'Northline' } }, 1, managed())
    expect(res.status).toBe(200)
    expect(((await res.json()) as State).revision).toBe(1)
    expect(await audited()).toHaveLength(1)
  })

  test('a new version of the config is recorded even when the document is the same', async () => {
    await put({ app: { name: 'Northline' } }, 0, managed())
    const res = await put({ app: { name: 'Northline' } }, 1, managed(OTHER_HASH))
    const state = (await res.json()) as State
    expect(state.revision).toBe(2)
    expect(state.managedBy).toMatchObject({ configHash: OTHER_HASH, revision: 2 })
  })

  test('a change made without the marker keeps the manager and shows as drift', async () => {
    await put({ app: { name: 'Northline' } }, 0, managed())
    const res = await put({ app: { name: 'Changed in the dashboard' } }, 1)
    const state = (await res.json()) as State
    expect(state.revision).toBe(2)
    expect(state.managedBy).toMatchObject({
      tool: 'tula-apply',
      configHash: HASH,
      revision: 1,
      drifted: true,
    })
    expect((await audited()).at(0)).toMatchObject({ changed: ['app.name'], outsideConfig: true })
  })

  test('applying the config again ends the drift', async () => {
    await put({ app: { name: 'Northline' } }, 0, managed())
    await put({ app: { name: 'Changed in the dashboard' } }, 1)
    const res = await put({ app: { name: 'Northline' } }, 2, managed())
    expect(((await res.json()) as State).managedBy).toMatchObject({ revision: 3, drifted: false })
  })

  test('re-applying after a drift back to the same document still records the apply', async () => {
    await put({ app: { name: 'Northline' } }, 0, managed())
    await put({ app: { name: 'Other' } }, 1)
    await put({ app: { name: 'Northline' } }, 2)
    const res = await put({ app: { name: 'Northline' } }, 3, managed())
    expect(((await res.json()) as State).managedBy).toMatchObject({ revision: 4, drifted: false })
  })

  test('`none` hands the settings back: the marker is removed and the removal recorded', async () => {
    await put({ app: { name: 'Northline' } }, 0, managed())
    const res = await put({ app: { name: 'Northline' } }, 1, { [CONFIG_MANAGED_BY_HEADER]: 'none' })
    const state = (await res.json()) as State
    expect(state.revision).toBe(2)
    expect(state.managedBy).toBeNull()
    expect((await audited()).at(0)).toMatchObject({ changed: [], managedBy: null })
    // Nothing left to remove: the same request again changes nothing.
    const again = await put({ app: { name: 'Northline' } }, 2, {
      [CONFIG_MANAGED_BY_HEADER]: 'none',
    })
    expect(((await again.json()) as State).revision).toBe(2)
  })

  test.each([
    ['a tool without a hash', { [CONFIG_MANAGED_BY_HEADER]: 'tula-apply' }, CONFIG_HASH_HEADER],
    ['a hash without a tool', { [CONFIG_HASH_HEADER]: HASH }, CONFIG_MANAGED_BY_HEADER],
    ['a hash that is not a SHA-256', managed('sha256:abc'), CONFIG_HASH_HEADER],
    [
      'a hash with `none`',
      { [CONFIG_MANAGED_BY_HEADER]: 'none', [CONFIG_HASH_HEADER]: HASH },
      CONFIG_HASH_HEADER,
    ],
    ['a tool name with markup', managed(HASH, '<script>'), CONFIG_MANAGED_BY_HEADER],
    ['a tool name that is too long', managed(HASH, 'a'.repeat(33)), CONFIG_MANAGED_BY_HEADER],
  ])('%s is refused and nothing changes', async (_name, headers, field) => {
    const res = await put({ app: { name: 'Northline' } }, 0, headers as Record<string, string>)
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code: string; errors: { field: string }[] }
    expect(body.code).toBe('validation.failed')
    expect(body.errors.map((error) => error.field)).toEqual([field])
    expect((await read()).revision).toBe(0)
  })

  test('a stale revision is refused before the marker is touched', async () => {
    await put({ app: { name: 'Northline' } }, 0, managed())
    const res = await put({ app: { name: 'Northline' } }, 0, managed(OTHER_HASH))
    expect(res.status).toBe(412)
    expect((await read()).managedBy).toMatchObject({ configHash: HASH, revision: 1 })
  })
})
