import {
  CLOCK_SKEW_ALLOWANCE_MS,
  call,
  evalScript,
  integers,
  KEY_NAMESPACE,
  type RedisCommands,
} from '~/adapters/redis/commands'
import {
  type Lockout,
  type LockoutDecision,
  type LockoutPolicy,
  lockoutDelayMs,
} from '~/ports/lockout'

/**
 * Register one attempt, atomically: refuse it while locked, otherwise count it as a failure and
 * set the next wait.
 *
 * `KEYS[1]` is the lockout entry. `ARGV` is: the caller's time, the free attempts, the quiet
 * period after which failures are forgotten, the expiry allowance, then the wait imposed by the
 * 1st, 2nd, 3rd… failure beyond the free attempts (the last one repeats). Replies
 * `{1, 0}` for an allowed attempt and `{0, milliseconds to wait}` for a refused one, which is
 * not counted. The expiry only reclaims the key: forgetting is decided from `forgetAt`.
 */
export const LOCKOUT_SCRIPT = `
local now = tonumber(ARGV[1])
local entry = redis.call('HMGET', KEYS[1], 'failures', 'lockedUntil', 'forgetAt')
local failures = tonumber(entry[1]) or 0
local lockedUntil = tonumber(entry[2]) or 0
local forgetAt = tonumber(entry[3]) or 0
if now < lockedUntil then
  return {0, lockedUntil - now}
end
if now >= forgetAt then
  failures = 0
end
failures = failures + 1
local over = failures - tonumber(ARGV[2])
local delay = 0
if over > 0 then
  delay = tonumber(ARGV[4 + math.min(over, #ARGV - 4)])
end
lockedUntil = now + delay
forgetAt = lockedUntil + tonumber(ARGV[3])
redis.call('HSET', KEYS[1], 'failures', failures, 'lockedUntil', lockedUntil, 'forgetAt', forgetAt)
redis.call('PEXPIRE', KEYS[1], forgetAt - now + tonumber(ARGV[4]))
return {1, 0}
`

/** `lockoutDelayMs` stops growing here at the latest: it caps the exponent at 30. */
const MAX_SCHEDULE_LENGTH = 31

/**
 * The waits a policy imposes, one per failure beyond the free attempts, up to the first that
 * reaches the cap.
 *
 * Computed with {@link lockoutDelayMs} and handed to the script, so the schedule is written once
 * and the memory and Redis adapters cannot disagree about it.
 *
 * @param policy - The lockout policy.
 * @returns The waits in milliseconds; the last one applies to every later failure.
 */
export function lockoutSchedule(policy: LockoutPolicy): number[] {
  const delays: number[] = []
  for (let over = 1; over <= MAX_SCHEDULE_LENGTH; over++) {
    const delay = lockoutDelayMs(policy, policy.freeAttempts + over)
    delays.push(delay)
    if (delay >= policy.maxDelayMs) {
      break
    }
  }
  return delays
}

/**
 * Lockout state in Redis, shared by every API instance.
 *
 * - **Atomic.** One Lua script checks the lock, counts the attempt and sets the next wait, so
 *   an attempt is counted exactly once wherever it arrives and parallel guesses sent to
 *   different instances cannot all slip through while unlocked.
 * - **No personal data in Redis.** The key is `tula:lo:<key>`, and callers pass keys made only
 *   of ids and hashes (`signInLockKey` hashes the identifier; changing a password is keyed by
 *   user id). Keep it that way: never build a lockout key from an email address.
 * - **Fails closed.** When Redis cannot answer, `attempt` and `clear` throw
 *   `service.unavailable`; an attempt is never allowed uncounted (ADR 0016).
 * - Time is the caller's (`now`), so instances are assumed to keep time with each other (NTP).
 */
export class RedisLockout implements Lockout {
  /**
   * @param redis - The Redis client.
   * @param namespace - First key segment (default {@link KEY_NAMESPACE}).
   */
  constructor(
    private readonly redis: RedisCommands,
    private readonly namespace: string = KEY_NAMESPACE
  ) {}

  /** @inheritdoc */
  async attempt(key: string, policy: LockoutPolicy, now: Date): Promise<LockoutDecision> {
    const reply = await evalScript(
      this.redis,
      LOCKOUT_SCRIPT,
      [this.#key(key)],
      [
        String(now.getTime()),
        String(policy.freeAttempts),
        String(policy.forgetAfterMs),
        String(CLOCK_SKEW_ALLOWANCE_MS),
        ...lockoutSchedule(policy).map(String),
      ]
    )
    const [allowed, retryAfterMs] = integers(reply, 2) as [number, number]
    return { allowed: allowed === 1, retryAfterMs }
  }

  /** @inheritdoc */
  async clear(key: string): Promise<void> {
    await call(this.redis, 'DEL', [this.#key(key)])
  }

  #key(key: string): string {
    return `${this.namespace}:lo:${key}`
  }
}
