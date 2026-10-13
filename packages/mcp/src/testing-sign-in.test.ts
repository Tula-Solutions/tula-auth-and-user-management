import { describe, expect, test } from 'bun:test'
import { type AdminClient, OPERATIONS } from '@tula-tech/admin'
import { PROPOSE_OPERATIONS, proposingAdmin } from './proposing'
import { READ_OPERATIONS, readOnlyAdmin } from './read-only'
import { fakeClients, TEST_AGENT_KEY, TEST_SECRET_KEY } from './testing/fake-api'
import {
  SIGN_IN_TEST_TIMEOUT_MS,
  type SignInTesterKind,
  signInTester,
  TEST_OPERATIONS,
  testingWithSignal,
} from './testing-sign-in'

/** A client that only records what `call` was given. */
function recording() {
  const seen: { id: string; input: Record<string, unknown> }[] = []
  const client = {
    call: async (id: string, input: Record<string, unknown>) => {
      seen.push({ id, input })
      return { data: {}, status: 200, etag: null, date: null }
    },
  } as unknown as AdminClient
  return { client, seen }
}

describe('the sign-in test facade', () => {
  test('the allow-list is one operation a kind of client, and they are the two doors of one run', () => {
    expect(TEST_OPERATIONS).toEqual({ agent: 'runSignInTest', admin: 'runSignInTestAsAdmin' })
    expect(OPERATIONS.runSignInTest).toEqual({ method: 'POST', path: '/v1/agent/sign-in-tests' })
    expect(OPERATIONS.runSignInTestAsAdmin).toEqual({
      method: 'POST',
      path: '/v1/admin/sign-in-tests',
    })
  })

  test('the three allow-lists share nothing', () => {
    const others: readonly string[] = [...READ_OPERATIONS, ...PROPOSE_OPERATIONS]
    for (const id of Object.values(TEST_OPERATIONS)) {
      expect(others).not.toContain(id)
    }
  })

  test('an agent’s run is one POST to the agent route, with the agent key and no body', async () => {
    const { agent, requests, bodies } = fakeClients()
    const report = await signInTester(agent, 'agent').run()
    expect(report.outcome).toBe('passed')
    expect(requests.map((request) => `${request.method} ${request.path}${request.search}`)).toEqual(
      ['POST /v1/agent/sign-in-tests']
    )
    expect(requests[0]?.headers.authorization).toBe(`Bearer ${TEST_AGENT_KEY}`)
    expect(bodies).toEqual([])
  })

  test('an administrator’s run is one POST to the admin route, with the secret key and no body', async () => {
    const { admin, requests, bodies } = fakeClients()
    await signInTester(admin, 'admin').run()
    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'POST /v1/admin/sign-in-tests',
    ])
    expect(requests[0]?.headers.authorization).toBe(`Bearer ${TEST_SECRET_KEY}`)
    expect(bodies).toEqual([])
  })

  test('the facade exposes nothing but `run`: the client and its `call` are not reachable', () => {
    const { agent } = fakeClients()
    const facade = signInTester(agent, 'agent')
    expect(Object.keys(facade)).toEqual(['run'])
    expect((facade as unknown as { call?: unknown }).call).toBeUndefined()
    expect((facade as unknown as { read?: unknown }).read).toBeUndefined()
    expect((facade as unknown as { propose?: unknown }).propose).toBeUndefined()
    expect(Object.isFrozen(facade)).toBe(true)
  })

  test('the other facades gained nothing: neither can run a test, and nothing is sent', async () => {
    const { admin, agent, requests } = fakeClients()
    const reads = readOnlyAdmin(admin)
    expect(Object.keys(reads)).toEqual(['read'])
    expect(Object.keys(proposingAdmin(agent))).toEqual(['propose'])
    const read = reads.read as unknown as (id: string, input?: unknown) => Promise<unknown>
    for (const id of Object.values(TEST_OPERATIONS)) {
      await expect(read(id)).rejects.toThrow('not a read operation')
    }
    expect(requests).toEqual([])
  })

  test('a run passes on a signal and its own timeout, and nothing else it is handed', async () => {
    const { client, seen } = recording()
    const { signal } = new AbortController()
    const run = signInTester(client, 'agent', OPERATIONS, 1234).run as unknown as (
      options: unknown,
      more?: unknown
    ) => Promise<unknown>
    await run(
      {
        signal,
        body: { email: 'maya@example.com', keepUser: true },
        headers: { authorization: 'Bearer other', 'x-tula-environment': 'x' },
        method: 'DELETE',
        params: { userId: 'someone' },
        query: { environment: 'production' },
        path: '/v1/admin/users',
        timeoutMs: 999_999,
        operation: 'deleteUser',
      },
      'deleteUser'
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]?.id).toBe('runSignInTest')
    expect(Object.keys(seen[0]?.input ?? {}).sort()).toEqual(['signal', 'timeoutMs'])
    expect(seen[0]?.input.signal).toBe(signal)
    expect(seen[0]?.input.timeoutMs).toBe(1234)
  })

  test('a signal that is not one is not passed on, and no options is fine', async () => {
    const { client, seen } = recording()
    const run = signInTester(client, 'admin', OPERATIONS, 1234).run as unknown as (
      options?: unknown
    ) => Promise<unknown>
    await run({ signal: { aborted: false } })
    await run()
    expect(seen.map((call) => call.id)).toEqual(['runSignInTestAsAdmin', 'runSignInTestAsAdmin'])
    expect(seen.map((call) => call.input)).toEqual([{ timeoutMs: 1234 }, { timeoutMs: 1234 }])
  })

  test('a run is waited for longer than the server lets one last', () => {
    // The API's deadline (40 s) and its bounded clean-up, twice (8 s each): the constants of
    // `modules/sign-in-test/service.ts`, which this package cannot import.
    expect(SIGN_IN_TEST_TIMEOUT_MS).toBeGreaterThan(40_000 + 2 * 8_000)
  })

  test.each([
    ['a kind there is not', 'instance'],
    ['an inherited name', 'constructor'],
    ['`__proto__`', '__proto__'],
    ['an operation id', 'runSignInTest'],
    ['nothing', undefined],
  ])('%s is no kind of client, and no facade is made', (_name, kind) => {
    const { agent } = fakeClients()
    expect(() => signInTester(agent, kind as SignInTesterKind)).toThrow('not a kind of client')
  })

  test.each([
    ['is a GET', 'agent', { method: 'GET', path: '/v1/agent/sign-in-tests' }],
    ['is a DELETE', 'agent', { method: 'DELETE', path: '/v1/agent/sign-in-tests' }],
    ['became the proposal', 'agent', { method: 'POST', path: '/v1/agent/proposals' }],
    ['moved to the users', 'agent', { method: 'POST', path: '/v1/admin/users' }],
    ['took a path parameter', 'agent', { method: 'POST', path: '/v1/agent/sign-in-tests/{id}' }],
    ['is the agent’s route', 'admin', { method: 'POST', path: '/v1/agent/sign-in-tests' }],
    ['became the approval', 'admin', { method: 'POST', path: '/v1/admin/proposals/{id}/approve' }],
    ['is an instance route', 'admin', { method: 'POST', path: '/v1/instance/sign-in-tests' }],
  ] as const)(
    'an operation table in which the allow-listed id %s is refused when the facade is made',
    (_name, kind, route) => {
      const { agent } = fakeClients()
      const id = TEST_OPERATIONS[kind]
      expect(() => signInTester(agent, kind, { ...OPERATIONS, [id]: route as never })).toThrow(id)
    }
  )

  test('an operation table without the id is refused when the facade is made', () => {
    const { agent } = fakeClients()
    const { runSignInTest: _gone, ...rest } = OPERATIONS
    expect(() => signInTester(agent, 'agent', rest)).toThrow('runSignInTest')
  })

  test('with a signal: the request ends when the signal aborts, and the facade is as closed', async () => {
    const { client, seen } = recording()
    const controller = new AbortController()
    const facade = testingWithSignal(
      signInTester(client, 'agent', OPERATIONS, 1234),
      controller.signal
    )
    expect(Object.keys(facade)).toEqual(['run'])
    expect(Object.isFrozen(facade)).toBe(true)
    const other = new AbortController()
    await (facade.run as unknown as (options: unknown) => Promise<unknown>)({
      signal: other.signal,
    })
    expect(seen[0]?.input).toEqual({ signal: controller.signal, timeoutMs: 1234 })
  })
})
