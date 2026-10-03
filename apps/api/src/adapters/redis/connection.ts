import { RedisClient } from 'bun'
import { type RedisCommands, redisErrorReason } from '~/adapters/redis/commands'
import * as logger from '~/lib/logger'
import type { Clock } from '~/ports/clock'
import type { HealthProbe } from '~/ports/health-probe'

/**
 * The part of Bun's `RedisClient` that {@link RedisConnection} drives. Declared here so the
 * connection logic can be tested without a server.
 */
export interface RedisDriver {
  /** Whether a connection is open right now. */
  readonly connected: boolean
  /** Called by the driver each time a connection opens. */
  onconnect: (() => void) | null
  /** Called by the driver each time a connection closes or fails to open. */
  onclose: ((error: Error) => void) | null
  /** Open a connection; rejects when the server cannot be reached. */
  connect(): Promise<void>
  /** Send one command over the open connection. */
  send(command: string, args: string[]): Promise<unknown>
  /** Close the connection. */
  close(): void
}

/**
 * How long connecting, or any one command, may take. Redis answers these commands in well under
 * a millisecond, so a second means it is not going to answer; waiting longer would only hold
 * requests open before they are refused anyway.
 */
export const REDIS_TIMEOUT_MS = 1_000

/**
 * After a failed connection attempt, how long commands are refused straight away before the
 * next attempt. Without it every request during an outage would wait for its own timeout.
 */
export const REDIS_RECONNECT_PAUSE_MS = 1_000

/** Timings of a {@link RedisConnection}; the defaults are the two constants above. */
export interface RedisConnectionOptions {
  timeoutMs?: number
  reconnectPauseMs?: number
}

function failure(name: string): Error {
  const error = new Error(name)
  error.name = name
  return error
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(failure('RedisTimeout')), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

/**
 * A Redis connection that fails fast and heals itself.
 *
 * - Commands are never queued while disconnected. A queue would hold requests open and then
 *   run their commands long after the caller gave up; refusing at once is what lets the
 *   adapters fail closed promptly.
 * - It connects on first use (building it opens nothing) and reconnects on demand: a command
 *   that finds the connection down starts one attempt that every waiting command shares, and
 *   after a failed attempt commands are refused for {@link REDIS_RECONNECT_PAUSE_MS} before the
 *   next one. Bun's own reconnection is off because it gives up for good after a fixed number
 *   of tries, which would leave the API refusing requests until restarted.
 * - Every command is bounded by {@link REDIS_TIMEOUT_MS}.
 * - Connection changes are logged with the error's name and code only, never its message or
 *   the connection string.
 */
export class RedisConnection implements RedisCommands {
  readonly #driver: RedisDriver
  readonly #clock: Clock
  readonly #timeoutMs: number
  readonly #pauseMs: number
  #connecting: Promise<void> | null
  #retryAt: number
  #closing: boolean

  /**
   * @param driver - The client to drive (Bun's `RedisClient` in production).
   * @param clock - Time source for the pause between connection attempts.
   * @param options - Timings; see {@link RedisConnectionOptions}.
   */
  constructor(driver: RedisDriver, clock: Clock, options: RedisConnectionOptions = {}) {
    this.#driver = driver
    this.#clock = clock
    this.#timeoutMs = options.timeoutMs ?? REDIS_TIMEOUT_MS
    this.#pauseMs = options.reconnectPauseMs ?? REDIS_RECONNECT_PAUSE_MS
    this.#connecting = null
    this.#retryAt = 0
    this.#closing = false
    driver.onconnect = () => {
      logger.info('redis connected')
    }
    driver.onclose = (error) => {
      // The close we asked for is not worth a warning.
      if (!this.#closing) {
        logger.warn('redis connection closed', { reason: redisErrorReason(error) })
      }
    }
  }

  /** @inheritdoc */
  async send(command: string, args: string[]): Promise<unknown> {
    if (!this.#driver.connected) {
      await this.#connect()
    }
    return withTimeout(this.#driver.send(command, args), this.#timeoutMs)
  }

  /** Close the connection for shutdown. */
  close(): void {
    // A flag rather than clearing `onclose`: in Bun 1.4 assigning `null` to it breaks `close()`.
    this.#closing = true
    this.#driver.close()
  }

  #connect(): Promise<void> {
    if (this.#connecting) {
      return this.#connecting
    }
    if (this.#clock.now().getTime() < this.#retryAt) {
      return Promise.reject(failure('RedisUnreachable'))
    }
    const attempt = withTimeout(this.#driver.connect(), this.#timeoutMs)
      .catch((error: unknown) => {
        this.#retryAt = this.#clock.now().getTime() + this.#pauseMs
        throw error
      })
      .finally(() => {
        this.#connecting = null
      })
    this.#connecting = attempt
    return attempt
  }
}

/**
 * Build a connection to Redis with Bun's built-in client. Opens nothing until the first command.
 *
 * @param url - `redis://`, `rediss://` (TLS), `valkey://` or `valkeys://` URL. Never logged.
 * @param clock - Time source for the pause between connection attempts.
 * @returns The connection.
 */
export function connectRedis(url: string, clock: Clock): RedisConnection {
  const client = new RedisClient(url, {
    enableOfflineQueue: false,
    autoReconnect: false,
    connectionTimeout: REDIS_TIMEOUT_MS,
  })
  return new RedisConnection(client, clock)
}

/**
 * Readiness probe that sends `PING`.
 *
 * @param redis - The Redis client.
 * @returns A probe named `redis`. Its failure carries the error's name and code only, because
 *   `/v1/ready` logs the reason.
 */
export function redisProbe(redis: RedisCommands): HealthProbe {
  return {
    name: 'redis',
    async check() {
      try {
        await redis.send('PING', [])
      } catch (error) {
        throw new Error(redisErrorReason(error))
      }
    },
  }
}
