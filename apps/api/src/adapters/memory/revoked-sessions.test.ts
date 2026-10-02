import { describe, expect, test } from 'bun:test'
import { FixedClock } from '~/adapters/memory/clock'
import { MemoryRevokedSessions } from '~/adapters/memory/revoked-sessions'

describe('MemoryRevokedSessions', () => {
  test('reports a revoked session until its access tokens have expired', async () => {
    const clock = new FixedClock()
    const list = new MemoryRevokedSessions(clock)
    const until = new Date(clock.now().getTime() + 60_000)
    await list.add('s1', until)
    expect(await list.has('s1', clock.now())).toBe(true)
    expect(await list.has('other', clock.now())).toBe(false)
    clock.advance(59_999)
    expect(await list.has('s1', clock.now())).toBe(true)
    clock.advance(1)
    expect(await list.has('s1', clock.now())).toBe(false)
  })

  test('re-adding never shortens an entry', async () => {
    const clock = new FixedClock()
    const list = new MemoryRevokedSessions(clock)
    await list.add('s1', new Date(clock.now().getTime() + 60_000))
    await list.add('s1', new Date(clock.now().getTime() + 10_000))
    clock.advance(30_000)
    expect(await list.has('s1', clock.now())).toBe(true)
  })

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
