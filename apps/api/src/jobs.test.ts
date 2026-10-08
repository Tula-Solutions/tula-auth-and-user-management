import { afterEach, describe, expect, type Mock, spyOn, test } from 'bun:test'
import { join } from 'node:path'
import { bootJobs, type JobTimers, startJobs } from '~/jobs'
import * as logger from '~/lib/logger'
import * as Retention from '~/modules/retention/service'
import * as Webhooks from '~/modules/webhook/service'
import { planProcess } from '~/process'
import { createTestDeps } from '~/testing'

// The one place a background job is put on a timer, for the API (`server.ts`) and for the
// worker (`worker.ts`) alike. The timers are the test's: nothing here waits for a clock.

interface Ticking {
  fn: () => void
  ms: number
  cleared: boolean
}

function fakeTimers() {
  const started: Ticking[] = []
  const timers: JobTimers = {
    setInterval: (fn, ms) => {
      const timer = { fn, ms, cleared: false }
      started.push(timer)
      return timer
    },
    clearInterval: (timer) => {
      ;(timer as Ticking).cleared = true
    },
  }
  return { timers, started }
}

let spies: Mock<(...args: never[]) => unknown>[] = []
afterEach(() => {
  for (const spy of spies) {
    spy.mockRestore()
  }
  spies = []
})

function stubs() {
  const retention = spyOn(Retention, 'run').mockResolvedValue(null)
  const delivery = spyOn(Webhooks, 'run').mockResolvedValue(null)
  spies.push(retention, delivery)
  return { retention, delivery }
}

