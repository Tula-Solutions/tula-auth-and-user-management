import { describe, expect, test } from 'bun:test'
import { BATCH_BYTE_LIMIT, nextBatch } from './run'
import type { SourceRow } from './types'

function rows(count: number, size: number): SourceRow[] {
  return Array.from({ length: count }, (_, index) => ({
    row: index + 1,
    email: `u${index}@example.test`,
    refusal: null,
    user: {
      email: `u${index}@example.test`,
      emailVerified: true,
      metadata: { blob: 'x'.repeat(size) },
    },
  }))
}

describe('nextBatch', () => {
  test('takes at most batchSize rows, after the last one sent, skipping refused rows', () => {
    const all = rows(10, 10)
    all[2] = { row: 3, email: null, user: null, refusal: { code: 'email.invalid', reason: 'x' } }
    expect(nextBatch(all, 0, 4, 0).map((entry) => entry.row)).toEqual([1, 2, 4, 5])
    expect(nextBatch(all, 5, 4, 0).map((entry) => entry.row)).toEqual([6, 7, 8, 9])
    expect(nextBatch(all, 9, 4, 0).map((entry) => entry.row)).toEqual([10])
    expect(nextBatch(all, 10, 4, 0)).toEqual([])
  })

  test('stops before the request body would pass the byte limit, whatever the row count', () => {
    const all = rows(300, 30_000)
    const batch = nextBatch(all, 0, 500, 0)
    expect(batch.length).toBeGreaterThan(100)
    expect(batch.length).toBeLessThan(300)
    const body = JSON.stringify({ users: batch.map((entry) => entry.user) })
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(BATCH_BYTE_LIMIT)
    // Room is kept for what a batch carries beside its rows.
    expect(nextBatch(all, 0, 500, 1_000_000).length).toBeLessThan(batch.length)
  })

  test('a row that is alone over the limit still goes, by itself', () => {
    expect(nextBatch(rows(3, BATCH_BYTE_LIMIT + 10), 0, 500, 0)).toHaveLength(1)
  })
})
