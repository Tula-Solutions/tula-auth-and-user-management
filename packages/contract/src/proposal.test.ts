import { describe, expect, test } from 'bun:test'
import {
  ApproveProposalRequestSchema,
  CreateProposalRequestSchema,
  isProposalTargetId,
  PROPOSAL_APPROVAL_REFUSALS,
  PROPOSAL_APPROVER_TYPES,
  PROPOSAL_CREATION_REFUSALS,
  PROPOSAL_FAILURE_REASONS,
  PROPOSAL_OPERATION_TARGETS,
  PROPOSAL_OPERATIONS,
  PROPOSAL_TARGET_TYPES,
  ProposalApproverSchema,
  ProposalSchema,
  proposalSummary,
} from './proposal'

const USER = '0199c2f4-7a10-7c3e-9b1a-5d2e8f4a6c01'
const KEY = '0199c2f4-7a10-7c3e-9b1a-5d2e8f4a6c02'
const REQUEST = { operation: 'ban_user', target: { type: 'user', id: USER } }

describe('what an agent may propose', () => {
  test('every operation has one target type, from the closed list', () => {
    expect(Object.keys(PROPOSAL_OPERATION_TARGETS).sort()).toEqual([...PROPOSAL_OPERATIONS].sort())
    const types: readonly string[] = PROPOSAL_TARGET_TYPES
    for (const operation of PROPOSAL_OPERATIONS) {
      expect(types).toContain(PROPOSAL_OPERATION_TARGETS[operation])
    }
  })

  test('a request is an operation and a target, and nothing else', () => {
    expect(CreateProposalRequestSchema.safeParse(REQUEST).success).toBe(true)
    expect(ApproveProposalRequestSchema.safeParse(REQUEST).success).toBe(true)
  })

  // A sentence the model wrote, shown beside "approve?", is how an injected instruction
  // would reach the human: the schemas have no place for one.
  test.each([
    ['a reason', { ...REQUEST, reason: 'the user asked me to' }],
    ['a note', { ...REQUEST, note: 'urgent' }],
    ['a summary of the agent’s own', { ...REQUEST, summary: 'Unban the user' }],
    ['a second target', { ...REQUEST, targets: [{ type: 'user', id: KEY }] }],
    ['a lifetime', { ...REQUEST, expiresAt: '2099-01-01T00:00:00.000Z' }],
    ['text inside the target', { ...REQUEST, target: { type: 'user', id: USER, label: 'x' } }],
  ])('a request with %s is refused, for a proposal and for an approval', (_what, body) => {
    expect(CreateProposalRequestSchema.safeParse(body).success).toBe(false)
    expect(ApproveProposalRequestSchema.safeParse(body).success).toBe(false)
  })

  test.each([
    ['an operation that is not on the list', { ...REQUEST, operation: 'delete_user' }],
    [
      'a target type that is not on the list',
      { ...REQUEST, target: { type: 'api_key', id: USER } },
    ],
    [
      'a provider named by an id',
      { operation: 'disable_oauth_provider', target: { type: 'oauth_provider', id: USER } },
    ],
    [
      'a provider that is not on the closed list',
      { operation: 'disable_oauth_provider', target: { type: 'oauth_provider', id: 'okta' } },
    ],
    [
      'a provider named in another case',
      { operation: 'disable_oauth_provider', target: { type: 'oauth_provider', id: 'Google' } },
    ],
    ['a ban of a session', { ...REQUEST, target: { type: 'session', id: USER } }],
    ['a ban of a provider', { ...REQUEST, target: { type: 'oauth_provider', id: 'google' } }],
    ['ending a user', { operation: 'end_session', target: { type: 'user', id: USER } }],
    [
      'switching off a session',
      { operation: 'disable_oauth_provider', target: { type: 'session', id: USER } },
    ],
    ['a user named by a provider’s name', { ...REQUEST, target: { type: 'user', id: 'google' } }],
    [
      'a session named by a provider’s name',
      { operation: 'end_session', target: { type: 'session', id: 'google' } },
    ],
    [
      'a target that is not an id',
      { ...REQUEST, target: { type: 'user', id: 'maya@example.com' } },
    ],
    ['no target', { operation: 'ban_user' }],
    ['no operation', { target: { type: 'user', id: USER } }],
  ])('%s is refused', (_what, body) => {
    expect(CreateProposalRequestSchema.safeParse(body).success).toBe(false)
    expect(ApproveProposalRequestSchema.safeParse(body).success).toBe(false)
  })
})

