import { describe, expect, test } from 'bun:test'
import { ssoWeakenings } from './sso-connection'

const base: Record<string, unknown> = {
  status: 'active',
  enforced: true,
  breakGlassRole: null,
  trustIdpMfa: false,
}

describe('ssoWeakenings', () => {
  const rows: [string, Record<string, unknown>, Record<string, unknown>, string[]][] = [
    ['activating', { status: 'draft' }, { status: 'active' }, ['activate']],
    ['changing an active connection', {}, { issuer: 'https://x' }, ['active_content']],
    ['changing a draft', { status: 'draft' }, { issuer: 'https://x' }, []],
    ['a rename', {}, { name: 'New' }, []],
    ['a field left undefined', {}, { issuer: undefined }, []],
    ['enforcement off', {}, { enforced: false }, ['enforcement_off']],
    ['enforcement already off', { enforced: false }, { enforced: false }, []],
    ['trusting the provider', {}, { trustIdpMfa: true }, ['trust_idp_mfa']],
    ['naming a break-glass role', {}, { breakGlassRole: 'admin' }, ['break_glass_role']],
    ['the same role', { breakGlassRole: 'admin' }, { breakGlassRole: 'admin' }, []],
    ['clearing the role', { breakGlassRole: 'admin' }, { breakGlassRole: null }, []],
  ]
  for (const [name, current, changes, expected] of rows) {
    test(name, () => {
      expect(ssoWeakenings({ ...base, ...current } as never, changes)).toEqual(expected as never)
    })
  }
})
