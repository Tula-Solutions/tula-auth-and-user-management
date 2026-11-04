import { describe, expect, test } from 'bun:test'
import { ApiError } from '~/api/errors'
import type { SsoConnection, UpdateSsoConnectionRequest } from '~/api/generated/api.gen'
import { fakeSsoConnection } from '~/testing/fake-sso'
import { certificateStanding, isSsoDisabled, ssoMessageFor, weakeningSentences } from './words'

const NOW = Date.parse('2026-10-23T12:00:00.000Z')
const DAY = 86_400_000
const at = (days: number) => new Date(NOW + days * DAY).toISOString()

describe('certificateStanding', () => {
  test.each([
    [31, false, 'ok'],
    [30, false, 'soon'],
    [1, false, 'soon'],
    [0, false, 'expired'],
    [-1, false, 'expired'],
    [90, true, 'expired'],
  ] as const)('ending in %i days, flagged expired %p: %s', (days, expired, standing) => {
    expect(certificateStanding({ notAfter: at(days), expired }, NOW)).toBe(standing)
  })
})

const refused = (code: string) => new ApiError({ status: 409, code, detail: 'x' })

describe('refusals', () => {
  test('the disabled code is recognised and known codes have their own sentence', () => {
    expect(isSsoDisabled(refused('sso.disabled'))).toBe(true)
    expect(isSsoDisabled(refused('sso.name_taken'))).toBe(false)
    expect(ssoMessageFor(refused('sso.name_taken'))).toContain('already has a connection')
    expect(ssoMessageFor(refused('sso.connection_in_use'))).toContain('Disable it')
  })
})

describe('weakeningSentences mirrors the server', () => {
  const draft = fakeSsoConnection({ status: 'draft' })
  const active = fakeSsoConnection({ status: 'active' })

  const table: [string, SsoConnection, UpdateSsoConnectionRequest, number][] = [
    ['a rename of a draft', draft, { name: 'New' }, 0],
    ['a rename of an active connection', active, { name: 'New' }, 0],
    ['activation', draft, { status: 'active' }, 1],
    ['disabling', active, { status: 'disabled' }, 0],
    ['a new domain on a draft', draft, { domains: ['acme.com'] }, 0],
    ['a new domain on an active connection', active, { domains: ['acme.com'] }, 1],
    ['a new secret on an active connection', active, { clientSecret: 'x' }, 1],
    ['enforcement on', draft, { enforced: true }, 0],
    ['enforcement off, was on', fakeSsoConnection({ enforced: true }), { enforced: false }, 1],
    ['enforcement off, was off', draft, { enforced: false }, 0],
    ['trusting the IdP for MFA', draft, { trustIdpMfa: true }, 1],
    ['trusting it again', fakeSsoConnection({ trustIdpMfa: true }), { trustIdpMfa: true }, 0],
    ['no longer trusting it', fakeSsoConnection({ trustIdpMfa: true }), { trustIdpMfa: false }, 0],
    ['a break-glass role', draft, { breakGlassRole: 'admin' }, 1],
    [
      'the same break-glass role',
      fakeSsoConnection({ breakGlassRole: 'admin' }),
      { breakGlassRole: 'admin' },
      0,
    ],
    [
      'clearing the break-glass role',
      fakeSsoConnection({ breakGlassRole: 'admin' }),
      { breakGlassRole: null },
      0,
    ],
  ]
  test.each(table)('%s asks %i question(s)', (_name, current, changes, count) => {
    expect(weakeningSentences(current, changes)).toHaveLength(count)
  })

  test('the break-glass sentence says password sign-in, never more', () => {
    const [sentence] = weakeningSentences(draft, { breakGlassRole: 'admin' })
    expect(sentence).toContain('keeps password sign-in')
  })

  test('one change with three weakenings asks all three', () => {
    const current = fakeSsoConnection({ enforced: true })
    expect(
      weakeningSentences(current, { enforced: false, trustIdpMfa: true, breakGlassRole: 'owner' })
    ).toHaveLength(3)
  })
})
