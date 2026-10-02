import { describe, expect, test } from 'bun:test'
import { FixedClock } from '~/adapters/memory/clock'
import { MemoryLockout } from '~/adapters/memory/lockout'
import { CREDENTIAL_LOCKOUT, type LockoutPolicy, lockoutDelayMs } from '~/ports/lockout'

const policy: LockoutPolicy = {
  freeAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 8_000,
  forgetAfterMs: 60_000,
}

function setup() {
  const clock = new FixedClock()
  const lockout = new MemoryLockout(clock)
  const attempt = (key = 'k') => lockout.attempt(key, policy, clock.now())
  return { clock, lockout, attempt }
}

describe('lockoutDelayMs', () => {
  test.each([
    [1, 0],
    [3, 0],
    [4, 1_000],
    [5, 2_000],
    [6, 4_000],
    [7, 8_000],
    [8, 8_000],
    [5_000, 8_000],
  ])('%d failures → %d ms', (failures, expected) => {
    expect(lockoutDelayMs(policy, failures)).toBe(expected)
  })

  test('the credential policy gives 5 free tries, then 30s doubling to 15 minutes', () => {
    const delays = [5, 6, 7, 8, 9, 10, 11, 12].map((n) => lockoutDelayMs(CREDENTIAL_LOCKOUT, n))
    expect(delays).toEqual([0, 30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000])
  })
})

describe('MemoryLockout', () => {
  test('allows the free attempts, then imposes a doubling wait', async () => {
    const { clock, attempt } = setup()
    for (let i = 0; i < 3; i++) {
      expect(await attempt()).toEqual({ allowed: true, retryAfterMs: 0 })
    }
    // The 4th attempt is allowed and starts the first wait.
    expect(await attempt()).toEqual({ allowed: true, retryAfterMs: 0 })
    expect(await attempt()).toEqual({ allowed: false, retryAfterMs: 1_000 })
    clock.advance(999)
    expect(await attempt()).toEqual({ allowed: false, retryAfterMs: 1 })
    clock.advance(1)
    expect((await attempt()).allowed).toBe(true)
    expect(await attempt()).toEqual({ allowed: false, retryAfterMs: 2_000 })
  })

  test('refused attempts are not counted, so waiting is never extended by retrying', async () => {
    const { clock, attempt } = setup()
    for (let i = 0; i < 4; i++) {
      await attempt()
    }
    for (let i = 0; i < 50; i++) {
      expect((await attempt()).allowed).toBe(false)
    }
    clock.advance(1_000)
    expect((await attempt()).allowed).toBe(true)
    // Still the second wait (2s), not one inflated by the 50 refused tries.
    expect(await attempt()).toEqual({ allowed: false, retryAfterMs: 2_000 })
  })

  test('the wait is capped', async () => {
    const { clock, attempt } = setup()
    for (let i = 0; i < 40; i++) {
      const decision = await attempt()
      clock.advance(decision.allowed ? 8_000 : decision.retryAfterMs)
    }
    await attempt()
    expect((await attempt()).retryAfterMs).toBeLessThanOrEqual(8_000)
  })

  test('concurrent attempts cannot exceed the free attempts plus one', async () => {
    const { attempt } = setup()
    const decisions = await Promise.all(Array.from({ length: 50 }, () => attempt()))
    expect(decisions.filter((d) => d.allowed)).toHaveLength(4)
  })

  test('clear forgets the failures', async () => {
    const { lockout, attempt } = setup()
    for (let i = 0; i < 4; i++) {
      await attempt()
    }
    expect((await attempt()).allowed).toBe(false)
    await lockout.clear('k')
    for (let i = 0; i < 3; i++) {
      expect((await attempt()).allowed).toBe(true)
    }
    await lockout.clear('never-seen')
  })

  test('failures are forgotten after a quiet period', async () => {
    const { clock, attempt } = setup()
    for (let i = 0; i < 3; i++) {
      await attempt()
    }
    clock.advance(59_999)
    // Not yet forgotten: this is the 4th failure and starts a wait.
    await attempt()
    expect((await attempt()).allowed).toBe(false)

    // The quiet period runs from the end of that 1s wait.
    clock.advance(1_000 + 59_999)
    expect((await attempt()).allowed).toBe(true)
    expect((await attempt()).allowed).toBe(false)

    clock.advance(2_000 + 60_000)
    for (let i = 0; i < 3; i++) {
      expect((await attempt()).allowed).toBe(true)
    }
  })

  test('keys are independent', async () => {
    const { attempt } = setup()
    for (let i = 0; i < 5; i++) {
      await attempt('a')
    }
    expect((await attempt('a')).allowed).toBe(false)
    expect((await attempt('b')).allowed).toBe(true)
  })

  test('sweeps forgotten keys so memory stays bounded', async () => {
    const { clock, lockout } = setup()
    for (let i = 0; i < 999; i++) {
      await lockout.attempt(`old-${i}`, policy, clock.now())
    }
    expect(lockout.size).toBe(999)
    clock.advance(60_000)
    await lockout.attempt('fresh', policy, clock.now())
    expect(lockout.size).toBe(1)
  })
})
