import { describe, expect, test } from 'bun:test'
import { ImportPasswordSchema, MAX_IMPORT_PASSWORD_PARAMS } from './user'

describe('ImportPasswordSchema params (H-169)', () => {
  test('a few params pass', () => {
    expect(
      ImportPasswordSchema.safeParse({
        algorithm: 'firebase_scrypt',
        hash: 'x',
        params: { salt: 'a' },
      }).success
    ).toBe(true)
  })
  test('too many params are refused', () => {
    const params = Object.fromEntries(
      Array.from({ length: MAX_IMPORT_PASSWORD_PARAMS + 1 }, (_, i) => [`k${i}`, 1])
    )
    expect(ImportPasswordSchema.safeParse({ algorithm: 'x', hash: 'x', params }).success).toBe(
      false
    )
  })
})
