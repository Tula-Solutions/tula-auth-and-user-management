import { evalScript, integers, KEY_NAMESPACE, type RedisCommands } from '~/adapters/redis/commands'
import type { KeyedHash } from '~/lib/keyed-hash'
import type { Clock } from '~/ports/clock'
import type { RateLimitDecision, RateLimiter } from '~/ports/rate-limiter'

/**
 * Count one request in a fixed window, atomically.
 *
 * `KEYS[1]` is the bucket; `ARGV` is the caller's time and the window length, both in
 * milliseconds. Replies `{count, milliseconds until the window ends}`. A window keeps the length
 * it was opened with, as in the memory adapter. The expiry only reclaims the key: whether the
 * window is over is decided from the stored start time.
 */
export const RATE_LIMIT_SCRIPT = `
local now = tonumber(ARGV[1])
local bucket = redis.call('HMGET', KEYS[1], 'start', 'count', 'window')
local start = tonumber(bucket[1])
local count = tonumber(bucket[2]) or 0
local window = tonumber(bucket[3])
if not start or not window or now - start >= window then
  start = now
  count = 0
  window = tonumber(ARGV[2])
end
count = count + 1
local remaining = start + window - now
redis.call('HSET', KEYS[1], 'start', start, 'count', count, 'window', window)
redis.call('PEXPIRE', KEYS[1], remaining)
return {count, remaining}
`

/** Key-separation label for the HMAC that names a bucket (see {@link RedisRateLimiter}). */
export const RATE_LIMIT_KEY_PURPOSE = 'rate-limit-keys'

/**
 * Fixed-window counter in Redis, shared by every API instance.
 *
 * - **Atomic.** One Lua script reads, resets, counts and replies, so requests arriving at
 *   different instances at the same moment are counted one after another and can never exceed
 *   the limit between them.
 * - **No personal data in Redis.** Bucket names are built by callers and contain client IP
 *   addresses (`sign_in:ip:203.0.113.7`); emails are already hashed by the callers. The Redis
 *   key is `tula:rl:<HMAC-SHA256 of the bucket name>`, keyed from `TULA_MASTER_KEY`, so the
 *   store holds neither and a plain hash of an IPv4 address cannot be reversed by trying all of
 *   them. Keep it that way: never put a bucket name in a key, a value or a log line.
 * - **Fails closed.** When Redis cannot answer, `hit` throws `service.unavailable`; it never
 *   reports a request as allowed (ADR 0016).
 * - Windows are measured with the calling instance's clock, so instances are assumed to keep
 *   time with each other (NTP); a skew shifts a window's end by that much.
 */
export class RedisRateLimiter implements RateLimiter {
  /**
   * @param redis - The Redis client.
   * @param clock - Time source for window boundaries.
   * @param keyedHash - Derives the Redis key from a bucket name.
   * @param namespace - First key segment (default {@link KEY_NAMESPACE}).
   */
  constructor(
    private readonly redis: RedisCommands,
    private readonly clock: Clock,
    private readonly keyedHash: KeyedHash,
    private readonly namespace: string = KEY_NAMESPACE
  ) {}

  /** @inheritdoc */
  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitDecision> {
    const bucket = `${this.namespace}:rl:${await this.keyedHash.hmac(RATE_LIMIT_KEY_PURPOSE, key)}`
    const reply = await evalScript(
      this.redis,
      RATE_LIMIT_SCRIPT,
      [bucket],
      [String(this.clock.now().getTime()), String(windowMs)]
    )
    const [count, retryAfterMs] = integers(reply, 2) as [number, number]
    const allowed = count <= limit
    return { allowed, remaining: allowed ? limit - count : 0, retryAfterMs }
  }
}
