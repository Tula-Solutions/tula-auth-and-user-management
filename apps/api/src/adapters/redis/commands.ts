import { ServiceUnavailableError } from '~/exceptions'

/**
 * All the Redis adapters need from a client: send one command, get its reply.
 *
 * Kept this small so the adapters can be unit-tested against `FakeRedis` and run in production
 * on `RedisConnection` (Bun's built-in client) without knowing which one they have.
 */
export interface RedisCommands {
  /**
   * @param command - The command name, e.g. `EVAL`.
   * @param args - Its arguments, already strings.
   * @returns The reply: a string, a number, `null`, or an array of those.
   * @throws Whatever the client throws when the server is unreachable or answers with an error.
   */
  send(command: string, args: string[]): Promise<unknown>
}

/** First segment of every key Tula writes, so it can share a Redis with other software. */
export const KEY_NAMESPACE = 'tula'

/**
 * Extra lifetime given to lockout and revoked-session keys beyond the moment the application
 * stops needing them.
 *
 * Entries carry their own timestamps and are judged against the calling instance's clock; the
 * Redis expiry only reclaims memory. The allowance keeps an entry from disappearing while an
 * instance whose clock runs behind still considers it live. Rate-limit windows are the
 * exception: their key expires exactly at the end of the window as the writer saw it, so clock
 * skew only shifts where a window starts and no allowance is needed.
 */
export const CLOCK_SKEW_ALLOWANCE_MS = 30_000

/** Bun reports an error reply from the server (as opposed to a connection problem) with this code. */
const SERVER_ERROR = 'ERR_REDIS_SERVER_ERROR'

/**
 * Describe a Redis failure for a log line: the error's name and code, and for an error reply the
 * server's error class (`WRONGTYPE`, `NOAUTH`, `OOM`…).
 *
 * Never the message: it is not ours to vouch for, and a client may quote a host, a user name or
 * a key in it.
 *
 * @param error - Whatever the client threw.
 * @returns E.g. `RedisError ERR_REDIS_CONNECTION_CLOSED`.
 */
export function redisErrorReason(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'NonError'
  }
  const code = (error as { code?: unknown }).code
  if (typeof code !== 'string' || code.length === 0) {
    return error.name
  }
  const kind = code === SERVER_ERROR ? /^[A-Z]+/.exec(error.message)?.[0] : undefined
  return kind ? `${error.name} ${code} ${kind}` : `${error.name} ${code}`
}

/**
 * Send a command, turning any failure into the contract's `service.unavailable`.
 *
 * This is the fail-closed rule of ADR 0016 in one place: when Redis cannot answer, the caller
 * gets an exception, never a made-up "allowed".
 *
 * @param redis - The client.
 * @param command - The command name.
 * @param args - Its arguments.
 * @returns The reply.
 * @throws ServiceUnavailableError when the command could not be completed.
 */
export async function call(
  redis: RedisCommands,
  command: string,
  args: string[]
): Promise<unknown> {
  try {
    return await redis.send(command, args)
  } catch (error) {
    // No `cause`: the error handler logs a cause's message, and this one is not ours.
    throw new ServiceUnavailableError({
      internalMessage: `redis ${command} failed: ${redisErrorReason(error)}`,
    })
  }
}

/**
 * Run a Lua script atomically.
 *
 * Redis runs a script to completion before any other command, which is what makes a
 * read-decide-write step safe when several API instances share the store.
 *
 * @param redis - The client.
 * @param script - The Lua source.
 * @param keys - Keys the script touches (`KEYS[n]`).
 * @param args - Other arguments (`ARGV[n]`).
 * @returns The script's reply.
 * @throws ServiceUnavailableError when the script could not be run.
 */
export function evalScript(
  redis: RedisCommands,
  script: string,
  keys: string[],
  args: string[]
): Promise<unknown> {
  return call(redis, 'EVAL', [script, String(keys.length), ...keys, ...args])
}

/**
 * Check that a reply is the list of integers a script promised.
 *
 * @param reply - The reply to check.
 * @param length - How many integers are expected.
 * @returns The integers.
 * @throws ServiceUnavailableError when the reply is anything else: a decision is never built
 *   from a reply we do not understand.
 */
export function integers(reply: unknown, length: number): number[] {
  if (
    !Array.isArray(reply) ||
    reply.length !== length ||
    !reply.every((value) => Number.isSafeInteger(value))
  ) {
    throw new ServiceUnavailableError({ internalMessage: 'redis sent an unexpected reply' })
  }
  return reply as number[]
}
