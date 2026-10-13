import { describe, expect, test } from 'bun:test'
import { FixedClock } from '~/adapters/memory/clock'
import { MemoryProofReplayGuard } from '~/adapters/memory/proof-replay'
import { describeProofReplayGuard } from '~/adapters/proof-replay.suite'

describeProofReplayGuard('memory', async () => {
  const clock = new FixedClock()
  const guard = new MemoryProofReplayGuard(clock)
  return { clock, guard, peer: guard, allowanceMs: 0, movesTime: true }
})

describe('MemoryProofReplayGuard', () => {
  test('sweeps what it no longer needs, so it does not grow for ever', async () => {
    const clock = new FixedClock()
    const guard = new MemoryProofReplayGuard(clock)
    const soon = new Date(clock.now().getTime() + 1_000)
    for (let i = 0; i < 499; i++) {
      await guard.remember(`early-${i}`, soon)
    }
    expect(guard.size).toBe(499)
    clock.advance(1_000)
    await guard.remember('late', new Date(clock.now().getTime() + 1_000))
    expect(guard.size).toBe(1)
  })
})
