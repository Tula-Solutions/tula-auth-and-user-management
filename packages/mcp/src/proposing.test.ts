import { describe, expect, test } from 'bun:test'
import { type AdminClient, OPERATIONS } from '@tula-tech/admin'
import {
  PROPOSABLE,
  PROPOSE_OPERATIONS,
  type ProposalRequest,
  proposingAdmin,
  proposingWithSignal,
} from './proposing'
import { READ_OPERATIONS, readOnlyAdmin } from './read-only'
import { fakeClients, TEST_AGENT_KEY, TEST_PROPOSAL_ID, TEST_USER_ID } from './testing/fake-api'

const BAN: ProposalRequest = { operation: 'ban_user', target: { type: 'user', id: TEST_USER_ID } }

/** A client that only records what `call` was given. */
function recording() {
  const seen: { id: string; input: Record<string, unknown> }[] = []
  const agent = {
    call: async (id: string, input: Record<string, unknown>) => {
      seen.push({ id, input })
      return { data: {}, status: 201, etag: null, date: null }
    },
  } as unknown as AdminClient
  return { agent, seen }
}

describe('the proposing facade', () => {
  test('the allow-list is one operation: asking. Approving is not on it', () => {
    expect([...PROPOSE_OPERATIONS]).toEqual(['createProposal'])
    expect(PROPOSE_OPERATIONS as readonly string[]).not.toContain('approveProposal')
  })

  test('every allow-listed operation is a POST under /v1/agent/, and none is an admin route', () => {
    for (const id of PROPOSE_OPERATIONS) {
      expect(OPERATIONS[id].method).toBe('POST')
      expect(OPERATIONS[id].path.startsWith('/v1/agent/')).toBe(true)
      expect(OPERATIONS[id].path).not.toContain('/v1/admin/')
    }
  })

  test('the two allow-lists share nothing', () => {
    const reads: readonly string[] = READ_OPERATIONS
    for (const id of PROPOSE_OPERATIONS) {
      expect(reads).not.toContain(id)
    }
  })

  test('what a tool may propose is exactly what the API takes a proposal for', () => {
    // The keys are held to the API's own enumeration by the type (`satisfies Record<…>` over
    // the generated request body: a missing or an extra operation does not compile). This
    // pins the list, so that a new proposal is added here on purpose.
    expect(PROPOSABLE).toEqual({
      ban_user: 'user',
      unban_user: 'user',
      end_session: 'session',
      disable_oauth_provider: 'oauth_provider',
    })
    const every: Record<ProposalRequest['operation'], true> = {
      ban_user: true,
      unban_user: true,
      end_session: true,
      disable_oauth_provider: true,
    }
    expect(Object.keys(every)).toEqual(Object.keys(PROPOSABLE))
  })

  // The type-level allow-list: each line below is an operation the facade must never
  // carry. If one of them were added to the API's list and to `PROPOSABLE`, its line would
  // compile, the `@ts-expect-error` above it would fail the type check, and this test with
  // it: nothing irreversible, nothing that returns or sets a secret, nothing in bulk.
  test('nothing irreversible, nothing with a secret and nothing in bulk is an operation', async () => {
    const { agent, requests } = fakeClients()
    const facade = proposingAdmin(agent)
    const user = { type: 'user', id: TEST_USER_ID } as const
    const provider = { type: 'oauth_provider', id: 'google' } as const
    const key = { type: 'api_key', id: 'x' } as const
    const many = { type: 'session', id: ['a', 'b'] } as const
    const all = { type: 'all', id: '*' } as const
    const refused = [
      // Irreversible.
      // @ts-expect-error a user is never deleted by a proposal
      () => facade.propose({ operation: 'delete_user', target: user }),
      // @ts-expect-error a provider is never removed by a proposal
      () => facade.propose({ operation: 'delete_oauth_provider', target: provider }),
      // @ts-expect-error a second factor is never reset by a proposal
      () => facade.propose({ operation: 'reset_mfa', target: user }),
      // @ts-expect-error a key is never revoked by a proposal
      () => facade.propose({ operation: 'revoke_api_key', target: key }),
      // Returns or sets a secret.
      // @ts-expect-error a key is never made by a proposal
      () => facade.propose({ operation: 'create_api_key', target: user }),
      // @ts-expect-error a password is never set by a proposal
      () => facade.propose({ operation: 'set_password', target: user }),
      // @ts-expect-error a provider's credentials are never written by a proposal
      () => facade.propose({ operation: 'update_oauth_provider', target: provider }),
      // @ts-expect-error a provider is never switched on by a proposal
      () => facade.propose({ operation: 'enable_oauth_provider', target: provider }),
      // @ts-expect-error a signing secret is never rotated by a proposal
      () => facade.propose({ operation: 'rotate_webhook_secret', target: user }),
      // @ts-expect-error the settings are never replaced by a proposal
      () => facade.propose({ operation: 'update_settings', target: user }),
      // In bulk.
      // @ts-expect-error every session of a user is never ended by one proposal
      () => facade.propose({ operation: 'end_sessions', target: user }),
      // @ts-expect-error a proposal has one target, never a list
      () => facade.propose({ operation: 'ban_user', targets: [user] }),
      // @ts-expect-error a target is one id, never a list of them
      () => facade.propose({ operation: 'end_session', target: many }),
      // @ts-expect-error a session is ended by its own id, never by its user
      () => facade.propose({ operation: 'end_session', target: user }),
      // @ts-expect-error a provider is named, never "all"
      () => facade.propose({ operation: 'disable_oauth_provider', target: all }),
    ]
    for (const attempt of refused) {
      await expect(attempt()).rejects.toThrow(/^not a/)
    }
    expect(requests).toEqual([])
  })

  test.each([
    ['unban_user', { type: 'user', id: TEST_USER_ID }],
    ['end_session', { type: 'session', id: TEST_USER_ID }],
    ['disable_oauth_provider', { type: 'oauth_provider', id: 'google' }],
  ] as const)(
    '%s reaches the API as the same one POST, with its target and nothing else',
    async (operation, target) => {
      const { agent, requests, bodies } = fakeClients()
      const propose = proposingAdmin(agent).propose as unknown as (
        request: unknown
      ) => Promise<{ operation: string }>
      // What a mistaken tool would hand over beside the request: none of it is sent.
      const proposal = await propose({
        operation,
        target: { ...target, enabled: true, clientSecret: 'x', ids: ['a'] },
        approve: true,
        reason: 'because',
      })
      expect(proposal.operation).toBe(operation)
      expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
        'POST /v1/agent/proposals',
      ])
      expect(bodies.map((body) => JSON.parse(body))).toEqual([{ operation, target }])
    }
  )

  test('a proposal reaches the API as one POST to the agent route, with the agent key', async () => {
    const { agent, requests, bodies } = fakeClients()
    const proposal = await proposingAdmin(agent).propose(BAN)
    expect(proposal.id).toBe(TEST_PROPOSAL_ID)
    expect(proposal.status).toBe('pending')
    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'POST /v1/agent/proposals',
    ])
    expect(requests[0]?.headers.authorization).toBe(`Bearer ${TEST_AGENT_KEY}`)
    expect(bodies.map((body) => JSON.parse(body))).toEqual([BAN])
  })

  test('the facade exposes nothing but `propose`: the client and its `call` are not reachable', () => {
    const { agent } = fakeClients()
    const facade = proposingAdmin(agent)
    expect(Object.keys(facade)).toEqual(['propose'])
    expect((facade as unknown as { call?: unknown }).call).toBeUndefined()
    expect((facade as unknown as { read?: unknown }).read).toBeUndefined()
    expect((facade as unknown as { approve?: unknown }).approve).toBeUndefined()
    expect(Object.isFrozen(facade)).toBe(true)
  })

  test('the read-only facade gained nothing: it still has `read` and no way to propose', () => {
    const { admin } = fakeClients()
    const reads = readOnlyAdmin(admin)
    expect(Object.keys(reads)).toEqual(['read'])
    expect((reads as unknown as { propose?: unknown }).propose).toBeUndefined()
    expect(READ_OPERATIONS as readonly string[]).not.toContain('createProposal')
    expect(READ_OPERATIONS as readonly string[]).not.toContain('listProposals')
  })

  test('the read-only facade still refuses the proposing operation, and nothing is sent', async () => {
    const { agent, requests } = fakeClients()
    const read = readOnlyAdmin(agent).read as unknown as (
      id: string,
      input?: unknown
    ) => Promise<unknown>
    await expect(read('createProposal', { body: BAN })).rejects.toThrow('not a read operation')
    await expect(read('approveProposal', { params: { id: TEST_PROPOSAL_ID } })).rejects.toThrow(
      'not a read operation'
    )
    expect(requests).toEqual([])
  })

  test.each([
    [
      'an operation the server has no proposal for',
      { operation: 'delete_user', target: BAN.target },
    ],
    ['an admin operation id', { operation: 'banUser', target: BAN.target }],
    ['the approval', { operation: 'approveProposal', target: BAN.target }],
    ['an inherited name', { operation: 'constructor', target: BAN.target }],
    ['`__proto__`', { operation: '__proto__', target: BAN.target }],
    ['no operation', { target: BAN.target }],
    ['an operation that is not a string', { operation: ['ban_user'], target: BAN.target }],
    [
      'a target of another kind',
      { operation: 'ban_user', target: { type: 'session', id: TEST_USER_ID } },
    ],
    [
      'a session where a user belongs',
      { operation: 'unban_user', target: { type: 'session', id: TEST_USER_ID } },
    ],
    [
      'a user where a session belongs',
      { operation: 'end_session', target: { type: 'user', id: TEST_USER_ID } },
    ],
    [
      'a user where a provider belongs',
      { operation: 'disable_oauth_provider', target: { type: 'user', id: TEST_USER_ID } },
    ],
    [
      'a provider named by a sentence',
      {
        operation: 'disable_oauth_provider',
        target: { type: 'oauth_provider', id: 'google and github' },
      },
    ],
    [
      'a list of sessions',
      { operation: 'end_session', target: { type: 'session', id: [TEST_USER_ID] } },
    ],
    ['a target with no id', { operation: 'ban_user', target: { type: 'user' } }],
    ['a target id that is a path', { operation: 'ban_user', target: { type: 'user', id: '../x' } }],
    [
      'a target id that is not a string',
      { operation: 'ban_user', target: { type: 'user', id: 7 } },
    ],
    ['no target', { operation: 'ban_user' }],
    ['nothing at all', undefined],
  ])('%s is refused at run time and nothing is sent', async (_name, request) => {
    const { agent, requests } = fakeClients()
    // The type refuses each too; the cast is what a mistake in a tool would look like.
    const propose = proposingAdmin(agent).propose as unknown as (
      request: unknown
    ) => Promise<unknown>
    await expect(propose(request)).rejects.toThrow(/^not a/)
    expect(requests).toEqual([])
  })

  test('the type of `propose` refuses what is not a proposal', async () => {
    const { agent, requests } = fakeClients()
    const facade = proposingAdmin(agent)
    // @ts-expect-error delete_user is not an operation a tool may propose
    await expect(facade.propose({ operation: 'delete_user', target: BAN.target })).rejects.toThrow()
    await expect(
      // @ts-expect-error a ban is of a user
      facade.propose({ operation: 'ban_user', target: { type: 'session', id: TEST_USER_ID } })
    ).rejects.toThrow()
    // @ts-expect-error there is no way to name an operation id: the facade has one
    await expect(facade.propose('approveProposal', BAN)).rejects.toThrow()
    expect(requests).toEqual([])
  })

  test('a proposal passes on the operation, the target and a signal, and nothing else it is handed', async () => {
    const { agent, seen } = recording()
    const { signal } = new AbortController()
    const propose = proposingAdmin(agent, OPERATIONS, 1234).propose as unknown as (
      request: unknown,
      options: unknown
    ) => Promise<unknown>
    await propose(
      {
        operation: 'ban_user',
        target: { type: 'user', id: TEST_USER_ID, approved: true, reason: 'because' },
        approve: true,
        approvedBy: { type: 'admin', id: TEST_USER_ID },
        status: 'approved',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
      {
        signal,
        headers: { authorization: 'Bearer other', 'x-tula-environment': 'x' },
        method: 'DELETE',
        params: { id: TEST_PROPOSAL_ID },
        path: `/v1/admin/proposals/${TEST_PROPOSAL_ID}/approve`,
        timeoutMs: 999_999,
      }
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]?.id).toBe('createProposal')
    expect(Object.keys(seen[0]?.input ?? {}).sort()).toEqual(['body', 'signal', 'timeoutMs'])
    expect(seen[0]?.input).toEqual({ body: BAN, signal, timeoutMs: 1234 })
    expect(seen[0]?.input.signal).toBe(signal)
  })

  test('a signal that is not one is not passed on', async () => {
    const { agent, seen } = recording()
    const propose = proposingAdmin(agent, OPERATIONS, 1234).propose as unknown as (
      request: unknown,
      options: unknown
    ) => Promise<unknown>
    await propose(BAN, { signal: { aborted: false } })
    expect(seen[0]?.input).toEqual({ body: BAN, timeoutMs: 1234 })
  })

  test.each([
    ['is a GET', { method: 'GET', path: '/v1/agent/proposals' }],
    ['is a DELETE', { method: 'DELETE', path: '/v1/agent/proposals' }],
    ['moved under /v1/admin/', { method: 'POST', path: '/v1/admin/proposals' }],
    ['became the approval', { method: 'POST', path: '/v1/admin/proposals/{id}/approve' }],
    ['is an instance route', { method: 'POST', path: '/v1/instance/proposals' }],
  ])(
    'an operation table in which the allow-listed id %s is refused when the facade is made',
    (_name, route) => {
      const { agent } = fakeClients()
      expect(() =>
        proposingAdmin(agent, { ...OPERATIONS, createProposal: route as never })
      ).toThrow('createProposal')
    }
  )

  test('an operation table without the id is refused when the facade is made', () => {
    const { agent } = fakeClients()
    const { createProposal: _gone, ...rest } = OPERATIONS
    expect(() => proposingAdmin(agent, rest)).toThrow('createProposal')
  })

  test('with a signal: the request ends when the signal aborts, and the facade is as closed', async () => {
    const { agent, seen } = recording()
    const controller = new AbortController()
    const facade = proposingWithSignal(proposingAdmin(agent, OPERATIONS, 1234), controller.signal)
    expect(Object.keys(facade)).toEqual(['propose'])
    expect(Object.isFrozen(facade)).toBe(true)
    await facade.propose(BAN)
    expect(seen[0]?.input).toEqual({ body: BAN, signal: controller.signal, timeoutMs: 1234 })
  })
})
