import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { AdminFetch } from '@tula/admin'
import { createApp } from '../../../apps/api/src/index'
import * as Sessions from '../../../apps/api/src/modules/session/service'
import {
  createTestDeps,
  seedApiKey,
  TEST_TENANT,
  type TestDeps,
} from '../../../apps/api/src/testing'
import { type CliIo, COMMANDS, runCli } from './index'

// `tula approve` against the real API in process: a person's answer to a proposal an agent
// made (ADR 0053). Every run's output is searched for both keys.

const SECRET_KEY = 'tula_sk_dev_approvetest00000000000000000000000'
const AGENT_KEY = 'tula_ak_dev_approvetest00000000000000000000000'
const BASE_URL = 'http://localhost:3003'
const NO_SUCH = '0199c2f4-7a10-7c3e-9b1a-5d2e8f4a6c01'

let deps: TestDeps
let app: ReturnType<typeof createApp>
/** Every request that left the process, e.g. `POST /v1/admin/proposals/<id>/approve`. */
let wire: { line: string; authorization: string | null; body: string }[]

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
  wire = []
})

async function api(key: string, method: string, path: string, body?: unknown) {
  const response = await app.request(path, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  // A removal answers 204 with no body.
  const text = await response.text()
  return {
    status: response.status,
    body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>,
  }
}

async function user(email = 'maya@northline.app', firstName = 'Maya'): Promise<string> {
  const created = await api(SECRET_KEY, 'POST', '/v1/admin/users', {
    email,
    password: 'correct horse battery staple',
    firstName,
  })
  expect(created.status).toBe(201)
  return String(created.body.id)
}

async function propose(userId: string): Promise<string> {
  const proposed = await api(AGENT_KEY, 'POST', '/v1/agent/proposals', {
    operation: 'ban_user',
    target: { type: 'user', id: userId },
  })
  expect(proposed.status).toBe(201)
  return String(proposed.body.id)
}

async function bannedAt(userId: string): Promise<unknown> {
  return (await api(SECRET_KEY, 'GET', `/v1/admin/users/${userId}`)).body.bannedAt
}

interface Run {
  code: number
  stdout: string
  stderr: string
  questions: string[]
}

async function tula(args: string[], io: Partial<CliIo> = {}, answer?: string): Promise<Run> {
  let stdout = ''
  let stderr = ''
  const questions: string[] = []
  const fetch: AdminFetch = async (url, init) => {
    wire.push({
      line: `${init?.method ?? 'GET'} ${new URL(url).pathname}`,
      authorization: new Headers(init?.headers).get('authorization'),
      body: String(init?.body ?? ''),
    })
    return app.request(url, init)
  }
  const code = await runCli(
    args,
    {
      stdout: { write: (text) => (stdout += text) },
      stderr: { write: (text) => (stderr += text) },
      env: { TULA_API_URL: BASE_URL, TULA_SECRET_KEY: SECRET_KEY },
      cwd: '/nowhere',
      isTTY: answer !== undefined,
      stdinIsTTY: answer !== undefined,
      fetch,
      now: () => deps.clock.now(),
      ...(answer !== undefined
        ? {
            prompt: async (question: string) => {
              questions.push(question)
              return answer
            },
          }
        : {}),
      ...io,
    },
    COMMANDS
  )
  // No run prints a key, whatever happened.
  expect(stdout + stderr).not.toContain(SECRET_KEY)
  expect(stdout + stderr).not.toContain(AGENT_KEY)
  expect(stdout + stderr).not.toContain('Bearer ')
  return { code, stdout, stderr, questions }
}

const writes = () => wire.filter((request) => !request.line.startsWith('GET ')).map((r) => r.line)

describe('tula approve', () => {
  test('shows the proposal and who it is about, asks, approves, and the user is banned', async () => {
    const userId = await user()
    const id = await propose(userId)
    const run = await tula(['approve', id], {}, 'yes')
    expect(run.code).toBe(0)
    expect(run.stdout).toContain(`Proposal ${id}`)
    expect(run.stdout).toContain('an agent (agent key ')
    expect(run.stdout).toContain(`user ${userId} (maya@northline.app, Maya)`)
    expect(run.stdout).toContain('waiting for approval')
    expect(run.stdout).toContain('in about 10 min')
    expect(run.stdout).toContain('Approved and carried out.')
    expect(run.questions).toHaveLength(1)
    expect(run.questions[0]).toContain('The user is banned at once')
    expect(run.questions[0]).toContain('maya@northline.app')
    expect(run.questions[0]).toContain(BASE_URL)
    expect(await bannedAt(userId)).not.toBeNull()
    expect(writes()).toEqual([`POST /v1/admin/proposals/${id}/approve`])
    // The approval repeats what was shown, and goes out with the person's key.
    const approval = wire.find((request) => request.line.endsWith('/approve'))
    expect(JSON.parse(approval?.body ?? '{}')).toEqual({
      operation: 'ban_user',
      target: { type: 'user', id: userId },
    })
    expect(approval?.authorization).toBe(`Bearer ${SECRET_KEY}`)
  })

  test('the audit log names the agent as the one who banned and the person who approved', async () => {
    const userId = await user()
    const id = await propose(userId)
    expect((await tula(['approve', id], {}, 'yes')).code).toBe(0)
    const log = await api(SECRET_KEY, 'GET', '/v1/admin/audit-logs?size=100')
    const entries = log.body.data as {
      action: string
      actor: { type: string; id: string | null }
      metadata: Record<string, unknown>
    }[]
    const of = (action: string) => entries.find((entry) => entry.action === action)
    expect(of('proposal.created')?.actor.type).toBe('agent')
    expect(of('proposal.approved')?.actor.type).toBe('admin')
    expect(of('proposal.executed')?.actor.type).toBe('agent')
    expect(of('user.banned')?.actor.type).toBe('agent')
    expect(of('user.banned')?.metadata).toMatchObject({
      proposalId: id,
      approvedBy: { type: 'admin', id: of('proposal.approved')?.actor.id },
    })
  })

  test.each([['no'], [''], ['y'], ['YES please']])(
    'answering %p declines: nothing is sent and nothing changes',
    async (answer) => {
      const userId = await user()
      const id = await propose(userId)
      const run = await tula(['approve', id], {}, answer)
      expect(run.code).toBe(1)
      expect(run.stderr).toContain('Cancelled. Nothing was changed.')
      expect(writes()).toEqual([])
      expect(await bannedAt(userId)).toBeNull()
    }
  )

  // An approval is typed at a terminal, by whoever sits at it (ADR 0053, "An approval
  // cannot be scripted"): an agent with a shell must not approve by running the command.
  const NOT_A_TERMINAL =
    'tula approve asks its question at a terminal and takes the answer typed there: standard ' +
    'input and standard error are not both a terminal, so there is nobody to ask. There is no ' +
    'option that answers for you. Nothing was read or changed.'

  test.each([
    ['nothing is a terminal', {}],
    ['only standard input is', { stdinIsTTY: true }],
    ['a prompt is offered but the run is not at a terminal', { prompt: async () => 'yes' }],
    ['at a terminal with nothing to ask through', { isTTY: true }],
  ] as [string, Partial<CliIo>][])(
    'not at a terminal (%s): refused with one fixed message, before any request',
    async (_name, io) => {
      const userId = await user()
      const id = await propose(userId)
      wire = []
      const run = await tula(['approve', id], io)
      expect(run.code).toBe(1)
      expect(run.stderr).toContain(NOT_A_TERMINAL)
      expect(run.stdout).toBe('')
      // Not the approval, and not the read of the proposal either.
      expect(wire).toEqual([])
      expect(await bannedAt(userId)).toBeNull()
    }
  )

  test.each([['--yes'], ['-y'], ['--yes=true'], ['--force'], ['--no-input']])(
    'there is no option that answers the question: %s is refused, at a terminal and away from one, and nothing is asked or sent',
    async (flag) => {
      const userId = await user()
      const id = await propose(userId)
      wire = []
      for (const answer of [undefined, 'yes']) {
        const run = await tula(['approve', id, flag], {}, answer)
        expect(run.code).toBe(1)
        expect(run.stderr).toContain('Unknown option')
        expect(run.questions).toEqual([])
      }
      expect(wire).toEqual([])
      expect(await bannedAt(userId)).toBeNull()
    }
  )

  test('--json away from a terminal is refused like any run: it does not stand in for an answer', async () => {
    const userId = await user()
    const id = await propose(userId)
    wire = []
    const run = await tula(['approve', id, '--json'])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain(NOT_A_TERMINAL)
    expect(wire).toEqual([])
  })

  test.each([['no'], ['y'], ['Y'], ['yes please'], [''], ['approve'], ['ja']])(
    'at a terminal, the typed answer %p approves nothing',
    async (answer) => {
      const userId = await user()
      const id = await propose(userId)
      const run = await tula(['approve', id], {}, answer)
      expect(run.code).toBe(1)
      expect(run.questions).toHaveLength(1)
      expect(run.stderr).toContain('Cancelled. Nothing was changed.')
      expect(writes()).toEqual([])
      expect(await bannedAt(userId)).toBeNull()
    }
  )

  test('at a terminal, a typed yes approves once: one question, one approval', async () => {
    const userId = await user()
    const id = await propose(userId)
    wire = []
    const run = await tula(['approve', id], {}, ' Yes ')
    expect(run.code).toBe(0)
    expect(run.questions).toHaveLength(1)
    expect(writes()).toEqual([`POST /v1/admin/proposals/${id}/approve`])
    expect(await bannedAt(userId)).not.toBeNull()
  })

  test('the question names the operation and the target, made printable, and where', async () => {
    const userId = await user('eve@northline.app', 'Eve\u001b[2J\u{202E}approved')
    const id = await propose(userId)
    const run = await tula(['approve', id], {}, 'no')
    const question = run.questions[0] ?? ''
    expect(question).toContain('Approve ban_user for user ')
    expect(question).toContain(userId)
    expect(question).toContain('eve@northline.app')
    expect(question).toContain(BASE_URL)
    expect(question).toContain('Type yes to continue: ')
    expect(question).not.toContain('\u001b')
    expect(question).not.toContain('\u{202E}')
  })

  test('--json at a terminal still shows the proposal before it asks, on standard error', async () => {
    const userId = await user()
    const id = await propose(userId)
    const run = await tula(['approve', id, '--json'], {}, 'no')
    expect(run.code).toBe(1)
    expect(run.stderr).toContain(`Proposal ${id}`)
    expect(run.stderr).toContain('Operation      ban_user')
    expect(run.stdout).toBe('')
    expect(writes()).toEqual([])
  })

  test('a proposal cannot be approved twice: the second run changes nothing and says why', async () => {
    const userId = await user()
    const id = await propose(userId)
    expect((await tula(['approve', id], {}, 'yes')).code).toBe(0)
    await api(SECRET_KEY, 'POST', `/v1/admin/users/${userId}/unban`)
    wire = []
    const second = await tula(['approve', id], {}, 'yes')
    expect(second.code).toBe(1)
    expect(second.stderr).toContain('approved and carried out: there is nothing to approve')
    expect(writes()).toEqual([])
    expect(await bannedAt(userId)).toBeNull()
  })

  test('an expired proposal is refused: shown as expired, nothing sent', async () => {
    const userId = await user()
    const id = await propose(userId)
    deps.clock.advance('11m')
    const run = await tula(['approve', id], {}, 'yes')
    expect(run.code).toBe(1)
    expect(run.stdout).toContain('expired (it was not approved in time)')
    expect(run.stderr).toContain('there is nothing to approve')
    expect(writes()).toEqual([])
    expect(await bannedAt(userId)).toBeNull()
  })

  test('a proposal that expires while the question is open is refused by the server', async () => {
    const userId = await user()
    const id = await propose(userId)
    const run = await tula(
      ['approve', id],
      {
        isTTY: true,
        prompt: async () => {
          deps.clock.advance('11m')
          return 'yes'
        },
      },
      undefined
    )
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('The proposal has expired. Nothing was changed.')
    expect(await bannedAt(userId)).toBeNull()
  })

  test('a proposal approved elsewhere while the question is open is not approved again', async () => {
    const userId = await user()
    const id = await propose(userId)
    const run = await tula(
      ['approve', id],
      {
        isTTY: true,
        prompt: async () => {
          const first = await api(SECRET_KEY, 'POST', `/v1/admin/proposals/${id}/approve`, {
            operation: 'ban_user',
            target: { type: 'user', id: userId },
          })
          expect(first.status).toBe(200)
          return 'yes'
        },
      },
      undefined
    )
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('already approved')
  })

  test('a user deleted after the proposal: approved, not carried out, and said so', async () => {
    const userId = await user()
    const id = await propose(userId)
    const run = await tula(
      ['approve', id],
      {
        isTTY: true,
        prompt: async () => {
          await app.request(`/v1/admin/users/${userId}`, {
            method: 'DELETE',
            headers: { authorization: `Bearer ${SECRET_KEY}` },
          })
          return 'yes'
        },
      },
      undefined
    )
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('nothing was changed: the user no longer exists')
    expect(run.stderr).toContain('The proposal is spent')
    expect(run.stdout).not.toContain('Approved and carried out')
  })

  describe('when the agent key that asked is revoked', () => {
    async function revokeAgentKey(): Promise<void> {
      const keys = await api(SECRET_KEY, 'GET', '/v1/admin/api-keys')
      const agent = (keys.body.data as { id: string; kind: string }[]).find(
        (key) => key.kind === 'agent'
      )
      const revoked = await api(SECRET_KEY, 'DELETE', `/v1/admin/api-keys/${agent?.id}`)
      expect(revoked.status).toBe(200)
    }

    test('the proposal is shown as ended by that, and nothing is sent', async () => {
      const userId = await user()
      const id = await propose(userId)
      await revokeAgentKey()
      const run = await tula(['approve', id], {}, 'yes')
      expect(run.code).toBe(1)
      expect(run.stdout).toContain('expired (the agent key that asked for it was revoked)')
      expect(run.stdout).not.toContain('not approved in time')
      expect(run.stderr).toContain('there is nothing to approve')
      expect(writes()).toEqual([])
      expect(await bannedAt(userId)).toBeNull()
    })

    test('revoked while the question is open: refused by the server, and said as that', async () => {
      const userId = await user()
      const id = await propose(userId)
      const run = await tula(
        ['approve', id],
        {
          isTTY: true,
          prompt: async () => {
            await revokeAgentKey()
            return 'yes'
          },
        },
        undefined
      )
      expect(run.code).toBe(1)
      expect(run.stderr).toContain('The agent key that asked for this was revoked')
      expect(run.stderr).toContain('Nothing was changed')
      expect(await bannedAt(userId)).toBeNull()
    })
  })

  // The ban is written before the user's sessions are ended. "Not carried out" would be
  // false, and would leave an operator believing a banned user is not banned.
  test('a ban whose sessions could not be ended is said as that: banned, sessions to end by hand', async () => {
    const userId = await user()
    const id = await propose(userId)
    const sessions = spyOn(deps.sessions, 'listActiveByUser').mockRejectedValueOnce(
      new Error('down')
    )
    let run: Run
    try {
      run = await tula(['approve', id], {}, 'yes')
    } finally {
      sessions.mockRestore()
    }
    expect(run.code).toBe(1)
    expect(run.stdout).not.toContain('Approved and carried out')
    expect(run.stderr).not.toContain('was not carried out')
    expect(run.stderr).toContain('The user is banned')
    expect(run.stderr).toContain('ending their sessions failed')
    expect(run.stderr).toContain(`DELETE /v1/admin/users/${userId}/sessions`)
    expect(run.stderr).toContain('The proposal is spent')
    expect(await bannedAt(userId)).not.toBeNull()
  })

  test('an operation that failed with nothing changed says to check the user, not that it is safe', async () => {
    const userId = await user()
    const id = await propose(userId)
    const setBanned = spyOn(deps.users, 'setBanned').mockRejectedValueOnce(new Error('down'))
    let run: Run
    try {
      run = await tula(['approve', id], {}, 'yes')
    } finally {
      setBanned.mockRestore()
    }
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('the operation failed on the server')
    expect(run.stderr).toContain('The proposal is spent')
    expect(await bannedAt(userId)).toBeNull()
  })

  test('an agent key cannot approve: refused before any request', async () => {
    const userId = await user()
    const id = await propose(userId)
    const run = await tula(
      ['approve', id],
      { env: { TULA_API_URL: BASE_URL, TULA_SECRET_KEY: AGENT_KEY } },
      'yes'
    )
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('an agent key cannot approve')
    expect(wire).toEqual([])
    expect(await bannedAt(userId)).toBeNull()
  })

  test('another environment’s proposal, and one that does not exist, are the same "not found"', async () => {
    const run = await tula(['approve', NO_SUCH], {}, 'yes')
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('resource.not_found')
    expect(writes()).toEqual([])
  })

  test.each([
    ['no id', []],
    ['something that is not an id', ['../../users']],
    ['an id with a line break', [`${NO_SUCH}\nx`]],
  ])('%s is refused before any request, and not repeated', async (_name, rest) => {
    const run = await tula(['approve', ...rest], {}, 'yes')
    expect(run.code).toBe(1)
    expect(wire).toEqual([])
    expect(run.stderr).not.toContain('../../users')
  })

  test('there is no option that takes a key, and a key on standard input is refused: the question needs it', async () => {
    const taken = await tula(['approve', NO_SUCH, '--secret-key', SECRET_KEY], {}, 'yes')
    expect(taken.code).toBe(1)
    expect(wire).toEqual([])
    let read = 0
    const stdin = {
      readStdin: async () => {
        read += 1
        return SECRET_KEY
      },
    }
    for (const answer of [undefined, 'yes']) {
      const piped = await tula(['approve', NO_SUCH, '--secret-key-file', '-'], stdin, answer)
      expect(piped.code).toBe(1)
      expect(piped.stderr).toContain(
        '--secret-key-file - takes the key from standard input, which is where the question of ' +
          'tula approve is answered'
      )
      expect(piped.questions).toEqual([])
    }
    expect(read).toBe(0)
    expect(wire).toEqual([])
  })

  test('text from the server is printed so that it cannot repaint the terminal', async () => {
    const userId = await user('eve@northline.app', 'Eve\u001b[2J\u{202E}approved')
    const id = await propose(userId)
    const run = await tula(['approve', id], {}, 'no')
    expect(run.stdout).not.toContain('\u001b')
    expect(run.stdout).not.toContain('\u{202E}')
    expect(run.questions[0]).not.toContain('\u001b')
    expect(run.stdout).toContain('eve@northline.app')
  })

  test('a user who is already banned is said to be, before the question', async () => {
    const userId = await user()
    const id = await propose(userId)
    await api(SECRET_KEY, 'POST', `/v1/admin/users/${userId}/ban`)
    const run = await tula(['approve', id], {}, 'no')
    expect(run.stdout).toContain('already banned')
  })

  test('--json prints the proposal as it stands after the run, and nothing else on standard output', async () => {
    const userId = await user()
    const id = await propose(userId)
    const run = await tula(['approve', id, '--json'], {}, 'yes')
    expect(run.code).toBe(0)
    const printed = JSON.parse(run.stdout) as Record<string, unknown>
    expect(printed).toMatchObject({
      id,
      operation: 'ban_user',
      target: { type: 'user', id: userId },
      status: 'executed',
      approvedBy: { type: 'admin' },
      failureReason: null,
    })
    expect(run.stderr).toContain('Approved and carried out.')
  })

  test('the help says who approves and with what', async () => {
    const run = await tula(['approve', '--help'])
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('An agent key cannot approve')
    expect(wire).toEqual([])
  })
})

// The other reversible operations (ADR 0053): what a person is shown and asked for each,
// and that what was asked about is what happens.
describe('tula approve: lifting a ban, ending a session, switching a provider off', () => {
  const tenant = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }

  async function ask(operation: string, target: { type: string; id: string }, key = AGENT_KEY) {
    const proposed = await api(key, 'POST', '/v1/agent/proposals', { operation, target })
    expect(proposed.status).toBe(201)
    return String(proposed.body.id)
  }

  async function configure(provider: string, body: Record<string, unknown> = {}) {
    const saved = await api(SECRET_KEY, 'PUT', `/v1/admin/oauth-providers/${provider}`, {
      clientId: `${provider}-client-id`,
      clientSecret: 'a-client-secret-never-printed',
      ...body,
    })
    expect(saved.status).toBe(200)
  }

  async function enabled(provider: string): Promise<unknown> {
    const listed = await api(SECRET_KEY, 'GET', '/v1/admin/oauth-providers')
    return (listed.body.data as { provider: string; enabled: boolean }[]).find(
      (one) => one.provider === provider
    )?.enabled
  }

  async function saveSettings(settings: Record<string, unknown>, key = SECRET_KEY) {
    const current = await api(key, 'GET', '/v1/admin/settings')
    const response = await app.request('/v1/admin/settings', {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'if-match': `"${String(current.body.revision)}"`,
      },
      body: JSON.stringify(settings),
    })
    expect(response.status).toBe(200)
  }

  test('lifting a ban: the user is shown as banned, the question says what happens, and the ban is lifted', async () => {
    const userId = await user()
    expect((await api(SECRET_KEY, 'POST', `/v1/admin/users/${userId}/ban`)).status).toBe(200)
    const id = await ask('unban_user', { type: 'user', id: userId })
    const run = await tula(['approve', id], {}, 'yes')
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('Operation      unban_user')
    expect(run.stdout).toContain(`user ${userId} (maya@northline.app, Maya; already banned)`)
    expect(run.questions[0]).toContain('The user’s ban is lifted at once')
    expect(run.stdout).toContain('Approved and carried out.')
    expect(await bannedAt(userId)).toBeNull()
    expect(JSON.parse(wire.find((r) => r.line.endsWith('/approve'))?.body ?? '{}')).toEqual({
      operation: 'unban_user',
      target: { type: 'user', id: userId },
    })
  })

  test('ending a session: one session, named by its id, and the user’s other session lives on', async () => {
    const userId = await user()
    const open = { userId, client: 'ios', userAgent: null, ipAddress: null } as const
    await Sessions.create(deps, tenant, open)
    await Sessions.create(deps, tenant, open)
    const sessions = await deps.sessions.listActiveByUser(
      tenant.environmentId,
      userId,
      deps.clock.now()
    )
    const [first, second] = sessions.map((session) => session.id) as [string, string]
    const id = await ask('end_session', { type: 'session', id: first })
    const run = await tula(['approve', id], {}, 'yes')
    expect(run.code).toBe(0)
    expect(run.stdout).toContain(`About          session ${first}`)
    expect(run.questions[0]).toContain('That one session is ended at once')
    expect(run.questions[0]).toContain(`session ${first}`)
    const left = await deps.sessions.listActiveByUser(
      tenant.environmentId,
      userId,
      deps.clock.now()
    )
    expect(left.map((session) => session.id)).toEqual([second])
    expect(writes()).toEqual([`POST /v1/admin/proposals/${id}/approve`])
  })

  // Whoever types yes has to be able to check what an agent said of a session: an id
  // alone says nothing, and "my stale session" may be the owner's live one.
  describe('a session is shown with whose it is and whether it is still live', () => {
    async function sessionOf(userId: string, client: 'ios' | 'web' = 'ios'): Promise<string> {
      const made = await Sessions.create(deps, tenant, {
        userId,
        client,
        userAgent: 'Hostile\u001b[2J agent',
        ipAddress: '203.0.113.7',
      })
      return made.sessionId
    }

    test('a live session of a user: their address and name, the client kind, when, and that it is live', async () => {
      const userId = await user('ada@northline.app', 'Ada')
      const other = await user('grace@northline.app', 'Grace')
      await sessionOf(other, 'web')
      const session = await sessionOf(userId)
      const signedIn = deps.clock.now().toISOString()
      const id = await ask('end_session', { type: 'session', id: session })
      wire = []
      const run = await tula(['approve', id], {}, 'no')
      const about = `session ${session} (of user ${userId}: ada@northline.app, Ada; ios client, signed in ${signedIn}; live now)`
      expect(run.stdout).toContain(`About          ${about}`)
      expect(run.questions[0]).toContain(`Approve end_session for ${about} at ${BASE_URL}?`)
      expect(run.stdout + run.questions[0]).not.toContain('grace@northline.app')
      // Read with the operator's key, by reads alone: the proposal, the session, its user.
      expect(wire.map((request) => request.line)).toEqual([
        `GET /v1/admin/proposals/${id}`,
        `GET /v1/admin/sessions/${session}`,
        `GET /v1/admin/users/${userId}`,
      ])
      // Nothing of the device beyond its kind: no user agent, no IP address.
      expect(run.stdout + run.stderr + run.questions[0]).not.toContain('203.0.113.7')
      expect(run.stdout + run.stderr + run.questions[0]).not.toContain('Hostile')
    })

    test('a session that has ended is said as already ended, before the question', async () => {
      const userId = await user()
      const session = await sessionOf(userId)
      const id = await ask('end_session', { type: 'session', id: session })
      expect(
        (await api(SECRET_KEY, 'DELETE', `/v1/admin/users/${userId}/sessions/${session}`)).status
      ).toBe(204)
      const run = await tula(['approve', id], {}, 'no')
      expect(run.questions[0]).toContain(
        `session ${session} (of user ${userId}: maya@northline.app, Maya;`
      )
      expect(run.questions[0]).toContain('; already ended)')
      expect(run.questions[0]).not.toContain('live now')
      expect(run.stdout).toContain('; already ended)')
    })

    test('a session that cannot be read is said in fixed words, with the bare id: nothing is guessed', async () => {
      const userId = await user()
      const session = await sessionOf(userId)
      const id = await ask('end_session', { type: 'session', id: session })
      const broken = spyOn(deps.sessions, 'findById').mockRejectedValue(
        new Error('connection to 10.0.0.5 lost: canary-of-the-store')
      )
      let run: Run
      try {
        run = await tula(['approve', id], {}, 'no')
      } finally {
        broken.mockRestore()
      }
      expect(run.code).toBe(1)
      expect(run.questions[0]).toContain(`session ${session} (could not be read)`)
      expect(run.stdout).toContain(`About          session ${session} (could not be read)`)
      expect(run.stdout + run.stderr + run.questions[0]).not.toContain('maya@northline.app')
      expect(run.stdout + run.stderr + run.questions[0]).not.toContain('canary-of-the-store')
      expect(run.stdout + run.stderr + run.questions[0]).not.toContain('live now')
    })

    test('a session the environment does not have is said as no such session', async () => {
      const userId = await user()
      const session = await sessionOf(userId)
      const id = await ask('end_session', { type: 'session', id: session })
      const gone = spyOn(deps.sessions, 'findById').mockResolvedValue(null)
      let run: Run
      try {
        run = await tula(['approve', id], {}, 'no')
      } finally {
        gone.mockRestore()
      }
      expect(run.questions[0]).toContain(`session ${session} (no such session now)`)
      expect(run.stdout + run.questions[0]).not.toContain('maya@northline.app')
    })

    test('a session whose user cannot be read says so, and still says whether it is live', async () => {
      const userId = await user()
      const session = await sessionOf(userId)
      const id = await ask('end_session', { type: 'session', id: session })
      const broken = spyOn(deps.users, 'findById').mockRejectedValue(
        new Error('canary-of-the-store')
      )
      let run: Run
      try {
        run = await tula(['approve', id], {}, 'no')
      } finally {
        broken.mockRestore()
      }
      expect(run.questions[0]).toContain(
        `session ${session} (of user ${userId}: the user could not be read; ios client,`
      )
      expect(run.questions[0]).toContain('; live now)')
      expect(run.stdout + run.stderr + run.questions[0]).not.toContain('canary-of-the-store')
    })
  })

  // What was shown can change before the answer is typed. The approval is then carried
  // out on a target that is already so: said as that, never as a change that was made.
  describe('a target that became so between the showing and the approval', () => {
    /** Answers yes after `meanwhile` ran: what happens while the question is open. */
    const during = (meanwhile: () => Promise<void>) => ({
      prompt: async () => {
        await meanwhile()
        return 'yes'
      },
    })

    test('a session ended meanwhile: carried out, already ended, nothing changed', async () => {
      const userId = await user()
      const made = await Sessions.create(deps, tenant, {
        userId,
        client: 'ios',
        userAgent: null,
        ipAddress: null,
      })
      const id = await ask('end_session', { type: 'session', id: made.sessionId })
      const run = await tula(
        ['approve', id],
        during(async () => {
          const path = `/v1/admin/users/${userId}/sessions/${made.sessionId}`
          expect((await api(SECRET_KEY, 'DELETE', path)).status).toBe(204)
        }),
        'yes'
      )
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('; live now)')
      expect(run.stdout).toContain(
        'Approved and carried out; the session had already ended, so nothing changed. The proposal is spent.'
      )
      expect(run.stdout).not.toContain('Approved and carried out. ')
      expect(run.stdout).not.toContain('That one session is ended at once')
    })

    test('a ban lifted meanwhile, and a provider switched off meanwhile: the same', async () => {
      const userId = await user()
      expect((await api(SECRET_KEY, 'POST', `/v1/admin/users/${userId}/ban`)).status).toBe(200)
      const unban = await ask('unban_user', { type: 'user', id: userId })
      const lifted = await tula(
        ['approve', unban],
        during(async () => {
          const res = await api(SECRET_KEY, 'POST', `/v1/admin/users/${userId}/unban`)
          expect(res.status).toBe(200)
        }),
        'yes'
      )
      expect(lifted.code).toBe(0)
      expect(lifted.stdout).toContain(
        'Approved and carried out; the user was not banned, so nothing changed. The proposal is spent.'
      )
      expect(lifted.stdout).not.toContain('The user’s ban is lifted at once')

      await configure('google')
      await configure('github')
      const off = await ask('disable_oauth_provider', { type: 'oauth_provider', id: 'google' })
      const switched = await tula(
        ['approve', off],
        during(() => configure('google', { enabled: false })),
        'yes'
      )
      expect(switched.code).toBe(0)
      expect(switched.stdout).toContain(
        'Approved and carried out; the provider was already off, so nothing changed. The proposal is spent.'
      )
      expect(switched.stdout).not.toContain('Sign-in with that provider is switched off at once')
    })

    test('--json says it with the field, and a change that was made says changed: true', async () => {
      const userId = await user()
      expect((await api(SECRET_KEY, 'POST', `/v1/admin/users/${userId}/ban`)).status).toBe(200)
      const first = await ask('unban_user', { type: 'user', id: userId })
      const made = await tula(['approve', first, '--json'], {}, 'yes')
      expect(JSON.parse(made.stdout)).toMatchObject({ status: 'executed', changed: true })
      expect(made.stderr).toContain('Approved and carried out. The user’s ban is lifted at once')
      const second = await ask('unban_user', { type: 'user', id: userId })
      const again = await tula(['approve', second, '--json'], {}, 'yes')
      expect(JSON.parse(again.stdout)).toMatchObject({ status: 'executed', changed: false })
      expect(again.stderr).toContain('so nothing changed')
      expect(again.stderr).not.toContain('Approved and carried out. ')
    })
  })

  test('switching a provider off: shown as it is now, switched off, its credentials kept', async () => {
    await configure('google')
    await configure('github')
    const id = await ask('disable_oauth_provider', { type: 'oauth_provider', id: 'google' })
    const run = await tula(['approve', id], {}, 'yes')
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('About          provider google (on now)')
    expect(run.questions[0]).toContain('Sign-in with that provider is switched off at once')
    expect(run.questions[0]).toContain('provider google')
    expect(await enabled('google')).toBe(false)
    expect(await enabled('github')).toBe(true)
    const stored = await deps.oauthProviders.find(tenant.environmentId, 'google')
    expect(stored?.clientId).toBe('google-client-id')
    expect(run.stdout + run.stderr).not.toContain('a-client-secret-never-printed')
    // The only write is the approval: this command has no call that changes a provider.
    expect(writes()).toEqual([`POST /v1/admin/proposals/${id}/approve`])
  })

  test('a provider that is already off, or gone, is said so before the question', async () => {
    await configure('google')
    await configure('github')
    const id = await ask('disable_oauth_provider', { type: 'oauth_provider', id: 'google' })
    await configure('google', { enabled: false })
    const off = await tula(['approve', id], {}, 'no')
    expect(off.stdout).toContain('provider google (already off)')
    expect((await api(SECRET_KEY, 'DELETE', '/v1/admin/oauth-providers/google')).status).toBe(204)
    const gone = await tula(['approve', id], {}, 'no')
    expect(gone.stdout).toContain('provider google (not configured now)')
    expect(writes()).toEqual([])
  })

  test('switching off the last way to sign in: approved, refused by the server, and said as nothing changed', async () => {
    await configure('google')
    await configure('github')
    await saveSettings({ signIn: { methods: { password: { enabled: false } } } })
    const id = await ask('disable_oauth_provider', { type: 'oauth_provider', id: 'google' })
    // While the proposal waits the other provider goes: Google is the last way in.
    expect((await api(SECRET_KEY, 'DELETE', '/v1/admin/oauth-providers/github')).status).toBe(204)
    const run = await tula(['approve', id], {}, 'yes')
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('would leave the environment with no way to sign in')
    expect(run.stderr).toContain('The provider is still on')
    expect(run.stderr).toContain('The proposal is spent')
    expect(run.stdout).not.toContain('Approved and carried out')
    expect(await enabled('google')).toBe(true)
  })

  test('a session that is gone says the session, not the user', async () => {
    const userId = await user()
    await Sessions.create(deps, tenant, { userId, client: 'ios', userAgent: null, ipAddress: null })
    const [session] = await deps.sessions.listActiveByUser(
      tenant.environmentId,
      userId,
      deps.clock.now()
    )
    const id = await ask('end_session', { type: 'session', id: String(session?.id) })
    const gone = spyOn(deps.sessions, 'findById').mockResolvedValue(null)
    let run: Run
    try {
      run = await tula(['approve', id], {}, 'yes')
    } finally {
      gone.mockRestore()
    }
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('nothing was changed: the session no longer exists')
  })

  describe('in a production environment', () => {
    const PROD_SK = 'tula_sk_live_approvetest0000000000000000000000'
    const PROD_AK = 'tula_ak_live_approvetest0000000000000000000000'
    const production = { TULA_API_URL: BASE_URL, TULA_SECRET_KEY: PROD_SK }

    beforeEach(async () => {
      deps.environments.add({
        id: TEST_TENANT.productionEnvironmentId,
        projectId: TEST_TENANT.projectId,
        kind: 'production',
        createdAt: deps.clock.now(),
      })
      const environmentId = TEST_TENANT.productionEnvironmentId
      await seedApiKey(deps, PROD_SK, { environmentId })
      await seedApiKey(deps, PROD_AK, { environmentId })
    })

    async function productionUser(): Promise<string> {
      const created = await api(PROD_SK, 'POST', '/v1/admin/users', {
        email: 'maya@northline.app',
        password: 'correct horse battery staple',
      })
      return String(created.body.id)
    }

    test('opted in, a proposal is approved like any other', async () => {
      const userId = await productionUser()
      await saveSettings({ agents: { proposalsInProduction: true } }, PROD_SK)
      const id = await ask('ban_user', { type: 'user', id: userId }, PROD_AK)
      const run = await tula(['approve', id], { env: production }, 'yes')
      expect(run.code).toBe(0)
      expect((await api(PROD_SK, 'GET', `/v1/admin/users/${userId}`)).body.bannedAt).not.toBeNull()
    })

    test('opted out while the proposal waited: refused, nothing changed, and said as not spent', async () => {
      const userId = await productionUser()
      await saveSettings({ agents: { proposalsInProduction: true } }, PROD_SK)
      const id = await ask('ban_user', { type: 'user', id: userId }, PROD_AK)
      await saveSettings({ agents: { proposalsInProduction: false } }, PROD_SK)
      const run = await tula(['approve', id], { env: production }, 'yes')
      expect(run.code).toBe(1)
      expect(run.stderr).toContain('This is a production environment')
      expect(run.stderr).toContain('agents.proposalsInProduction')
      expect(run.stderr).toContain('Nothing was changed')
      expect(run.stderr).not.toContain('PROD')
      expect(run.stdout + run.stderr).not.toContain(PROD_SK)
      expect((await api(PROD_SK, 'GET', `/v1/admin/users/${userId}`)).body.bannedAt).toBeNull()
      // Not spent: switched on again within its ten minutes, the same proposal is approved.
      await saveSettings({ agents: { proposalsInProduction: true } }, PROD_SK)
      expect((await tula(['approve', id], { env: production }, 'yes')).code).toBe(0)
    })
  })
})
