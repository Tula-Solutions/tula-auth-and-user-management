import { afterEach, describe, expect, test } from 'bun:test'
import {
  AdminSessionSchema,
  PROPOSAL_APPROVAL_REFUSALS,
  ProposalListSchema,
  ProposalSchema,
} from '@tula-tech/contract'
import { type FakeApi, fakeProposal, IDS, installFakeApi } from './fake-api'

// The fake's proposal routes answer as the API does where the screen can tell the
// difference (`apps/api/src/modules/proposal`: the contract for the shapes, `service.ts`
// for what an approval is refused for and in which order). These tests hold the fake to
// what was read there.

let api: FakeApi | undefined

afterEach(() => {
  api?.restore()
  api = undefined
})

function signedIn(): FakeApi {
  api = installFakeApi()
  api.state.signedIn = true
  return api
}

const ROOT = '/v1/admin/proposals'
const BAN = { operation: 'ban_user', target: { type: 'user', id: IDS.user } }

async function call(
  method: string,
  path: string,
  body?: unknown,
  environment: string = IDS.development
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://localhost${path}`, {
    method,
    headers: {
      'x-tula-dashboard': '1',
      'x-tula-environment': environment,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, body: text === '' ? {} : JSON.parse(text) }
}

function reason(answer: { body: Record<string, unknown> }): unknown {
  return (answer.body.params as { reason?: unknown } | undefined)?.reason
}

describe('the shapes are the contract’s', () => {
  test('a list, one proposal, an approval’s answer and the session read all parse', async () => {
    const fake = signedIn()
    const waiting = fakeProposal()
    fake.state.proposals.push(waiting, fakeProposal({ keyRevoked: true }))
    const list = await call('GET', ROOT)
    const parsed = ProposalListSchema.parse(list.body)
    // Newest first; a revoked key reads as expired, with its reason.
    expect(parsed.data.map((entry) => [entry.status, entry.expiryReason])).toEqual([
      ['expired', 'agent_key_revoked'],
      ['pending', null],
    ])
    ProposalSchema.parse((await call('GET', `${ROOT}/${waiting.id}`)).body)
    const approved = await call('POST', `${ROOT}/${waiting.id}/approve`, BAN)
    expect(approved.status).toBe(200)
    const decided = ProposalSchema.parse(approved.body)
    expect([decided.status, decided.changed, decided.approvedBy?.type]).toEqual([
      'executed',
      true,
      'instance_admin',
    ])
    // `changed` is the approval's answer alone.
    const later = ProposalSchema.parse((await call('GET', `${ROOT}/${waiting.id}`)).body)
    expect(later.changed).toBeUndefined()
    expect(fake.state.users[0]?.bannedAt).not.toBeNull()
    AdminSessionSchema.parse((await call('GET', `/v1/admin/sessions/${IDS.session}`)).body)
  })

  test('a proposal past its time reads as expired by time', async () => {
    const fake = signedIn()
    fake.state.proposals.push(fakeProposal({ expiresAt: '2026-10-04T12:00:00.000Z' }))
    const list = ProposalListSchema.parse((await call('GET', ROOT)).body)
    expect([list.data[0]?.status, list.data[0]?.expiryReason]).toEqual(['expired', 'time'])
  })
})

