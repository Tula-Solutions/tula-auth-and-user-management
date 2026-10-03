import type { RedisCommands } from '~/adapters/redis/commands'
import { LOCKOUT_SCRIPT } from '~/adapters/redis/lockout'
import { RATE_LIMIT_SCRIPT } from '~/adapters/redis/rate-limiter'
import { REVOKE_SCRIPT } from '~/adapters/redis/revoked-sessions'
import type { Clock } from '~/ports/clock'

interface Item {
  value: string | Map<string, string>
  /** Epoch milliseconds, or `null` for a key that never expires. */
  expiresAt: number | null
}

function redisError(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: 'RedisError', code })
}

/** Lua's `tonumber`: a number, or `undefined` for a missing field. */
function toNumber(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Number(value)
}

/**
 * A stand-in for a Redis server, for unit tests only: the few commands the adapters send, key
 * expiry driven by a test clock, and a switch that makes every command fail.
 *
 * Two adapters given the same `FakeRedis` behave like two API instances sharing one Redis.
 * Each command runs to completion before the next, as on a real server.
 *
 * It cannot run Lua. Each script the adapters send is re-stated here in TypeScript, line for
 * line, so the fake proves the adapter code around the scripts and not the scripts themselves.
 * Those are proved by `redis.integration.ts`, which runs the same behaviour suites against a
 * real server; a change to a script must be mirrored here, and that run is what catches a
 * mirror that drifted.
 */
export class FakeRedis implements RedisCommands {
  readonly #items: Map<string, Item>
  readonly #clock: Clock
  #outage: Error | null

  /** @param clock - Time source for key expiry. */
  constructor(clock: Clock) {
    this.#items = new Map()
    this.#clock = clock
    this.#outage = null
  }

  /**
   * Make every later command fail, as when the server is unreachable.
   *
   * @param error - What commands reject with (default: Bun's connection-closed error).
   */
  fail(error: Error = redisError('ERR_REDIS_CONNECTION_CLOSED', 'Connection closed')): void {
    this.#outage = error
  }

  /** Undo {@link FakeRedis.fail}. Stored keys are kept, as after a network blip. */
  recover(): void {
    this.#outage = null
  }

  /** @returns Every key that has not expired. */
  keys(): string[] {
    return [...this.#items.keys()].filter((key) => this.#live(key) !== undefined)
  }

  /** @inheritdoc */
  async send(command: string, args: string[]): Promise<unknown> {
    if (this.#outage) {
      throw this.#outage
    }
    const [first = '', ...rest] = args
    switch (command) {
      case 'PING':
        return 'PONG'
      case 'GET':
        return this.#string(first) ?? null
      case 'SET':
        return this.#set(first, rest)
      case 'DEL':
        return this.#items.delete(first) ? 1 : 0
      case 'PTTL':
        return this.#pttl(first)
      case 'EVAL':
        return this.#script(first, rest)
      default:
        throw redisError('ERR_REDIS_SERVER_ERROR', `ERR unknown command '${command}'`)
    }
  }

  #live(key: string): Item | undefined {
    const item = this.#items.get(key)
    if (item && item.expiresAt !== null && item.expiresAt <= this.#clock.now().getTime()) {
      this.#items.delete(key)
      return undefined
    }
    return item
  }

  #string(key: string): string | undefined {
    const value = this.#live(key)?.value
    return typeof value === 'string' ? value : undefined
  }

  #hash(key: string): Map<string, string> {
    const value = this.#live(key)?.value
    return value instanceof Map ? value : new Map()
  }

  /** `PEXPIRE`: a lifetime that is not positive deletes the key. */
  #write(key: string, value: Item['value'], lifetimeMs: number | null): void {
    if (lifetimeMs !== null && lifetimeMs <= 0) {
      this.#items.delete(key)
      return
    }
    const expiresAt = lifetimeMs === null ? null : this.#clock.now().getTime() + lifetimeMs
    this.#items.set(key, { value, expiresAt })
  }

  #set(key: string, [value = '', option, lifetime]: string[]): string {
    this.#write(key, value, option === 'PX' ? Number(lifetime) : null)
    return 'OK'
  }

  #pttl(key: string): number {
    const item = this.#live(key)
    if (!item) {
      return -2
    }
    return item.expiresAt === null ? -1 : item.expiresAt - this.#clock.now().getTime()
  }

  /** `EVAL`: dispatch to the TypeScript mirror of a known script. Nothing is evaluated. */
  #script(script: string, [count = '0', ...rest]: string[]): unknown {
    const keys = rest.slice(0, Number(count))
    const argv = rest.slice(Number(count))
    const [key = ''] = keys
    if (script === RATE_LIMIT_SCRIPT) {
      return this.#rateLimit(key, argv)
    }
    if (script === LOCKOUT_SCRIPT) {
      return this.#lockout(key, argv)
    }
    if (script === REVOKE_SCRIPT) {
      return this.#revoke(key, argv)
    }
    throw redisError('ERR_REDIS_SERVER_ERROR', 'ERR FakeRedis does not know this script')
  }

  /** Mirrors `RATE_LIMIT_SCRIPT`. */
  #rateLimit(key: string, argv: string[]): number[] {
    const now = Number(argv[0])
    const bucket = this.#hash(key)
    let start = toNumber(bucket.get('start'))
    let count = toNumber(bucket.get('count')) ?? 0
    let window = toNumber(bucket.get('window'))
    if (start === undefined || window === undefined || now - start >= window) {
      start = now
      count = 0
      window = Number(argv[1])
    }
    count += 1
    const remaining = start + window - now
    this.#write(
      key,
      new Map([
        ['start', String(start)],
        ['count', String(count)],
        ['window', String(window)],
      ]),
      remaining
    )
    return [count, remaining]
  }

  /** Mirrors `LOCKOUT_SCRIPT`. */
  #lockout(key: string, argv: string[]): number[] {
    const now = Number(argv[0])
    const entry = this.#hash(key)
    let failures = toNumber(entry.get('failures')) ?? 0
    let lockedUntil = toNumber(entry.get('lockedUntil')) ?? 0
    let forgetAt = toNumber(entry.get('forgetAt')) ?? 0
    if (now < lockedUntil) {
      return [0, lockedUntil - now]
    }
    if (now >= forgetAt) {
      failures = 0
    }
    failures += 1
    const over = failures - Number(argv[1])
    // Lua's ARGV is 1-based with four fixed arguments; here the waits start at index 4.
    const delay = over > 0 ? Number(argv[3 + Math.min(over, argv.length - 4)]) : 0
    lockedUntil = now + delay
    forgetAt = lockedUntil + Number(argv[2])
    this.#write(
      key,
      new Map([
        ['failures', String(failures)],
        ['lockedUntil', String(lockedUntil)],
        ['forgetAt', String(forgetAt)],
      ]),
      forgetAt - now + Number(argv[3])
    )
    return [1, 0]
  }

  /** Mirrors `REVOKE_SCRIPT`. */
  #revoke(key: string, argv: string[]): number[] {
    const [until = '', lifetime] = argv
    const current = toNumber(this.#string(key))
    if (current !== undefined && current >= Number(until)) {
      return [0]
    }
    this.#write(key, until, Number(lifetime))
    return [1]
  }
}
