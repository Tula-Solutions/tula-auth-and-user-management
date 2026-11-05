import { describe, expect, test } from 'bun:test'
import { judgeRuntimeRole, RUNTIME_ROLE_REFUSAL } from './runtime-role'

const safe = { superuser: false, bypassRls: false, ownedTables: 0 }

describe('judgeRuntimeRole', () => {
  test('a plain role that owns nothing is accepted', () => {
    expect(judgeRuntimeRole(safe)).toBeNull()
  })

  test.each([
    ['a superuser', { ...safe, superuser: true }],
    ['a role with BYPASSRLS', { ...safe, bypassRls: true }],
    ['the owner of a table', { ...safe, ownedTables: 3 }],
    ['no answer at all', undefined],
  ])('%s is refused with the fixed message', (_name, answer) => {
    expect(judgeRuntimeRole(answer)).toBe(RUNTIME_ROLE_REFUSAL)
  })

  test('the message names no credentials', () => {
    expect(RUNTIME_ROLE_REFUSAL).not.toMatch(/postgres(ql)?:\/\/|password|@/i)
  })
})
