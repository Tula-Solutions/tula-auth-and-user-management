import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { Proposal, ProposalOperation, User } from '@tula/contract'
import { PROPOSAL_OPERATIONS } from '@tula/contract'
import { cacheEnvironmentSettings } from '~/adapters/cache/environment-settings'
import { ServiceUnavailableError } from '~/exceptions'
import { createApp } from '~/index'
import * as Proposals from '~/modules/proposal/service'
import * as Sessions from '~/modules/session/service'
import { createInstanceTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'

/**
 * The reversible operations beside the ban (ADR 0053, "The other reversible proposals"):
 * lifting a ban, ending one session, switching one provider off; and the production
 * environment's opt-in, which every operation is held to.
 */

const SK = 'tula_sk_dev_admin000000000000000000000000000000'
const AK = 'tula_ak_dev_agent000000000000000000000000000000'
const OTHER_SK = 'tula_sk_dev_other000000000000000000000000000000'
const OTHER_AK = 'tula_ak_dev_elsewhere0000000000000000000000000'
const PROD_SK = 'tula_sk_prod_admin00000000000000000000000000000'
const PROD_AK = 'tula_ak_prod_agent00000000000000000000000000000'
const OTHER = {
  projectId: '00000000-0000-7000-8000-00000000b001',
  environmentId: '00000000-0000-7000-8000-00000000f001',
} as const
const PRODUCTION = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.productionEnvironmentId,
} as const
const DEVELOPMENT = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
} as const
const UNKNOWN = '00000000-0000-7000-8000-00000000dead'
const CLIENT_SECRET = 'a-client-secret-of-the-provider'

type Scope = { projectId: string; environmentId: string }
type Target = Proposal['target']

let deps: TestDeps
let app: ReturnType<typeof createApp>
let agentKeyId: string
let secretKeyId: string

beforeEach(async () => {
  deps = createInstanceTestDeps()
  const now = deps.clock.now()
  for (const [scope, kind] of [
    [DEVELOPMENT, 'development'],
    [PRODUCTION, 'production'],
    [OTHER, 'development'],
  ] as const) {
    deps.environments.add({
      id: scope.environmentId,
      projectId: scope.projectId,
      kind,
      createdAt: now,
    })
  }
  secretKeyId = (await seedApiKey(deps, SK)).id
  agentKeyId = (await seedApiKey(deps, AK)).id
  await seedApiKey(deps, PROD_SK, { environmentId: PRODUCTION.environmentId })
  await seedApiKey(deps, PROD_AK, { environmentId: PRODUCTION.environmentId })
  await seedApiKey(deps, OTHER_SK, OTHER)
  await seedApiKey(deps, OTHER_AK, OTHER)
  app = createApp(deps)
})

