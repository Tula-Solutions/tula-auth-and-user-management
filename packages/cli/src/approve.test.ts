import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { AdminFetch } from '@tula/admin'
import { createApp } from '../../../apps/api/src/index'
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
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
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
    expect((await tula(['approve', id, '--yes'])).code).toBe(0)
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

  test('not at a terminal, without --yes: refused before any write', async () => {
    const userId = await user()
    const id = await propose(userId)
    const run = await tula(['approve', id])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('pass --yes')
    expect(writes()).toEqual([])
    expect(await bannedAt(userId)).toBeNull()
  })

  test('a proposal cannot be approved twice: the second run changes nothing and says why', async () => {
    const userId = await user()
    const id = await propose(userId)
    expect((await tula(['approve', id, '--yes'])).code).toBe(0)
    await api(SECRET_KEY, 'POST', `/v1/admin/users/${userId}/unban`)
    wire = []
    const second = await tula(['approve', id, '--yes'])
    expect(second.code).toBe(1)
    expect(second.stderr).toContain('approved and carried out: there is nothing to approve')
    expect(writes()).toEqual([])
    expect(await bannedAt(userId)).toBeNull()
  })

  test('an expired proposal is refused: shown as expired, nothing sent', async () => {
    const userId = await user()
    const id = await propose(userId)
    deps.clock.advance('11m')
    const run = await tula(['approve', id, '--yes'])
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
      const run = await tula(['approve', id, '--yes'])
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
      run = await tula(['approve', id, '--yes'])
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
      run = await tula(['approve', id, '--yes'])
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
    const run = await tula(['approve', id, '--yes'], {
      env: { TULA_API_URL: BASE_URL, TULA_SECRET_KEY: AGENT_KEY },
    })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('an agent key cannot approve')
    expect(wire).toEqual([])
    expect(await bannedAt(userId)).toBeNull()
  })

  test('another environment’s proposal, and one that does not exist, are the same "not found"', async () => {
    const run = await tula(['approve', NO_SUCH, '--yes'])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('resource.not_found')
    expect(writes()).toEqual([])
  })

  test.each([
    ['no id', []],
    ['something that is not an id', ['../../users']],
    ['an id with a line break', [`${NO_SUCH}\nx`]],
  ])('%s is refused before any request, and not repeated', async (_name, rest) => {
    const run = await tula(['approve', ...rest, '--yes'])
    expect(run.code).toBe(1)
    expect(wire).toEqual([])
    expect(run.stderr).not.toContain('../../users')
  })

  test('there is no option that takes a key, and a piped key needs --yes', async () => {
    const taken = await tula(['approve', NO_SUCH, '--secret-key', SECRET_KEY])
    expect(taken.code).toBe(1)
    expect(wire).toEqual([])
    const piped = await tula(['approve', NO_SUCH, '--secret-key-file', '-'])
    expect(piped.code).toBe(1)
    expect(piped.stderr).toContain('pass --yes as well')
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
    const run = await tula(['approve', id, '--yes', '--json'])
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
