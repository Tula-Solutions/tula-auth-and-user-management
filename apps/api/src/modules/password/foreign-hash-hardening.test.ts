import { describe, expect, test } from 'bun:test'
import * as Foreign from '~/modules/password/foreign-hash'

const SALT = Buffer.alloc(16, 1).toString('base64').replace(/=+$/, '')
const HASH = Buffer.alloc(32, 2).toString('base64').replace(/=+$/, '')

describe('limits are judged again at verify time (H-174)', () => {
  test('an argon2id hash asking for 4 GiB is a mismatch, not a computation', async () => {
    const stored = `$argon2id$v=19$m=4194304,t=2,p=1$${SALT}$${HASH}`
    expect(await Foreign.verify(stored, 'pw')).toBe(false)
  })

  test('a bcrypt hash of cost 31 is a mismatch', async () => {
    const stored = `$2b$31$${'a'.repeat(53)}`
    expect(await Foreign.verify(stored, 'pw')).toBe(false)
  })

  test('a hash inside the limits still goes to Bun', async () => {
    const stored = await Bun.password.hash('pw', {
      algorithm: 'argon2id',
      memoryCost: 65_536,
      timeCost: 2,
    })
    expect(await Foreign.verify(stored, 'pw')).toBeNull()
  })
})

describe('argon2 salt and hash length are capped (H-167)', () => {
  test('an oversized salt or hash is refused at import', () => {
    const big = Buffer.alloc(100_000, 3).toString('base64').replace(/=+$/, '')
    expect(Foreign.parse('argon2id', `$argon2id$v=19$m=19456,t=2,p=1$${big}$${HASH}`)).toEqual({
      ok: false,
      code: 'import.hash_malformed',
    })
    expect(Foreign.parse('argon2id', `$argon2id$v=19$m=19456,t=2,p=1$${SALT}$${big}`)).toEqual({
      ok: false,
      code: 'import.hash_malformed',
    })
  })
})
