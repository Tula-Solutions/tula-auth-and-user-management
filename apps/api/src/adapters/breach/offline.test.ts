import { describe, expect, test } from 'bun:test'
import { offlineBreachChecker } from '~/adapters/breach/offline'
import type { BreachStatus } from '~/ports/breach-checker'

const cases: [name: string, password: string, expected: BreachStatus][] = [
  ['a bundled common password', 'password123', 'breached'],
  ['the same password in another case', 'PassWord123', 'breached'],
  ['an uncommon passphrase', 'tidal otter kelp forty-two', 'clean'],
]

describe('offlineBreachChecker', () => {
  test.each(cases)('%s → %s', async (_name, password, expected) => {
    expect(await offlineBreachChecker.check(password)).toBe(expected)
  })
})
