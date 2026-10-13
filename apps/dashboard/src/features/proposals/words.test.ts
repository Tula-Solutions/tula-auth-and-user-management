import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PROPOSAL_APPROVAL_REFUSALS,
  PROPOSAL_EXPIRY_REASONS,
  PROPOSAL_FAILURE_REASONS,
  PROPOSAL_OPERATIONS,
  PROPOSAL_STATUSES,
  PROPOSAL_TARGET_TYPES,
} from '@tula/contract'
import { ApiError } from '~/api/errors'
import type { Proposal } from '~/api/generated/api.gen'
import { approvalErrorText } from './proposals-screen'
import {
  approvalOutcome,
  consequenceOf,
  failureText,
  naming,
  proposalState,
  refusalText,
  targetWord,
  timeLeft,
} from './words'

const ID = '00000000-0000-7000-8000-0000000000d1'

function proposal(overrides: Record<string, unknown> = {}): Proposal {
  return {
    id: '00000000-0000-7000-8000-0000000000a1',
    operation: 'ban_user',
    target: { type: 'user', id: ID },
    summary: 'A summary.',
    status: 'pending',
    proposedBy: { type: 'agent', id: '00000000-0000-7000-8000-0000000000f9' },
    createdAt: '2026-10-04T12:00:00.000Z',
    expiresAt: '2026-10-04T12:10:00.000Z',
    approvedBy: null,
    approvedAt: null,
    failureReason: null,
    expiryReason: null,
    ...overrides,
  } as Proposal
}

function conflict(reason: unknown): ApiError {
  return new ApiError({
    status: 409,
    code: 'resource.conflict',
    detail: 'CANARY',
    params: { reason },
  })
}

describe('the contract’s closed lists all have words here', () => {
  test('every operation an agent can propose can be described, and so approved', () => {
    for (const operation of PROPOSAL_OPERATIONS) {
      expect(consequenceOf(operation)).toBeString()
      expect(
        approvalOutcome(proposal({ operation, status: 'executed', changed: false })).text
      ).not.toContain('it was already so')
    }
  })

  test('an operation this version does not know has no consequence, whatever it is called', () => {
    for (const operation of ['delete_user', '', 'constructor', '__proto__', 'toString']) {
      expect(consequenceOf(operation)).toBeNull()
    }
  })

  test('every kind of target has a word; another kind is said as sent, written out', () => {
    expect(PROPOSAL_TARGET_TYPES.map(targetWord)).toEqual(['user', 'session', 'provider'])
    expect(targetWord('constructor')).toBe('constructor')
    expect(targetWord('us\u{202E}er')).toBe('us\\u{202E}er')
  })

  test('every status is said, and only `pending` reads as waiting', () => {
    const kinds = PROPOSAL_STATUSES.map(
      (status) =>
        proposalState(proposal({ status, failureReason: status === 'failed' ? 'error' : null }))
          .kind
    )
    expect(kinds).toEqual([...PROPOSAL_STATUSES])
    for (const status of PROPOSAL_STATUSES.filter((entry) => entry !== 'pending')) {
      expect(proposalState(proposal({ status, failureReason: 'error' })).label).not.toContain(
        'Waiting'
      )
    }
    expect(proposalState(proposal({ status: 'constructor' })).kind).toBe('unknown')
  })

  test('every reason a proposal expired for says that it cannot be approved', () => {
    for (const expiryReason of [...PROPOSAL_EXPIRY_REASONS, 'later_reason', null]) {
      const state = proposalState(proposal({ status: 'expired', expiryReason }))
      expect(state.kind).toBe('expired')
      expect(state.detail).toMatch(/cannot be approved|never carried out: it cannot/)
      expect(state.detail.toLowerCase()).toContain('nothing was changed')
    }
  })

  test('every refusal of an approval has fixed words, and nothing of the server’s', () => {
    for (const reason of PROPOSAL_APPROVAL_REFUSALS) {
      const said = refusalText(conflict(reason))
      expect(said).toBeString()
      expect(said).not.toContain('CANARY')
    }
  })

  test('anything else is not a refusal of the proposal', () => {
    expect(refusalText(conflict('constructor'))).toBeNull()
    expect(refusalText(conflict(7))).toBeNull()
    expect(refusalText(conflict(undefined))).toBeNull()
    expect(
      refusalText(
        new ApiError({
          status: 403,
          code: 'auth.forbidden',
          detail: 'No.',
          params: { reason: 'expired' },
        })
      )
    ).toBeNull()
    expect(refusalText(new Error('boom'))).toBeNull()
  })

  test('every failure reason is said, and none as carried out', () => {
    for (const failureReason of [...PROPOSAL_FAILURE_REASONS, 'later_reason', null]) {
      const failed = proposal({ status: 'failed', failureReason })
      const said = failureText(failed)
      expect(said).toStartWith('Approved, ')
      expect(said).toEndWith('The proposal is spent: it cannot be approved again.')
      expect(approvalOutcome(failed).kind).toBe('problem')
      expect(approvalOutcome(failed).title).not.toBe('Approved and carried out')
    }
    expect(failureText(proposal({ status: 'failed', failureReason: null }))).toContain('(unknown)')
    expect(failureText(proposal({ status: 'failed', failureReason: 'a\u{200B}b' }))).toContain(
      '(a\\u{200B}b)'
    )
  })

  test('`incomplete` never reads as nothing happened', () => {
    for (const operation of PROPOSAL_OPERATIONS) {
      const said = failureText(
        proposal({ operation, status: 'failed', failureReason: 'incomplete' })
      )
      expect(said).toContain('only partly carried out')
      expect(said).not.toContain('nothing was changed')
    }
  })
})

