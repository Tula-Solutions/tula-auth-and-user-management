import { describe, expect, test } from 'bun:test'
import { DurationSchema, durationToMs } from './duration'

describe('durationToMs', () => {
  test.each([
    ['60s', 60_000],
    ['15m', 900_000],
    ['8h', 28_800_000],
    ['30d', 2_592_000_000],
  ])('%s = %d ms', (input, expected) => {
    expect(durationToMs(input)).toBe(expected)
  })

  test.each(['', '10', '5w', '-1d', '1.5h', 'd'])('rejects %p', (input) => {
    expect(() => durationToMs(input)).toThrow('Invalid duration')
    expect(DurationSchema.safeParse(input).success).toBe(false)
  })
})

describe('durations must be positive and bounded (F3)', () => {
  test.each(['0s', '0d', '00m', `${'9'.repeat(400)}d`, '99999999d'])('rejects %p', (input) => {
    expect(DurationSchema.safeParse(input).success).toBe(false)
    expect(() => durationToMs(input)).toThrow('Invalid duration')
  })

  test('accepts the largest supported value (10 years)', () => {
    expect(durationToMs('3650d')).toBe(3650 * 86_400_000)
  })
})
