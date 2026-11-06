import { evalScript, integers, KEY_NAMESPACE, type RedisCommands } from '~/adapters/redis/commands'
import type { Clock } from '~/ports/clock'
import type { ExportLeases } from '~/ports/export-leases'

/**
 * Take a lease unless the environment is at its limit, atomically.
 *
 * `KEYS[1]` is the environment's hash of lease id to expiry; `ARGV` is the caller's time, the
 * limit, the lifetime (milliseconds) and the new lease's id. Expired leases are dropped first.
 * Replies `{1}` for a granted lease, `{0}` at the limit. The key's own expiry only reclaims it:
 * whether a lease is live is decided from its stored expiry.
 */
export const LEASE_ACQUIRE_SCRIPT = `
local now = tonumber(ARGV[1])
local leases = redis.call('HGETALL', KEYS[1])
local live = 0
for i = 1, #leases, 2 do
  if tonumber(leases[i + 1]) <= now then
    redis.call('HDEL', KEYS[1], leases[i])
  else
    live = live + 1
  end
end
if live >= tonumber(ARGV[2]) then
  return {0}
end
redis.call('HSET', KEYS[1], ARGV[4], now + tonumber(ARGV[3]))
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return {1}
`

/**
 * Push a live lease's expiry ahead. `ARGV` is the caller's time, the lifetime and the lease id.
 * Replies `{1}` renewed, `{0}` for a lease that is gone or expired.
 */
export const LEASE_RENEW_SCRIPT = `
local now = tonumber(ARGV[1])
local expiry = tonumber(redis.call('HGET', KEYS[1], ARGV[3]))
if not expiry or expiry <= now then
  return {0}
end
redis.call('HSET', KEYS[1], ARGV[3], now + tonumber(ARGV[2]))
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return {1}
`

/** Give a lease back (`ARGV[1]`); the key goes with its last lease. Replies `{1}`. */
export const LEASE_RELEASE_SCRIPT = `
redis.call('HDEL', KEYS[1], ARGV[1])
if redis.call('HLEN', KEYS[1]) == 0 then
  redis.call('DEL', KEYS[1])
end
return {1}
`

/**
 * Export leases in Redis, shared by every API instance: the cap on an environment's
 * concurrent exports holds however the requests are spread.
 *
 * - **Atomic.** One Lua script prunes, counts and grants, so requests at different instances
 *   at the same moment cannot exceed the limit between them.
 * - **No personal data in Redis.** The key is `tula:export:<environment id>`; the fields are
 *   random lease ids.
 * - **Fails closed.** When Redis cannot answer, or sends anything but the replies the scripts
 *   have, every method throws `service.unavailable`: an export is never started on a guess
 *   (ADR 0016).
 * - Expiry is measured with the calling instance's clock, so instances are assumed to keep
 *   time with each other (NTP).
 */
export class RedisExportLeases implements ExportLeases {
  /**
   * @param redis - The Redis client.
   * @param clock - Time source for lease expiry.
   * @param namespace - First key segment (default {@link KEY_NAMESPACE}).
   */
  constructor(
    private readonly redis: RedisCommands,
    private readonly clock: Clock,
    private readonly namespace: string = KEY_NAMESPACE
  ) {}

  #key(environmentId: string): string {
    return `${this.namespace}:export:${environmentId}`
  }

  /** @inheritdoc */
  async acquire(environmentId: string, limit: number, ttlMs: number): Promise<string | null> {
    const id = crypto.randomUUID()
    const reply = await evalScript(
      this.redis,
      LEASE_ACQUIRE_SCRIPT,
      [this.#key(environmentId)],
      [String(this.clock.now().getTime()), String(limit), String(ttlMs), id]
    )
    return integers(reply, 1)[0] === 1 ? id : null
  }

  /** @inheritdoc */
  async renew(environmentId: string, leaseId: string, ttlMs: number): Promise<boolean> {
    const reply = await evalScript(
      this.redis,
      LEASE_RENEW_SCRIPT,
      [this.#key(environmentId)],
      [String(this.clock.now().getTime()), String(ttlMs), leaseId]
    )
    return integers(reply, 1)[0] === 1
  }

  /** @inheritdoc */
  async release(environmentId: string, leaseId: string): Promise<void> {
    integers(
      await evalScript(this.redis, LEASE_RELEASE_SCRIPT, [this.#key(environmentId)], [leaseId]),
      1
    )
  }
}