describe('what an approval came to', () => {
  test('carried out, carried out with nothing to change, and an operation of a later server', () => {
    expect(approvalOutcome(proposal({ status: 'executed', changed: true })).kind).toBe('done')
    expect(approvalOutcome(proposal({ status: 'executed' })).kind).toBe('done')
    expect(approvalOutcome(proposal({ status: 'executed', changed: false })).kind).toBe('nothing')
    expect(
      approvalOutcome(proposal({ operation: 'later', status: 'executed', changed: false })).text
    ).toBe(
      'Approved and carried out; it was already so, so nothing changed. The proposal is spent: it cannot be approved again.'
    )
    expect(approvalOutcome(proposal({ operation: 'later', status: 'executed' })).text).toBe(
      'The operation was carried out. The proposal is spent: it cannot be approved again.'
    )
  })

  test('any status but `executed` is a problem: an answer this version cannot read is never a success', () => {
    for (const status of ['approved', 'pending', 'expired', 'later_status']) {
      expect(approvalOutcome(proposal({ status })).kind).toBe('problem')
    }
  })

  test('a failure that may have reached the server says so; a refusal of the request does not', () => {
    const maybe = 'the proposal may have been approved all the same'
    expect(
      approvalErrorText(new ApiError({ status: 0, code: 'network.failed', detail: 'x' }))
    ).toContain(maybe)
    expect(
      approvalErrorText(new ApiError({ status: 500, code: 'internal', detail: 'Failed.' }))
    ).toBe(
      'Failed. If the request reached the server the proposal may have been approved all the same: the list is being read again, check how it stands before trying once more.'
    )
    expect(
      approvalErrorText(new ApiError({ status: 422, code: 'validation.failed', detail: 'Bad.' }))
    ).toBe('Bad.')
  })
})

describe('the time left', () => {
  const expiresAt = '2026-10-04T12:10:00.000Z'
  const at = (iso: string) => Date.parse(iso)

  test.each([
    ['2026-10-04T12:00:00.000Z', false, '10 min 0 s left'],
    ['2026-10-04T12:00:00.001Z', false, '9 min 59 s left'],
    ['2026-10-04T12:09:00.000Z', false, '1 min 0 s left'],
    ['2026-10-04T12:09:00.500Z', false, '59 s left'],
    ['2026-10-04T12:09:59.999Z', false, '0 s left'],
    ['2026-10-04T12:10:00.000Z', true, 'The time is up by this browser’s clock'],
    ['2026-10-05T12:10:00.000Z', true, 'The time is up by this browser’s clock'],
  ])('at %s', (now, up, text) => {
    expect(timeLeft(expiresAt, at(now))).toEqual({ up, text })
  })

  test('a time that cannot be read is up: never a countdown from nothing', () => {
    expect(timeLeft('not a time', 0).up).toBe(true)
  })
})

describe('naming', () => {
  test('what is shown, typed and sent in a control’s name is written out', () => {
    expect(
      naming(proposal({ operation: 'ban\u{200B}_user', target: { type: 'user', id: 'a b' } }))
    ).toEqual({ operation: 'ban\\u{200B}_user', what: 'user', id: 'a\\u{20}b' })
  })
})

describe('the vocabulary', () => {
  // An approval shows that a credential the agent's tools do not hold was used, not that a
  // person looked (ADR 0053): the screen never says more. And it never draws server text
  // as markup.
  const DIRECTORY = import.meta.dir
  const SOURCES = readdirSync(DIRECTORY)
    .filter((file) => /\.tsx?$/.test(file) && !file.endsWith('.test.ts'))
    .map((file) => [file, readFileSync(join(DIRECTORY, file), 'utf8')] as const)

  test('the sources are found', () => {
    expect(SOURCES.map(([file]) => file).sort()).toEqual([
      'proposal-card.tsx',
      'proposals-screen.tsx',
      'queries.ts',
      'target.tsx',
      'words.ts',
    ])
  })

  test.each([
    ['human verified', /human[- ]verified/i],
    ['verified by a', /verified by an? /i],
    ['a person looked', /a person (has )?(looked|reviewed|checked)/i],
    ['markup from a string', /dangerouslySetInnerHTML|innerHTML|srcdoc/],
    ['a live region around the countdown', /aria-live|role=['"]timer['"]/],
  ])('no source says or does “%s”', (_name, pattern) => {
    for (const [file, text] of SOURCES) {
      expect([file, pattern.test(text)]).toEqual([file, false])
    }
  })
})