describe('what the API refuses, the fake refuses the same way', () => {
  test('an id that is no UUID and a body the contract refuses are 422 before anything is looked up', async () => {
    const fake = signedIn()
    const waiting = fakeProposal()
    fake.state.proposals.push(waiting)
    expect((await call('GET', `${ROOT}/not-an-id`)).status).toBe(422)
    expect((await call('POST', `${ROOT}/not-an-id/approve`, BAN)).status).toBe(422)
    for (const body of [
      {},
      { operation: 'ban_user' },
      { ...BAN, note: 'text an agent wrote' },
      { operation: 'delete_everything', target: BAN.target },
    ]) {
      const answer = await call('POST', `${ROOT}/${waiting.id}/approve`, body)
      expect([answer.status, answer.body.code]).toEqual([422, 'validation.failed'])
    }
    expect(waiting.status).toBe('pending')
  })

  test('a proposal of another environment is not found, to read or to approve', async () => {
    const fake = signedIn()
    const waiting = fakeProposal()
    fake.state.proposals.push(waiting)
    expect((await call('GET', `${ROOT}/${waiting.id}`, undefined, IDS.production)).status).toBe(404)
    expect((await call('POST', `${ROOT}/${waiting.id}/approve`, BAN, IDS.production)).status).toBe(
      404
    )
    expect((await call('GET', ROOT, undefined, IDS.production)).body).toEqual({ data: [] })
    expect(waiting.status).toBe('pending')
  })

  test('an approval is refused with the contract’s reasons, in the service’s order, and changes nothing', async () => {
    const fake = signedIn()
    const other = { operation: 'unban_user', target: BAN.target }
    const spent = fakeProposal({ status: 'executed', keyRevoked: true })
    const revoked = fakeProposal({ keyRevoked: true, expiresAt: '2026-10-04T11:00:00.000Z' })
    const late = fakeProposal({ expiresAt: '2026-10-04T12:00:00.000Z' })
    fake.state.proposals.push(spent, revoked, late)
    const answers = [
      // A mismatch is said before anything else about the proposal.
      await call('POST', `${ROOT}/${revoked.id}/approve`, other),
      // Used once: said before the key's revocation.
      await call('POST', `${ROOT}/${spent.id}/approve`, BAN),
      // Revoked wins over time.
      await call('POST', `${ROOT}/${revoked.id}/approve`, BAN),
      await call('POST', `${ROOT}/${late.id}/approve`, BAN),
    ]
    expect(answers.map((answer) => [answer.status, answer.body.code, reason(answer)])).toEqual([
      [409, 'resource.conflict', 'mismatch'],
      [409, 'resource.conflict', 'already_decided'],
      [409, 'resource.conflict', 'agent_key_revoked'],
      [409, 'resource.conflict', 'expired'],
    ])
    for (const answer of answers) {
      expect(PROPOSAL_APPROVAL_REFUSALS as readonly unknown[]).toContain(reason(answer))
    }
    expect(fake.state.users[0]?.bannedAt).toBeNull()
    expect([revoked.status, late.status]).toEqual(['pending', 'pending'])
  })

  test('an approved proposal is spent whatever its operation came to', async () => {
    const fake = signedIn()
    const gone = fakeProposal({
      target: { type: 'user', id: '00000000-0000-7000-8000-0000000000dd' },
    })
    const twice = fakeProposal()
    const session = fakeProposal({
      operation: 'end_session',
      target: { type: 'session', id: IDS.session },
    })
    fake.state.proposals.push(gone, twice, session)
    fake.state.users[0] = { ...fake.state.users[0], bannedAt: '2026-10-04T10:00:00.000Z' } as never
    const missing = ProposalSchema.parse(
      (await call('POST', `${ROOT}/${gone.id}/approve`, { ...BAN, target: gone.target })).body
    )
    expect([missing.status, missing.failureReason]).toEqual(['failed', 'target_not_found'])
    const already = ProposalSchema.parse(
      (await call('POST', `${ROOT}/${twice.id}/approve`, BAN)).body
    )
    // A ban of a banned user is not "nothing changed" to the API: it ends sessions again.
    expect([already.status, already.changed]).toEqual(['executed', true])
    const ended = ProposalSchema.parse(
      (
        await call('POST', `${ROOT}/${session.id}/approve`, {
          operation: 'end_session',
          target: session.target,
        })
      ).body
    )
    expect([ended.status, ended.changed]).toEqual(['executed', true])
    expect(fake.state.sessions).toHaveLength(0)
    expect((await call('GET', `/v1/admin/sessions/${IDS.session}`)).status).toBe(404)
    // Lifting a ban that is not there is carried out, and says that nothing changed.
    for (const user of fake.state.users as { bannedAt: string | null }[]) {
      user.bannedAt = null
    }
    const lifted = fakeProposal({ operation: 'unban_user' })
    fake.state.proposals.push(lifted)
    const nothing = ProposalSchema.parse(
      (
        await call('POST', `${ROOT}/${lifted.id}/approve`, {
          operation: 'unban_user',
          target: BAN.target,
        })
      ).body
    )
    expect([nothing.status, nothing.changed]).toEqual(['executed', false])
    for (const proposal of [gone, twice, session, lifted]) {
      const again = await call('POST', `${ROOT}/${proposal.id}/approve`, {
        operation: proposal.operation,
        target: proposal.target,
      })
      expect(reason(again)).toBe('already_decided')
    }
  })
})