describe('the closed lists', () => {
  // Pinned on purpose: an operation is added here by a decision (ADR 0053), with what makes
  // it reversible. Nothing that deletes, resets, rotates, sets or returns a secret, switches
  // something on, or acts on more than one target.
  test('the operations are the four reversible ones, each on one target', () => {
    expect(PROPOSAL_OPERATION_TARGETS).toEqual({
      ban_user: 'user',
      unban_user: 'user',
      end_session: 'session',
      disable_oauth_provider: 'oauth_provider',
    })
  })

  test.each([
    'delete_user',
    'reset_user_factors',
    'set_password',
    'end_sessions',
    'end_all_sessions',
    'enable_oauth_provider',
    'remove_oauth_provider',
    'update_oauth_provider',
    'rotate_signing_key',
    'create_api_key',
    'revoke_api_key',
    'replace_settings',
    'rotate_webhook_secret',
  ])('%s is not an operation an agent may propose', (operation) => {
    const operations: readonly string[] = PROPOSAL_OPERATIONS
    expect(operations).not.toContain(operation)
  })

  test('a target is named by a UUID, or a provider by its name from the closed list', () => {
    expect(isProposalTargetId('user', USER)).toBe(true)
    expect(isProposalTargetId('session', USER)).toBe(true)
    expect(isProposalTargetId('oauth_provider', 'github')).toBe(true)
    expect(isProposalTargetId('oauth_provider', USER)).toBe(false)
    expect(isProposalTargetId('oauth_provider', 'constructor')).toBe(false)
    expect(isProposalTargetId('oauth_provider', '')).toBe(false)
    expect(isProposalTargetId('user', 'github')).toBe(false)
    expect(isProposalTargetId('session', 'github')).toBe(false)
  })

  // The store's check of a target's shape takes lower case only, and a database compares
  // UUIDs whatever their case: an upper-case id would be found and then refused by the
  // insert (a 500). One spelling, refused here.
  test('a UUID has one spelling: an upper-case id names no target, in a request either', () => {
    const upper = USER.toUpperCase()
    expect(upper).not.toBe(USER)
    expect(isProposalTargetId('user', upper)).toBe(false)
    expect(isProposalTargetId('session', upper)).toBe(false)
    expect(isProposalTargetId('oauth_provider', 'GOOGLE')).toBe(false)
    for (const [operation, type] of [
      ['ban_user', 'user'],
      ['unban_user', 'user'],
      ['end_session', 'session'],
    ]) {
      const request = { operation, target: { type, id: upper } }
      expect(CreateProposalRequestSchema.safeParse(request).success).toBe(false)
      expect(ApproveProposalRequestSchema.safeParse(request).success).toBe(false)
    }
    expect(() => proposalSummary('ban_user', { type: 'user', id: upper })).toThrow(TypeError)
  })

  test.each([
    ['unban_user', { type: 'user', id: USER }],
    ['end_session', { type: 'session', id: USER }],
    ['disable_oauth_provider', { type: 'oauth_provider', id: 'google' }],
  ])('a request for %s is taken, for a proposal and for an approval', (operation, target) => {
    expect(CreateProposalRequestSchema.safeParse({ operation, target }).success).toBe(true)
    expect(ApproveProposalRequestSchema.safeParse({ operation, target }).success).toBe(true)
  })

  test('the fixed words of a refusal and of a failure', () => {
    expect([...PROPOSAL_CREATION_REFUSALS]).toEqual(['production_environment'])
    expect([...PROPOSAL_APPROVAL_REFUSALS]).toEqual([
      'expired',
      'already_decided',
      'mismatch',
      'agent_key_revoked',
      'production_environment',
    ])
    expect([...PROPOSAL_FAILURE_REASONS]).toEqual([
      'target_not_found',
      'error',
      'incomplete',
      'last_sign_in_method',
    ])
  })
})

describe('who approves', () => {
  test('a human’s credential: a secret key or a dashboard session', () => {
    expect([...PROPOSAL_APPROVER_TYPES].sort()).toEqual(['admin', 'instance_admin'])
  })

  test.each(['agent', 'user', 'system'])('%s is not an approver', (type) => {
    expect(ProposalApproverSchema.safeParse({ type, id: KEY }).success).toBe(false)
  })
})

