import { describe, expect, test } from 'bun:test'
import { FixedClock } from '~/adapters/memory/clock'
import { MemoryRevokedSessions } from '~/adapters/memory/revoked-sessions'
import { describeRevokedSessions } from '~/adapters/revoked-sessions.suite'

describeRevokedSessions('memory', async () => {
  const clock = new FixedClock()
  const list = new MemoryRevokedSessions(clock)
  return { list, peer: list, clock }
})

describe('MemoryRevokedSessions', () => {
  test('sweeps expired entries so memory stays bounded', async () => {
    const clock = new FixedClock()
    const list = new MemoryRevokedSessions(clock)
    for (let i = 0; i < 499; i++) {
      await list.add(`old-${i}`, new Date(clock.now().getTime() + 1_000))
    }
    expect(list.size).toBe(499)
    clock.advance(2_000)
    await list.add('fresh', new Date(clock.now().getTime() + 60_000))
    expect(list.size).toBe(1)
    expect(await list.has('fresh', clock.now())).toBe(true)
  })
})