function call(
  method: string,
  path: string,
  key: string | null,
  body?: unknown,
  extra: Record<string, string> = {}
) {
  return app.request(path, {
    method,
    headers: {
      ...(key && { authorization: `Bearer ${key}` }),
      ...(body !== undefined && { 'content-type': 'application/json' }),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const json = async <T>(res: Response) => (await res.json()) as T
const refusal = async (res: Response) =>
  await json<{ code: string; params?: { reason?: string }; errors?: { field: string }[] }>(res)

async function createUser(email = 'maya@northline.app', key = SK): Promise<User> {
  const res = await call('POST', '/v1/admin/users', key, {
    email,
    password: 'correct horse battery staple',
  })
  expect(res.status).toBe(201)
  return json<User>(res)
}

async function user(id: string, key = SK): Promise<User> {
  return json<User>(await call('GET', `/v1/admin/users/${id}`, key))
}

/** Sign a user in and answer the new session's id. */
async function signIn(userId: string, scope: Scope = DEVELOPMENT): Promise<string> {
  const before = new Set(
    (await deps.sessions.listActiveByUser(scope.environmentId, userId, deps.clock.now())).map(
      (session) => session.id
    )
  )
  await Sessions.create(deps, scope, { userId, client: 'ios', userAgent: null, ipAddress: null })
  const after = await deps.sessions.listActiveByUser(scope.environmentId, userId, deps.clock.now())
  const made = after.find((session) => !before.has(session.id))
  if (!made) {
    throw new Error('no session was made')
  }
  return made.id
}

async function configure(provider: string, key = SK, body: Record<string, unknown> = {}) {
  const res = await call('PUT', `/v1/admin/oauth-providers/${provider}`, key, {
    clientId: `${provider}-client-id`,
    clientSecret: CLIENT_SECRET,
    ...body,
  })
  expect(res.status).toBe(200)
}

async function saveSettings(settings: Record<string, unknown>, key = SK) {
  const current = await call('GET', '/v1/admin/settings', key)
  const res = await call('PUT', '/v1/admin/settings', key, settings, {
    'if-match': current.headers.get('etag') ?? '"0"',
  })
  expect(res.status).toBe(200)
}

const request = (operation: ProposalOperation, target: Target) => ({ operation, target })

function ask(operation: ProposalOperation, target: Target, key = AK) {
  return call('POST', '/v1/agent/proposals', key, request(operation, target))
}

async function propose(operation: ProposalOperation, target: Target, key = AK): Promise<Proposal> {
  const res = await ask(operation, target, key)
  expect(res.status).toBe(201)
  return json<Proposal>(res)
}

function approve(proposal: Pick<Proposal, 'id' | 'operation' | 'target'>, key: string | null = SK) {
  return call('POST', `/v1/admin/proposals/${proposal.id}/approve`, key, {
    operation: proposal.operation,
    target: proposal.target,
  })
}

/** The audit entries of an environment, oldest first, without ids and times. */
function recorded(environmentId: string = DEVELOPMENT.environmentId) {
  return deps.activityLog.entries
    .filter((entry) => entry.environmentId === environmentId)
    .map(({ type, actor, target, data }) => ({ type, actor, target, data }))
}

const types = (environmentId?: string) => recorded(environmentId).map((entry) => entry.type)

/**
 * One operation with something to act on: its target, what the stores say of it (compared
 * before and after: "nothing changed" is that the two are equal), and the entry its change
 * writes.
 */
interface Case {
  target: Target
  /** What the stores hold of the target, as a value that can be compared. */
  state(): Promise<unknown>
  /** The same, once the operation was carried out. */
  changed: unknown
  /** The entry of the change itself, without the proposal and its approver. */
  entry: {
    type: 'user.banned' | 'user.unbanned' | 'session.revoked' | 'oauth_provider.updated'
    target: { type: 'user' | 'session' | 'environment'; id: string }
    data: Record<string, unknown>
  }
  summary: string
}

const CASES: Record<ProposalOperation, (scope?: Scope, key?: string) => Promise<Case>> = {
  async ban_user(_scope = DEVELOPMENT, key = SK) {
    const maya = await createUser('maya@northline.app', key)
    return {
      target: { type: 'user', id: maya.id },
      state: async () => ((await user(maya.id, key)).bannedAt === null ? 'not banned' : 'banned'),
      changed: 'banned',
      entry: { type: 'user.banned', target: { type: 'user', id: maya.id }, data: {} },
      summary: `Ban the user ${maya.id}: every session of theirs ends now, and they cannot sign in until an administrator lifts the ban.`,
    }
  },
  async unban_user(_scope = DEVELOPMENT, key = SK) {
    const maya = await createUser('maya@northline.app', key)
    expect((await call('POST', `/v1/admin/users/${maya.id}/ban`, key)).status).toBe(200)
    return {
      target: { type: 'user', id: maya.id },
      state: async () => ((await user(maya.id, key)).bannedAt === null ? 'not banned' : 'banned'),
      changed: 'not banned',
      entry: { type: 'user.unbanned', target: { type: 'user', id: maya.id }, data: {} },
      summary: `Lift the ban on the user ${maya.id}: they can sign in again. The sessions that ended when they were banned stay ended.`,
    }
  },
  async end_session(scope = DEVELOPMENT, key = SK) {
    const maya = await createUser('maya@northline.app', key)
    const session = await signIn(maya.id, scope)
    const other = await signIn(maya.id, scope)
    const ended = async (id: string) =>
      (await deps.sessions.findById(scope.environmentId, id))?.revokedAt != null
    return {
      target: { type: 'session', id: session },
      // The user's other session is part of what is looked at: exactly one session ends.
      state: async () => ({
        ended: await ended(session),
        denylisted: await deps.revokedSessions.has(session, deps.clock.now()),
        otherEnded: await ended(other),
        otherDenylisted: await deps.revokedSessions.has(other, deps.clock.now()),
      }),
      changed: { ended: true, denylisted: true, otherEnded: false, otherDenylisted: false },
      entry: {
        type: 'session.revoked',
        target: { type: 'session', id: session },
        data: { userId: maya.id, reason: 'revoked_by_admin' },
      },
      summary: `End the session ${session}: whoever holds it is signed out now and has to sign in again. The user’s other sessions and the account are left as they are.`,
    }
  },
  async disable_oauth_provider(scope = DEVELOPMENT, key = SK) {
    await configure('google', key)
    await configure('github', key)
    const row = async (provider: 'google' | 'github') => {
      const found = await deps.oauthProviders.find(scope.environmentId, provider)
      return found && { ...found, updatedAt: null }
    }
    const google = await row('google')
    const github = await row('github')
    return {
      target: { type: 'oauth_provider', id: 'google' },
      state: async () => ({ google: await row('google'), github: await row('github') }),
      // The switch and nothing else: the client id, the sealed secret and the rest of the
      // row are what they were, and the other provider is untouched.
      changed: { google: { ...google, enabled: false }, github },
      entry: {
        type: 'oauth_provider.updated',
        target: { type: 'environment', id: scope.environmentId },
        data: { provider: 'google', changed: ['enabled'] },
      },
      summary:
        'Switch off sign-in with the provider google: nobody can sign in or sign up with it until an administrator switches it on again. Its credentials are kept and nothing is removed. It is refused if it would leave the environment with no way to sign in.',
    }
  },
}

const OPERATIONS = PROPOSAL_OPERATIONS.map((operation) => [operation] as const)
const NEW_OPERATIONS = OPERATIONS.filter(([operation]) => operation !== 'ban_user')

describe.each(NEW_OPERATIONS)('%s', (operation) => {
  test('a proposal says what it would do and changes nothing', async () => {
    const one = await CASES[operation]()
    const before = await one.state()
    const entries = recorded()
    const proposal = await propose(operation, one.target)
    expect(proposal).toMatchObject({
      operation,
      target: one.target,
      summary: one.summary,
      status: 'pending',
      proposedBy: { type: 'agent', id: agentKeyId },
      approvedBy: null,
      failureReason: null,
    })
    deps.clock.advance('2h')
    expect(await one.state()).toEqual(before)
    // The one thing written is the proposal's own entry, by the agent.
    expect(recorded()).toEqual([
      ...entries,
      {
        type: 'proposal.created',
        actor: { type: 'agent', id: agentKeyId },
        target: { type: 'proposal', id: proposal.id },
        data: { operation, targetType: one.target.type, targetId: one.target.id },
      },
    ])
  })

  test('approved, it is carried out as the agent, with the approver beside it', async () => {
    const one = await CASES[operation]()
    const proposal = await propose(operation, one.target)
    const entries = recorded()
    const res = await approve(proposal)
    expect(res.status).toBe(200)
    const approvedBy = { type: 'admin', id: secretKeyId } as const
    expect(await json<Proposal>(res)).toMatchObject({
      id: proposal.id,
      status: 'executed',
      approvedBy,
      failureReason: null,
    })
    expect(await one.state()).toEqual(one.changed)
    const agent = { type: 'agent', id: agentKeyId } as const
    const about = { operation, targetType: one.target.type, targetId: one.target.id }
    expect(recorded().slice(entries.length)).toEqual([
      {
        type: 'proposal.approved',
        actor: approvedBy,
        target: { type: 'proposal', id: proposal.id },
        data: { ...about, proposedBy: agentKeyId },
      },
      {
        type: one.entry.type,
        actor: agent,
        target: one.entry.target,
        data: { ...one.entry.data, proposalId: proposal.id, approvedBy },
      },
      {
        type: 'proposal.executed',
        actor: agent,
        target: { type: 'proposal', id: proposal.id },
        data: { ...about, approvedBy, changed: true },
      },
    ])
    // The event a webhook would deliver says the same: the agent, and the human beside it.
    const event = deps.activityLog.events.findLast((sent) => sent.type === one.entry.type)
    expect(event).toMatchObject({ actor: agent, data: { proposalId: proposal.id, approvedBy } })
  })

  test('it cannot be approved twice', async () => {
    const one = await CASES[operation]()
    const proposal = await propose(operation, one.target)
    expect((await approve(proposal)).status).toBe(200)
    const before = types()
    const again = await approve(proposal)
    expect(again.status).toBe(409)
    expect(await refusal(again)).toMatchObject({
      code: 'resource.conflict',
      params: { reason: 'already_decided' },
    })
    expect(types()).toEqual(before)
  })

  test('expired, it is refused and nothing changes', async () => {
    const one = await CASES[operation]()
    const before = await one.state()
    const proposal = await propose(operation, one.target)
    const entries = types()
    deps.clock.advance(Proposals.PROPOSAL_TTL_MS)
    const res = await approve(proposal)
    expect(res.status).toBe(409)
    expect((await refusal(res)).params?.reason).toBe('expired')
    expect(await one.state()).toEqual(before)
    expect(types()).toEqual(entries)
  })

  test('no agent key approves it, and another environment’s key does not find it', async () => {
    const one = await CASES[operation]()
    const before = await one.state()
    const proposal = await propose(operation, one.target)
    const entries = types()
    for (const [key, status] of [
      [AK, 401],
      [OTHER_AK, 401],
      [null, 401],
      [OTHER_SK, 404],
      [PROD_SK, 404],
    ] as const) {
      expect((await approve(proposal, key)).status).toBe(status)
    }
    expect(await one.state()).toEqual(before)
    expect(types()).toEqual(entries)
    // Refused, not spent.
    expect((await approve(proposal)).status).toBe(200)
  })

  test('an approval that names another operation or target is refused, and not spent', async () => {
    const one = await CASES[operation]()
    const before = await one.state()
    const proposal = await propose(operation, one.target)
    const elsewhere: Target =
      one.target.type === 'oauth_provider'
        ? { type: 'oauth_provider', id: 'github' }
        : { type: one.target.type, id: UNKNOWN }
    for (const shown of [
      { ...proposal, target: elsewhere },
      { ...proposal, operation: 'ban_user', target: { type: 'user', id: UNKNOWN } } as const,
    ]) {
      const res = await approve(shown)
      // Naming a ban for a proposal that is a ban of somebody else is a mismatch as well.
      expect(res.status).toBe(409)
      expect((await refusal(res)).params?.reason).toBe('mismatch')
    }
    expect(await one.state()).toEqual(before)
    expect((await approve(proposal)).status).toBe(200)
    expect(await one.state()).toEqual(one.changed)
  })

  test('another environment’s agent cannot propose about it', async () => {
    const one = await CASES[operation]()
    const res = await ask(operation, one.target, OTHER_AK)
    expect(res.status).toBe(404)
    expect(await deps.proposals.list(OTHER.environmentId, 10)).toEqual([])
  })
})

describe('what a proposal may name', () => {
  test.each([
    ['a session that does not exist', 'end_session', { type: 'session', id: UNKNOWN }, 404],
    ['a user that does not exist', 'unban_user', { type: 'user', id: UNKNOWN }, 404],
    [
      'a provider that is not configured',
      'disable_oauth_provider',
      { type: 'oauth_provider', id: 'github' },
      404,
    ],
    [
      'a provider that is not on the list',
      'disable_oauth_provider',
      { type: 'oauth_provider', id: 'myspace' },
      422,
    ],
    [
      'a provider named by an id',
      'disable_oauth_provider',
      { type: 'oauth_provider', id: UNKNOWN },
      422,
    ],
    ['a session named by a provider’s name', 'end_session', { type: 'session', id: 'google' }, 422],
    ['a session where a user belongs', 'unban_user', { type: 'session', id: UNKNOWN }, 422],
    ['a user where a session belongs', 'end_session', { type: 'user', id: UNKNOWN }, 422],
    ['every session of a user', 'end_sessions', { type: 'user', id: UNKNOWN }, 422],
    [
      'switching a provider on',
      'enable_oauth_provider',
      { type: 'oauth_provider', id: 'google' },
      422,
    ],
    ['removing a provider', 'delete_oauth_provider', { type: 'oauth_provider', id: 'google' }, 422],
  ] as const)('%s is refused', async (_name, operation, target, status) => {
    const res = await call('POST', '/v1/agent/proposals', AK, { operation, target })
    expect(res.status).toBe(status)
    expect(await deps.proposals.list(DEVELOPMENT.environmentId, 10)).toEqual([])
    expect(types()).toEqual([])
  })

  test.each([
    ['a secret for the provider', { clientSecret: 'x' }],
    ['a switch of the agent’s choosing', { enabled: true }],
    ['a second provider', { providers: ['github'] }],
  ])('a proposal to switch a provider off with %s is refused', async (_name, extra) => {
    await configure('google')
    await configure('github')
    const before = types()
    const res = await call('POST', '/v1/agent/proposals', AK, {
      ...request('disable_oauth_provider', { type: 'oauth_provider', id: 'google' }),
      ...extra,
    })
    expect(res.status).toBe(422)
    expect(types()).toEqual(before)
  })
})

describe('a target that changed while the proposal waited', () => {
  test('a session that is gone: approved, spent, and said as failed', async () => {
    const one = await CASES.end_session()
    const proposal = await propose('end_session', one.target)
    // Deleted with its user, or by the retention job: the store has no such row any more.
    const gone = spyOn(deps.sessions, 'findById').mockResolvedValue(null)
    try {
      const res = await approve(proposal)
      expect(res.status).toBe(200)
      expect(await json<Proposal>(res)).toMatchObject({
        status: 'failed',
        failureReason: 'target_not_found',
      })
    } finally {
      gone.mockRestore()
    }
    expect(types()).not.toContain('session.revoked')
    expect((await refusal(await approve(proposal))).params?.reason).toBe('already_decided')
  })

  test('a session that had ended by itself: carried out, with no second ending recorded', async () => {
    const one = await CASES.end_session()
    const proposal = await propose('end_session', one.target)
    const owner = (await deps.sessions.findById(DEVELOPMENT.environmentId, one.target.id))?.userId
    expect((await call('DELETE', `/v1/admin/users/${owner}/sessions`, SK)).status).toBeLessThan(300)
    const before = types().filter((type) => type === 'session.revoked').length
    // Carried out, and said as having changed nothing: the session was already ended.
    expect(await json<Proposal>(await approve(proposal))).toMatchObject({
      status: 'executed',
      changed: false,
    })
    expect(types().filter((type) => type === 'session.revoked')).toHaveLength(before)
    expect(recorded().at(-1)).toMatchObject({ type: 'proposal.executed', data: { changed: false } })
  })

  test('a user whose ban an administrator had lifted: carried out, nothing more recorded', async () => {
    const one = await CASES.unban_user()
    const proposal = await propose('unban_user', one.target)
    expect((await call('POST', `/v1/admin/users/${one.target.id}/unban`, SK)).status).toBe(200)
    expect(await json<Proposal>(await approve(proposal))).toMatchObject({
      status: 'executed',
      changed: false,
    })
    expect(recorded().at(-1)).toMatchObject({ type: 'proposal.executed', data: { changed: false } })
    expect(types().filter((type) => type === 'user.unbanned')).toHaveLength(1)
    expect(await one.state()).toBe('not banned')
  })

  test('a provider that was removed: said as failed', async () => {
    const one = await CASES.disable_oauth_provider()
    const proposal = await propose('disable_oauth_provider', one.target)
    expect((await call('DELETE', '/v1/admin/oauth-providers/google', SK)).status).toBe(204)
    expect(await json<Proposal>(await approve(proposal))).toMatchObject({
      status: 'failed',
      failureReason: 'target_not_found',
    })
  })

  test('a provider an administrator had switched off: carried out, nothing more recorded', async () => {
    const one = await CASES.disable_oauth_provider()
    const proposal = await propose('disable_oauth_provider', one.target)
    await configure('google', SK, { enabled: false })
    const before = types()
    expect(await json<Proposal>(await approve(proposal))).toMatchObject({
      status: 'executed',
      changed: false,
    })
    expect(types().slice(before.length)).toEqual(['proposal.approved', 'proposal.executed'])
    expect(recorded().at(-1)).toMatchObject({ type: 'proposal.executed', data: { changed: false } })
  })

  test.each(OPERATIONS)(
    '%s that changes its target says so: changed is true, in the answer and the entry',
    async (operation) => {
      const one = await CASES[operation]()
      const proposal = await propose(operation, one.target)
      expect(await json<Proposal>(await approve(proposal))).toMatchObject({
        status: 'executed',
        changed: true,
      })
      expect(recorded().at(-1)).toMatchObject({
        type: 'proposal.executed',
        data: { changed: true },
      })
      // Only the approval's own answer says it: a later read has no such field.
      const read = await json<Proposal>(await call('GET', `/v1/admin/proposals/${proposal.id}`, SK))
      expect(read.status).toBe('executed')
      expect('changed' in read).toBe(false)
    }
  )

  test('a user somebody had already banned: the ban is run again, so it is never said as nothing changed', async () => {
    const one = await CASES.ban_user()
    const proposal = await propose('ban_user', one.target)
    expect((await call('POST', `/v1/admin/users/${one.target.id}/ban`, SK)).status).toBe(200)
    // Banning again ends the sessions made since and writes its entry: a change was made.
    expect(await json<Proposal>(await approve(proposal))).toMatchObject({
      status: 'executed',
      changed: true,
    })
  })

  test('a failed proposal says nothing about a change', async () => {
    const one = await CASES.disable_oauth_provider()
    const proposal = await propose('disable_oauth_provider', one.target)
    expect((await call('DELETE', '/v1/admin/oauth-providers/google', SK)).status).toBe(204)
    const answer = await json<Proposal>(await approve(proposal))
    expect(answer.status).toBe('failed')
    expect('changed' in answer).toBe(false)
  })
})

describe('an operation this version does not know', () => {
  test('a stored row with an unknown operation word: failed with error, never executed, nothing changed', async () => {
    const one = await CASES.ban_user()
    const proposal = await propose('ban_user', one.target)
    // What a row written by a later version would be: the column is text, the type a cast.
    const approveRow = deps.proposals.approve.bind(deps.proposals)
    const stored = spyOn(deps.proposals, 'approve').mockImplementation(async (...args) => {
      const row = await approveRow(...args)
      return row && { ...row, operation: 'purge_everything' as ProposalOperation }
    })
    try {
      const res = await approve(proposal)
      expect(res.status).toBe(200)
      expect(await json<Proposal>(res)).toMatchObject({ status: 'failed', failureReason: 'error' })
    } finally {
      stored.mockRestore()
    }
    expect(types()).not.toContain('proposal.executed')
    expect(types().at(-1)).toBe('proposal.failed')
    expect(types()).not.toContain('user.banned')
    expect(await one.state()).toBe('not banned')
    expect((await refusal(await approve(proposal))).params?.reason).toBe('already_decided')
  })
})

describe('switching off the last way to sign in', () => {
  const GOOGLE = { type: 'oauth_provider', id: 'google' } as const
  const passwordOff = { signIn: { methods: { password: { enabled: false } } } }

  test('is refused when it is proposed, with the provider route’s own error', async () => {
    await configure('google')
    await saveSettings(passwordOff)
    const before = types()
    const res = await ask('disable_oauth_provider', GOOGLE)
    expect(res.status).toBe(422)
    // What the admin route answers for the same change.
    const direct = await call('PUT', '/v1/admin/oauth-providers/google', SK, {
      clientId: 'google-client-id',
      enabled: false,
    })
    expect(direct.status).toBe(422)
    const [asked, admin] = [await refusal(res), await refusal(direct)]
    expect(asked.code).toBe(admin.code)
    expect(asked.errors).toEqual(admin.errors)
    expect(asked.errors).toMatchObject([{ field: 'enabled' }])
    expect(await deps.proposals.list(DEVELOPMENT.environmentId, 10)).toEqual([])
    expect(types()).toEqual(before)
    expect((await deps.oauthProviders.find(DEVELOPMENT.environmentId, 'google'))?.enabled).toBe(
      true
    )
  })

  test('a second provider makes the first one proposable, and its approval leaves the second', async () => {
    await configure('google')
    await configure('github')
    await saveSettings(passwordOff)
    const proposal = await propose('disable_oauth_provider', GOOGLE)
    expect(await json<Proposal>(await approve(proposal))).toMatchObject({ status: 'executed' })
    // And now the second is the last way in: neither an agent's proposal nor an approval
    // takes it.
    const res = await ask('disable_oauth_provider', { type: 'oauth_provider', id: 'github' })
    expect(res.status).toBe(422)
  })

  // What the proposal's creation saw decided nothing: the approval asks again, under the
  // environment's lock, by the function the admin route asks.
  test('is refused when it is approved, whatever was true when it was proposed', async () => {
    await configure('google')
    await configure('github')
    await saveSettings(passwordOff)
    const proposal = await propose('disable_oauth_provider', GOOGLE)
    // While the proposal waits, the other provider goes: Google is now the last way in.
    expect((await call('DELETE', '/v1/admin/oauth-providers/github', SK)).status).toBe(204)
    const before = types()
    const res = await approve(proposal)
    expect(res.status).toBe(200)
    const approvedBy = { type: 'admin', id: secretKeyId }
    expect(await json<Proposal>(res)).toMatchObject({
      status: 'failed',
      failureReason: 'last_sign_in_method',
      approvedBy,
    })
    expect((await deps.oauthProviders.find(DEVELOPMENT.environmentId, 'google'))?.enabled).toBe(
      true
    )
    expect(types().slice(before.length)).toEqual(['proposal.approved', 'proposal.failed'])
    expect(recorded().at(-1)).toEqual({
      type: 'proposal.failed',
      actor: { type: 'agent', id: agentKeyId },
      target: { type: 'proposal', id: proposal.id },
      data: {
        operation: 'disable_oauth_provider',
        targetType: 'oauth_provider',
        targetId: 'google',
        approvedBy,
        reason: 'last_sign_in_method',
      },
    })
    // Spent: a way to sign in that comes back does not revive it.
    await saveSettings({ signIn: { methods: { password: { enabled: true } } } })
    expect((await refusal(await approve(proposal))).params?.reason).toBe('already_decided')
    expect((await deps.oauthProviders.find(DEVELOPMENT.environmentId, 'google'))?.enabled).toBe(
      true
    )
  })

  test('the approval takes the lock the settings and the provider routes take', async () => {
    await configure('google')
    await configure('github')
    const proposal = await propose('disable_oauth_provider', GOOGLE)
    const lock = spyOn(deps.environmentLock, 'runExclusive')
    try {
      expect((await approve(proposal)).status).toBe(200)
      expect(lock.mock.calls.map(([environment, name]) => [environment, name])).toEqual([
        [DEVELOPMENT.environmentId, 'sign_in_methods'],
      ])
    } finally {
      lock.mockRestore()
    }
  })
})

describe('a production environment', () => {
  const optIn = (on: boolean) => saveSettings({ agents: { proposalsInProduction: on } }, PROD_SK)

  test.each(OPERATIONS)('refuses a proposal to %s unless it opted in', async (operation) => {
    const one = await CASES[operation](PRODUCTION, PROD_SK)
    const before = await one.state()
    const entries = types(PRODUCTION.environmentId)
    const refused = await ask(operation, one.target, PROD_AK)
    expect(refused.status).toBe(403)
    expect(await refusal(refused)).toMatchObject({
      code: 'auth.forbidden',
      params: { reason: 'production_environment' },
    })
    expect(await deps.proposals.list(PRODUCTION.environmentId, 10)).toEqual([])
    expect(types(PRODUCTION.environmentId)).toEqual(entries)

    await optIn(true)
    const proposal = await propose(operation, one.target, PROD_AK)
    expect(await one.state()).toEqual(before)
    expect(await json<Proposal>(await approve(proposal, PROD_SK))).toMatchObject({
      status: 'executed',
    })
    expect(await one.state()).toEqual(one.changed)
  })

  test('is refused before anything is said about the target', async () => {
    for (const target of [
      { type: 'user', id: UNKNOWN },
      { type: 'user', id: (await createUser('maya@northline.app', PROD_SK)).id },
    ] as const) {
      const res = await ask('unban_user', target, PROD_AK)
      expect(res.status).toBe(403)
    }
  })

  test('the opt-in is off by default, and switching it on is recorded as a weakening', async () => {
    const read = await json<{ settings: { agents: { proposalsInProduction: boolean } } }>(
      await call('GET', '/v1/admin/settings', PROD_SK)
    )
    expect(read.settings.agents).toEqual({ proposalsInProduction: false })
    await optIn(true)
    const entry = recorded(PRODUCTION.environmentId).at(-1)
    expect(entry).toMatchObject({
      type: 'environment.settings_updated',
      actor: { type: 'admin' },
      data: { changed: ['agents.proposalsInProduction'], weakened: true },
    })
    // Switching it off again is recorded, and is no weakening.
    await optIn(false)
    const off = recorded(PRODUCTION.environmentId).at(-1)
    expect(off?.data).toMatchObject({ changed: ['agents.proposalsInProduction'] })
    expect(off?.data).not.toHaveProperty('weakened')
  })

  test('an agent key cannot switch the opt-in on', async () => {
    const current = await call('GET', '/v1/admin/settings', PROD_SK)
    const res = await call(
      'PUT',
      '/v1/admin/settings',
      PROD_AK,
      { agents: { proposalsInProduction: true } },
      { 'if-match': current.headers.get('etag') ?? '"0"' }
    )
    expect(res.status).toBe(401)
    const maya = await createUser('maya@northline.app', PROD_SK)
    expect((await ask('ban_user', { type: 'user', id: maya.id }, PROD_AK)).status).toBe(403)
  })

  test.each(OPERATIONS)(
    'opted out while a proposal to %s waited: the approval is refused, and not spent',
    async (operation) => {
      const one = await CASES[operation](PRODUCTION, PROD_SK)
      const before = await one.state()
      await optIn(true)
      const proposal = await propose(operation, one.target, PROD_AK)
      await optIn(false)
      const entries = types(PRODUCTION.environmentId)
      const res = await approve(proposal, PROD_SK)
      expect(res.status).toBe(409)
      expect(await refusal(res)).toMatchObject({
        code: 'resource.conflict',
        params: { reason: 'production_environment' },
      })
      expect(await one.state()).toEqual(before)
      expect(types(PRODUCTION.environmentId)).toEqual(entries)
      // Nothing was written, so the proposal is still what it was: opted in again within
      // its ten minutes, the same approval is carried out.
      await optIn(true)
      expect(await json<Proposal>(await approve(proposal, PROD_SK))).toMatchObject({
        status: 'executed',
      })
      expect(await one.state()).toEqual(one.changed)
    }
  )

  // An opt-in that was switched off stops what is waiting on every instance at once, not
  // within the settings cache's seconds.
  test('an instance whose settings cache still says “on” refuses all the same', async () => {
    const one = await CASES.unban_user(PRODUCTION, PROD_SK)
    await optIn(true)
    const cached = cacheEnvironmentSettings(deps.environmentSettings, deps.clock, 30_000)
    const other = createApp({ ...deps, environmentSettings: cached })
    const viaOther = (path: string, key: string, body: unknown) =>
      other.request(path, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const about = request('unban_user', one.target)
    // The other instance reads the settings into its cache, and its agent proposes.
    expect((await cached.get(PRODUCTION.environmentId))?.settings.agents).toEqual({
      proposalsInProduction: true,
    })
    const asked = await viaOther('/v1/agent/proposals', PROD_AK, about)
    expect(asked.status).toBe(201)
    const proposal = await json<Proposal>(asked)
    // Switched off through this instance; the other has not heard.
    await optIn(false)
    expect((await cached.get(PRODUCTION.environmentId))?.settings.agents).toEqual({
      proposalsInProduction: true,
    })
    const approval = await viaOther(`/v1/admin/proposals/${proposal.id}/approve`, PROD_SK, about)
    expect(approval.status).toBe(409)
    expect((await refusal(approval)).params?.reason).toBe('production_environment')
    expect((await viaOther('/v1/agent/proposals', PROD_AK, about)).status).toBe(403)
    expect(await one.state()).toBe('banned')
  })

  test('“production” is the environment’s own kind, not the deployment’s tier', async () => {
    // The deployment of these tests is not a production one, and the production
    // environment is still refused; a development environment's setting changes nothing.
    expect(deps.config.tier).not.toBe('prod')
    await saveSettings({ agents: { proposalsInProduction: false } })
    const one = await CASES.unban_user()
    expect((await ask('unban_user', one.target)).status).toBe(201)
  })

  test('one environment’s opt-in is not another’s', async () => {
    await saveSettings({ agents: { proposalsInProduction: true } })
    const maya = await createUser('maya@northline.app', PROD_SK)
    expect((await ask('ban_user', { type: 'user', id: maya.id }, PROD_AK)).status).toBe(403)
  })
})

describe('limits', () => {
  async function bannedUsers(count: number): Promise<User[]> {
    const users: User[] = []
    for (let i = 0; i < count; i++) {
      const one = await createUser(`user${i}@northline.app`)
      expect((await call('POST', `/v1/admin/users/${one.id}/ban`, SK)).status).toBe(200)
      users.push(one)
    }
    return users
  }

  test('each operation has its own count in an environment', async () => {
    const limit = Proposals.PROPOSALS_PER_OPERATION_PER_MINUTE
    const users = await bannedUsers(limit + 1)
    for (const one of users.slice(0, limit)) {
      await propose('unban_user', { type: 'user', id: one.id })
    }
    const last = { type: 'user', id: (users[limit] as User).id } as const
    const refused = await ask('unban_user', last)
    expect(refused.status).toBe(429)
    expect((await refusal(refused)).code).toBe('rate_limited')
    expect(await deps.proposals.list(DEVELOPMENT.environmentId, 100)).toHaveLength(limit)
    // Another operation is counted apart, and so is another environment.
    const session = await signIn(last.id)
    expect((await ask('end_session', { type: 'session', id: session })).status).toBe(201)
    const elsewhere = await createUser('maya@northline.app', OTHER_SK)
    expect((await call('POST', `/v1/admin/users/${elsewhere.id}/ban`, OTHER_SK)).status).toBe(200)
    expect((await ask('unban_user', { type: 'user', id: elsewhere.id }, OTHER_AK)).status).toBe(201)
    deps.clock.advance('1m')
    expect((await ask('unban_user', last)).status).toBe(201)
  })

  test('a request that names no operation of the list is not counted against one', async () => {
    const hit = spyOn(deps.rateLimiter, 'hit')
    try {
      const res = await call('POST', '/v1/agent/proposals', AK, {
        operation: 'delete_user',
        target: { type: 'user', id: UNKNOWN },
      })
      expect(res.status).toBe(422)
      const buckets = hit.mock.calls.map(([bucket]) => bucket)
      expect(buckets.filter((bucket) => bucket.startsWith('proposal_create_operation:'))).toEqual(
        []
      )
    } finally {
      hit.mockRestore()
    }
  })

  test('the keys hold the environment and the operation, and nothing of the target', async () => {
    const one = await CASES.disable_oauth_provider()
    const hit = spyOn(deps.rateLimiter, 'hit')
    try {
      await propose('disable_oauth_provider', one.target)
      expect(
        hit.mock.calls.map(([bucket]) => bucket).filter((b) => b.startsWith('proposal_'))
      ).toEqual([
        `proposal_create:env:${DEVELOPMENT.environmentId}`,
        `proposal_create_operation:env:${DEVELOPMENT.environmentId}:disable_oauth_provider`,
      ])
    } finally {
      hit.mockRestore()
    }
  })

  test.each([
    ['the environment’s count', 'proposal_create:'],
    ['an operation’s count', 'proposal_create_operation:'],
  ])('when the limiter cannot take %s, nothing is proposed', async (_name, prefix) => {
    const one = await CASES.end_session()
    const entries = types()
    const hit = deps.rateLimiter.hit.bind(deps.rateLimiter)
    const down = spyOn(deps.rateLimiter, 'hit').mockImplementation(
      async (bucket, limit, window) => {
        if (bucket.startsWith(prefix)) {
          throw new ServiceUnavailableError()
        }
        return hit(bucket, limit, window)
      }
    )
    try {
      const res = await ask('end_session', one.target)
      expect(res.status).toBe(503)
    } finally {
      down.mockRestore()
    }
    expect(await deps.proposals.list(DEVELOPMENT.environmentId, 10)).toEqual([])
    expect(types()).toEqual(entries)
  })
})