/** Let the promise chains of a round that has settled run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('startJobs', () => {
  test('an API instance that delivers runs both jobs at once and on their own timers', async () => {
    const { retention, delivery } = stubs()
    const { timers, started } = fakeTimers()
    const deps = createTestDeps()
    const jobs = startJobs(deps, planProcess('api', 'api').jobs, timers)
    expect(retention).toHaveBeenCalledTimes(1)
    expect(delivery).toHaveBeenCalledTimes(1)
    expect(started.map((timer) => timer.ms).sort((a, b) => a - b)).toEqual([5_000, 600_000])
    expect(retention.mock.calls[0]?.[0]).toBe(deps)
    expect(delivery.mock.calls[0]?.[0]).toBe(deps)
    await jobs.finish()
  })

  test('an API instance whose worker is separate starts no delivery round and no delivery timer', async () => {
    const { retention, delivery } = stubs()
    const { timers, started } = fakeTimers()
    const jobs = startJobs(createTestDeps(), planProcess('api', 'separate').jobs, timers)
    expect(retention).toHaveBeenCalledTimes(1)
    expect(started.map((timer) => timer.ms)).toEqual([600_000])
    for (const timer of started) {
      timer.fn()
    }
    await settle()
    expect(retention).toHaveBeenCalledTimes(2)
    expect(delivery).not.toHaveBeenCalled()
    await jobs.finish()
  })

  test('a worker runs delivery rounds on the same five-second timer and never retention', async () => {
    const { retention, delivery } = stubs()
    const { timers, started } = fakeTimers()
    const jobs = startJobs(createTestDeps(), planProcess('worker', 'separate').jobs, timers)
    expect(delivery).toHaveBeenCalledTimes(1)
    expect(started.map((timer) => timer.ms)).toEqual([Webhooks.WEBHOOK_DELIVERY_INTERVAL_MS])
    await settle()
    started[0]?.fn()
    await settle()
    expect(delivery).toHaveBeenCalledTimes(2)
    expect(retention).not.toHaveBeenCalled()
    await jobs.finish()
  })

  test('a round still running when the timer fires is not started a second time', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<null>((resolve) => {
      release = () => resolve(null)
    })
    const delivery = spyOn(Webhooks, 'run').mockImplementation(() => gate)
    spies.push(delivery)
    const { timers, started } = fakeTimers()
    const jobs = startJobs(createTestDeps(), ['webhook_delivery'], timers)
    started[0]?.fn()
    started[0]?.fn()
    expect(delivery).toHaveBeenCalledTimes(1)
    release()
    await settle()
    started[0]?.fn()
    expect(delivery).toHaveBeenCalledTimes(2)
    await jobs.finish()
  })

  test('a round that fails is logged with the job’s name and the next one still runs', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined)
    const delivery = spyOn(Webhooks, 'run').mockRejectedValue(new Error('database is down'))
    const retention = spyOn(Retention, 'run').mockRejectedValue(new Error('database is down'))
    spies.push(warn, delivery, retention)
    const { timers, started } = fakeTimers()
    const jobs = startJobs(createTestDeps(), ['retention', 'webhook_delivery'], timers)
    await settle()
    expect(warn.mock.calls.map((call) => call[0]).sort()).toEqual([
      'could not run the retention job',
      'could not run the webhook delivery job',
    ])
    for (const timer of started) {
      timer.fn()
    }
    await settle()
    expect(delivery).toHaveBeenCalledTimes(2)
    expect(retention).toHaveBeenCalledTimes(2)
    await jobs.finish()
  })

  test('stopping: the timers end first; finishing aborts the round’s signal and waits for the round', async () => {
    let seen: AbortSignal | undefined
    let release: () => void = () => undefined
    const gate = new Promise<null>((resolve) => {
      release = () => resolve(null)
    })
    const delivery = spyOn(Webhooks, 'run').mockImplementation((_deps, signal) => {
      seen = signal
      return gate
    })
    spies.push(delivery, spyOn(Retention, 'run').mockResolvedValue(null))
    const { timers, started } = fakeTimers()
    const jobs = startJobs(createTestDeps(), ['retention', 'webhook_delivery'], timers)
    expect(seen?.aborted).toBe(false)

    jobs.stopTimers()
    expect(started.map((timer) => timer.cleared)).toEqual([true, true])
    // The round under way is not cut off by that: it is told only when the caller is ready.
    expect(seen?.aborted).toBe(false)

    let finished = false
    const finishing = jobs.finish().then(() => {
      finished = true
    })
    await settle()
    expect(seen?.aborted).toBe(true)
    // Not before the round has recorded what it sent.
    expect(finished).toBe(false)
    release()
    await finishing
    expect(finished).toBe(true)
  })

  test('after finishing, a timer that fires late starts nothing', async () => {
    const { delivery, retention } = stubs()
    const { timers, started } = fakeTimers()
    const jobs = startJobs(createTestDeps(), ['retention', 'webhook_delivery'], timers)
    await jobs.finish()
    for (const timer of started) {
      timer.fn()
    }
    await settle()
    expect(delivery).toHaveBeenCalledTimes(1)
    expect(retention).toHaveBeenCalledTimes(1)
  })

  test('with no round under way, finishing returns at once', async () => {
    stubs()
    const { timers } = fakeTimers()
    const jobs = startJobs(createTestDeps(), ['webhook_delivery'], timers)
    await settle()
    await jobs.finish()
  })
})

// What the two entrypoints call. A process that starts jobs its plan does not name is the
// bug the plan exists to rule out: an API instance under `WEBHOOK_WORKER=separate` with a
// delivery timer after all.
describe('bootJobs: a process starts the jobs of its plan, and no others', () => {
  test.each([
    ['an API instance that delivers', 'api', 'api', [5_000, 600_000], 1, 1],
    ['an API instance whose worker is separate', 'api', 'separate', [600_000], 1, 0],
    ['a worker', 'worker', 'separate', [5_000], 0, 1],
  ] as const)('%s', async (_name, role, mode, intervals, retentions, deliveries) => {
    const { retention, delivery } = stubs()
    const { timers, started } = fakeTimers()
    const deps = createTestDeps()
    const jobs = bootJobs({ deps, plan: planProcess(role, mode) }, timers)
    expect(started.map((timer) => timer.ms).sort((a, b) => a - b)).toEqual([...intervals])
    expect(retention).toHaveBeenCalledTimes(retentions)
    expect(delivery).toHaveBeenCalledTimes(deliveries)
    await jobs.finish()
  })

  // Nothing runs `server.ts` in a test (it needs a database before it listens), so what it
  // hands the scheduler is held here: the container it built, whole, and nothing of its own.
  test.each(['server.ts', 'worker.ts'])(
    '%s starts its jobs through bootJobs(container), and names no job itself',
    async (file) => {
      const source = await Bun.file(join(import.meta.dir, file)).text()
      const imported = new Bun.Transpiler({ loader: 'ts' })
        .scan(source)
        .imports.map((entry) => entry.path)
      expect(imported).toContain('~/jobs')
      expect(source.match(/\bbootJobs\(([^)]*)\)/g)).toEqual(['bootJobs(container)'])
      expect(source).not.toContain('startJobs')
      expect(source).not.toMatch(/setInterval|setTimeout/)
      expect(source).not.toMatch(/['"](retention|webhook_delivery)['"]/)
    }
  )
})
