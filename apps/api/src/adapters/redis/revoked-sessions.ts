import {
  CLOCK_SKEW_ALLOWANCE_MS,
  call,
  evalScript,
  integers,
  KEY_NAMESPACE,
  type RedisCommands,
} from '~/adapters/redis/commands'
import { ServiceUnavailableError } from '~/exceptions'
import type { Clock } from '~/ports/clock'
import type { RevokedSessions } from '~/ports/revoked-sessions'

/**
 * Record a revoked session until `ARGV[1]` (epoch milliseconds), never shortening an entry that
 * already lasts longer. `ARGV[2]` is the key's lifetime in milliseconds. Replies `{1}` when it
 * wrote and `{0}` when the existing entry was kept.
 */
export const REVOKE_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]))
if current and current >= tonumber(ARGV[1]) then
  return {0}
end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return {1}
`

/**
 * Revoked-session denylist in Redis, shared by every API instance: a session revoked through
 * one instance is refused by all of them at once.
 *
 * - **No personal data in Redis.** The key is `tula:rs:<session id>` (a random UUID) and the
 *   value is a timestamp. Keep it that way.
 * - **Fails closed.** When Redis cannot answer, `has` throws `service.unavailable`: a token is
 *   not accepted while nobody can say whether its session was revoked. `add` throws too, and
 *   the session service adds to the list before it revokes, so the revocation is refused rather
 *   than half done (ADR 0016).
 * - Entries expire on their own a little after the session's last access token
 *   ({@link CLOCK_SKEW_ALLOWANCE_MS}), so the list needs no sweeping.
 */
export class RedisRevokedSessions implements RevokedSessions {
  /**
   * @param redis - The Redis client.
   * @param clock - Time source for how long an entry is kept.
   * @param namespace - First key segment (default {@link KEY_NAMESPACE}).
   */
  constructor(
    private readonly redis: RedisCommands,
    private readonly clock: Clock,
    private readonly namespace: string = KEY_NAMESPACE
  ) {}

  /** @inheritdoc */
  async add(sessionId: string, until: Date): Promise<void> {
    const remaining = Math.max(0, until.getTime() - this.clock.now().getTime())
    const reply = await evalScript(
      this.redis,
      REVOKE_SCRIPT,
      [this.#key(sessionId)],
      [String(until.getTime()), String(remaining + CLOCK_SKEW_ALLOWANCE_MS)]
    )
    integers(reply, 1)
  }

  /** @inheritdoc */
  async has(sessionId: string, now: Date): Promise<boolean> {
    const until = await call(this.redis, 'GET', [this.#key(sessionId)])
    if (until === null) {
      return false
    }
    const time = typeof until === 'string' ? Number(until) : Number.NaN
    if (!Number.isFinite(time)) {
      throw new ServiceUnavailableError({ internalMessage: 'redis sent an unexpected reply' })
    }
    return time > now.getTime()
  }

  #key(sessionId: string): string {
    return `${this.namespace}:rs:${sessionId}`
  }
}
