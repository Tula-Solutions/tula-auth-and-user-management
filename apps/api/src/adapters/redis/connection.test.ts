import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test'
import { FixedClock } from '~/adapters/memory/clock'
import { redisErrorReason } from '~/adapters/redis/commands'
import {
  connectRedis,
  REDIS_RECONNECT_PAUSE_MS,
  RedisConnection,
  type RedisDriver,
  redisProbe,
} from '~/adapters/redis/connection'
import { FakeRedis } from '~/adapters/redis/fake'
import * as logger from '~/lib/logger'

const closed = () => Object.assign(new Error('Connection closed'), { code: 'ERR_CLOSED' })

/** A driver that behaves like Bun's client with queueing and auto-reconnect switched off. */
class ScriptedDriver implements RedisDriver {
  connected = false
  onconnect: (() => void) | null = null
  onclose: ((error: Error) => void) | null = null
  /** Whether the server can be reached. */
  reachable = true
  /** When set, `connect` and `send` never settle. */
  hung = false
  connects = 0
  sent: string[] = []

  async connect(): Promise<void> {
    this.connects += 1
    if (this.hung) {
      return new Promise<void>(() => {})
    }
    // Yield first, so callers that arrive together overlap as they do on a real socket.
    await Promise.resolve()
    if (!this.reachable) {
      this.onclose?.(closed())
      throw closed()
    }
    this.connected = true
    this.onconnect?.()
  }

  async send(command: string): Promise<unknown> {
    if (this.hung) {
      return new Promise<unknown>(() => {})
    }
    if (!this.connected) {
      throw closed()
    }
    this.sent.push(command)
    return 'PONG'
  }

  close(): void {
    this.connected = false
    this.onclose?.(closed())
  }

  /** The server went away. */
  drop(): void {
    this.connected = false
    this.reachable = false
    this.onclose?.(closed())
  }
}

function setup(options: { timeoutMs?: number } = {}) {
  const clock = new FixedClock()
  const driver = new ScriptedDriver()
  const connection = new RedisConnection(driver, clock, options)
  return { clock, driver, connection }
}

function reason(work: Promise<unknown>): Promise<string> {
  return work.then(
    () => 'no error',
    (error: unknown) => redisErrorReason(error)
  )
}

describe('RedisConnection', () => {
  let info: Mock<typeof logger.info>
  let warn: Mock<typeof logger.warn>

  beforeEach(() => {
    info = spyOn(logger, 'info').mockImplementation(() => {})
    warn = spyOn(logger, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    info.mockRestore()
    warn.mockRestore()
  })

  test('opens nothing until the first command, then connects once', async () => {
    const { driver, connection } = setup()
    expect(driver.connects).toBe(0)
    expect(await connection.send('PING', [])).toBe('PONG')
    expect(await connection.send('PING', [])).toBe('PONG')
    expect(driver.connects).toBe(1)
    expect(info.mock.calls).toEqual([['redis connected']])
  })

  test('commands that arrive together share one connection attempt', async () => {
    const { driver, connection } = setup()
    const replies = await Promise.all(Array.from({ length: 20 }, () => connection.send('PING', [])))
    expect(replies.every((reply) => reply === 'PONG')).toBe(true)
    expect(driver.connects).toBe(1)
  })

  test('refuses at once while the server is down, trying again only after a pause', async () => {
    const { clock, driver, connection } = setup()
    driver.reachable = false
    expect(await reason(connection.send('PING', []))).toBe('Error ERR_CLOSED')
    // Within the pause nothing is attempted: the command is refused straight away.
    for (let i = 0; i < 50; i++) {
      expect(await reason(connection.send('PING', []))).toBe('RedisUnreachable')
    }
    expect(driver.connects).toBe(1)
    clock.advance(REDIS_RECONNECT_PAUSE_MS)
    expect(await reason(connection.send('PING', []))).toBe('Error ERR_CLOSED')
    expect(driver.connects).toBe(2)
    expect(driver.sent).toEqual([])
  })

  test('recovers by itself when the server comes back', async () => {
    const { clock, driver, connection } = setup()
    await connection.send('PING', [])
    driver.drop()
    expect(await reason(connection.send('PING', []))).toBe('Error ERR_CLOSED')
    driver.reachable = true
    // Still inside the pause.
    expect(await reason(connection.send('PING', []))).toBe('RedisUnreachable')
    clock.advance(REDIS_RECONNECT_PAUSE_MS)
    expect(await connection.send('PING', [])).toBe('PONG')
    expect(driver.connects).toBe(3)
  })

  test('a connection that never opens times out', async () => {
    const { driver, connection } = setup({ timeoutMs: 5 })
    driver.hung = true
    expect(await reason(connection.send('PING', []))).toBe('RedisTimeout')
    expect(await reason(connection.send('PING', []))).toBe('RedisUnreachable')
  })

  test('a command the server never answers times out', async () => {
    const { driver, connection } = setup({ timeoutMs: 5 })
    await connection.send('PING', [])
    driver.hung = true
    expect(await reason(connection.send('PING', []))).toBe('RedisTimeout')
  })

  test('logs a lost connection by error name and code only', async () => {
    const { driver, connection } = setup()
    await connection.send('PING', [])
    driver.onclose?.(
      Object.assign(new Error('lost redis://:hunter2@cache.internal:6379'), { code: 'ECONNRESET' })
    )
    expect(warn.mock.calls).toEqual([['redis connection closed', { reason: 'Error ECONNRESET' }]])
  })

  test('closing on purpose is not reported as a lost connection', async () => {
    const { driver, connection } = setup()
    await connection.send('PING', [])
    connection.close()
    expect(driver.connected).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('connectRedis', () => {
  test('builds a connection without opening it', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    // Nothing listens on port 1: a connection attempt here would be refused.
    const connection = connectRedis('redis://127.0.0.1:1', new FixedClock())
    expect(connection).toBeInstanceOf(RedisConnection)
    connection.close()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('redisProbe', () => {
  test('passes while Redis answers and is named redis', async () => {
    const probe = redisProbe(new FakeRedis(new FixedClock()))
    expect(probe.name).toBe('redis')
    await probe.check()
  })

  test('fails with the error name and code, not its message', async () => {
    const redis = new FakeRedis(new FixedClock())
    redis.fail(
      Object.assign(new Error('NOAUTH redis://:hunter2@cache.internal:6379'), { code: 'E_AUTH' })
    )
    await expect(redisProbe(redis).check()).rejects.toThrow(new Error('Error E_AUTH'))
  })
})
