import { describe, expect, test } from 'bun:test'
import type { Database } from '@tula-tech/db'
import {
  assertRuntimeRole,
  judgeRuntimeRole,
  RUNTIME_ROLE_REFUSAL,
  type RuntimeRoleFacts,
  RuntimeRoleRefusedError,
} from './runtime-role'

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

/** A database whose role query answers `rows`, or fails with `error`. */
function answering(rows: RuntimeRoleFacts[], error?: Error): Database {
  return {
    execute: async () => {
      if (error) {
        throw error
      }
      return { rows }
    },
  } as unknown as Database
}

describe('assertRuntimeRole', () => {
  test('a plain role passes', async () => {
    await expect(assertRuntimeRole(answering([safe]))).resolves.toBeUndefined()
  })

  test('a role that bypasses row-level security is refused with its own error', async () => {
    const refused = assertRuntimeRole(answering([{ ...safe, superuser: true }]))
    await expect(refused).rejects.toBeInstanceOf(RuntimeRoleRefusedError)
    await expect(refused).rejects.toThrow(RUNTIME_ROLE_REFUSAL)
  })

  test('a database that does not answer is the driver error, not a refusal', async () => {
    const away = new Error('connect ECONNREFUSED')
    await expect(assertRuntimeRole(answering([], away))).rejects.toBe(away)
  })
})