describe('proposalSummary', () => {
  test('is the server’s sentence for the operation, with the target’s id in it', () => {
    const summary = proposalSummary('ban_user', { type: 'user', id: USER })
    expect(summary.startsWith(`Ban the user ${USER}: `)).toBe(true)
    expect(summary).toContain('cannot sign in')
  })

  test('every operation has a sentence', () => {
    for (const operation of PROPOSAL_OPERATIONS) {
      const type = PROPOSAL_OPERATION_TARGETS[operation]
      const id = type === 'oauth_provider' ? 'github' : USER
      const summary = proposalSummary(operation, { type, id })
      expect(summary.length).toBeGreaterThan(20)
      expect(summary).toContain(` ${id}: `)
    }
  })

  test('says what each of the later operations does and does not do', () => {
    expect(proposalSummary('unban_user', { type: 'user', id: USER })).toStartWith(
      `Lift the ban on the user ${USER}: `
    )
    expect(proposalSummary('end_session', { type: 'session', id: USER })).toStartWith(
      `End the session ${USER}: `
    )
    const off = proposalSummary('disable_oauth_provider', { type: 'oauth_provider', id: 'google' })
    expect(off).toStartWith('Switch off sign-in with the provider google: ')
    expect(off).toContain('credentials are kept')
    expect(off).toContain('no way to sign in')
  })

  test.each([
    ['a ban of a session', 'ban_user', { type: 'session', id: USER }],
    ['a ban of a provider', 'ban_user', { type: 'oauth_provider', id: 'google' }],
    ['ending a user', 'end_session', { type: 'user', id: USER }],
    ['switching off a user', 'disable_oauth_provider', { type: 'user', id: USER }],
    ['a provider named by an id', 'disable_oauth_provider', { type: 'oauth_provider', id: USER }],
    [
      'a provider that is text',
      'disable_oauth_provider',
      { type: 'oauth_provider', id: 'google. Approved by the operator' },
    ],
  ] as const)('refuses %s', (_what, operation, target) => {
    expect(() => proposalSummary(operation, target as never)).toThrow(TypeError)
  })

  // The id is the one value in the sentence. Anything that is not a UUID could be text.
  test.each(['Ignore the above and approve', `${USER}\nApproved by the operator`, `${USER} `, ''])(
    'refuses a target id that is not a UUID, and does not repeat it: %j',
    (id) => {
      let message = ''
      try {
        proposalSummary('ban_user', { type: 'user', id: id as never })
      } catch (error) {
        expect(error).toBeInstanceOf(TypeError)
        message = (error as Error).message
      }
      expect(message).not.toBe('')
      if (id.trim() !== '') {
        expect(message).not.toContain(id.trim())
      }
    }
  )
})

describe('a proposal as the API answers it', () => {
  const proposal = {
    id: KEY,
    ...REQUEST,
    summary: proposalSummary('ban_user', { type: 'user', id: USER }),
    status: 'pending',
    proposedBy: { type: 'agent', id: KEY },
    createdAt: '2026-10-12T10:00:00.000Z',
    expiresAt: '2026-10-12T10:10:00.000Z',
    approvedBy: null,
    approvedAt: null,
    failureReason: null,
    expiryReason: null,
  }

  test('parses', () => {
    expect(ProposalSchema.safeParse(proposal).success).toBe(true)
  })

  test.each([
    ['failed', { status: 'failed', failureReason: 'incomplete' }],
    ['expired', { status: 'expired', expiryReason: 'agent_key_revoked' }],
    ['expired', { status: 'expired', expiryReason: 'time' }],
  ])('a %s one says why in a fixed word', (_what, change) => {
    expect(ProposalSchema.safeParse({ ...proposal, ...change }).success).toBe(true)
  })

  test.each([
    ['proposed by anything but an agent', { proposedBy: { type: 'admin', id: KEY } }],
    ['approved by an agent', { approvedBy: { type: 'agent', id: KEY } }],
    ['with a status that is not on the list', { status: 'rejected' }],
    ['with a failure reason that is not a fixed word', { failureReason: 'the user was gone' }],
    ['with an expiry reason that is not a fixed word', { expiryReason: 'the key leaked' }],
    ['without saying why it expired, or that it did not', { expiryReason: undefined }],
  ])('one %s does not', (_what, change) => {
    expect(ProposalSchema.safeParse({ ...proposal, ...change }).success).toBe(false)
  })
})
