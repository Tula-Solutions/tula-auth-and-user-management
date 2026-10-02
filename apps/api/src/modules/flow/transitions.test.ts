import { describe, expect, test } from 'bun:test'
import type { FlowKind, FlowStatus } from '@tula/contract'
import { ServiceException } from '~/exceptions'
import { type FlowEvent, nextStatus } from '~/modules/flow/transitions'

const verifiedPassword: FlowEvent = { type: 'password_verified', emailVerified: true }
const unverifiedPassword: FlowEvent = { type: 'password_verified', emailVerified: false }
const emailVerified: FlowEvent = { type: 'email_verified' }

describe('nextStatus', () => {
  const allowed: [FlowKind, FlowStatus, FlowEvent, FlowStatus][] = [
    ['sign_up', 'needs_email_verification', emailVerified, 'complete'],
    ['sign_in', 'needs_password', verifiedPassword, 'complete'],
    ['sign_in', 'needs_password', unverifiedPassword, 'needs_email_verification'],
    ['sign_in', 'needs_email_verification', emailVerified, 'complete'],
  ]
  test.each(allowed)('%s: %s + %o → %s', (kind, status, event, expected) => {
    expect(nextStatus(kind, status, event)).toBe(expected)
  })

  const refused: [FlowKind, FlowStatus, FlowEvent][] = [
    // Sign-up never has a password step: the password is set when the attempt starts.
    ['sign_up', 'needs_email_verification', verifiedPassword],
    ['sign_up', 'needs_password', verifiedPassword],
    ['sign_up', 'needs_password', emailVerified],
    // A sign-in can't skip the password by "verifying an email" first.
    ['sign_in', 'needs_password', emailVerified],
    ['sign_in', 'needs_email_verification', verifiedPassword],
    // Nothing follows a completed attempt.
    ['sign_in', 'complete', verifiedPassword],
    ['sign_in', 'complete', emailVerified],
    ['sign_up', 'complete', emailVerified],
    // Steps Phase 0 does not issue.
    ['sign_in', 'needs_identifier', verifiedPassword],
    ['sign_in', 'needs_second_factor', emailVerified],
  ]
  test.each(refused)('%s: %s + %o is refused', (kind, status, event) => {
    let thrown: unknown
    try {
      nextStatus(kind, status, event)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ServiceException)
    expect((thrown as ServiceException).code).toBe('flow.invalid_step')
    expect((thrown as ServiceException).status).toBe(409)
  })
})
