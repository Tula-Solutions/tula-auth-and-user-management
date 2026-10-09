import { afterEach, describe, expect, type Mock, spyOn, test } from 'bun:test'
import * as logger from '~/lib/logger'
import { SHUTDOWN_TIMEOUT_MS, shutdownOnSignal } from '~/lib/shutdown'

// The signal handlers are captured, never installed: a test must not change what SIGTERM
// does to the test runner, and `process.exit` is a stub. The shutdown timer is captured
// too: left running, it would end the test runner ten seconds later.

let spies: Mock<(...args: never[]) => unknown>[] = []
afterEach(() => {
  for (const spy of spies) {
    spy.mockRestore()
  }
  spies = []
})

function captured() {
  const handlers = new Map<string, () => void>()
  const once = spyOn(process, 'once').mockImplementation(((signal: string, fn: () => void) => {
    handlers.set(signal, fn)
    return process
  }) as never)
  const exits: number[] = []
  const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exits.push(code ?? 0)
  }) as never)
  const info = spyOn(logger, 'info').mockImplementation(() => undefined)
  const error = spyOn(logger, 'error').mockImplementation(() => undefined)
  const timers: { fn: () => void; ms: number }[] = []
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((
    fn: () => void,
    ms: number
  ) => {
    timers.push({ fn, ms })
    return { unref: () => undefined }
  }) as never)
  spies.push(once, exit, info, error, timer)
  return { handlers, exits, error, timers }
}

/** Let the handler's promise chain run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('shutdownOnSignal', () => {
  test('listens for SIGTERM and SIGINT, closes, and exits 0', async () => {
    const { handlers, exits } = captured()
    let closed = 0
    shutdownOnSignal(async () => {
      closed += 1
    })
    expect([...handlers.keys()].sort()).toEqual(['SIGINT', 'SIGTERM'])
    expect(closed).toBe(0)
    handlers.get('SIGTERM')?.()
    await settle()
    expect(closed).toBe(1)
    expect(exits).toEqual([0])
  })

  test('a close that throws exits 1 and logs the reason, not the error', async () => {
    const { handlers, exits, error } = captured()
    shutdownOnSignal(async () => {
      throw new Error('the pool would not close')
    })
    handlers.get('SIGINT')?.()
    await settle()
    expect(exits).toEqual([1])
    expect(error.mock.calls.map(([message]) => message)).toEqual(['shutdown failed'])
  })

  test('a close that does not end is cut off at the timeout, with exit 1', async () => {
    const { handlers, exits, error, timers } = captured()
    shutdownOnSignal(() => new Promise<void>(() => undefined))
    handlers.get('SIGTERM')?.()
    await settle()
    expect(exits).toEqual([])
    expect(timers.map((timer) => timer.ms)).toEqual([SHUTDOWN_TIMEOUT_MS])
    timers[0]?.fn()
    expect(exits).toEqual([1])
    expect(error.mock.calls.map(([message]) => message)).toEqual(['shutdown timed out; exiting'])
  })
})
