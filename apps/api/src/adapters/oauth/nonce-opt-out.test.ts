import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('H-160: only LinkedIn opts out of the ID-token nonce check', () => {
  test('NONCE_NOT_ECHOED is used by linkedin.ts and no other adapter', () => {
    const users = readdirSync(import.meta.dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'id-token.ts')
      .filter((f) => readFileSync(join(import.meta.dir, f), 'utf8').includes('NONCE_NOT_ECHOED'))
    expect(users).toEqual(['linkedin.ts'])
  })
})
