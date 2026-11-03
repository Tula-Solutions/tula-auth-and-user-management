import { describe, expect, spyOn, test } from 'bun:test'
import { join } from 'node:path'
import { DEFAULT_ENVIRONMENT_SETTINGS } from '@tula-tech/contract'
import { PROVIDER_TIMEOUT_MS } from '~/adapters/oauth/id-token'
import * as logger from '~/lib/logger'
import { SHUTDOWN_TIMEOUT_MS } from '~/lib/shutdown'
import * as Flows from '~/modules/flow/service'
import * as Hooks from '~/modules/hook/service'
import * as Notices from '~/modules/notice/service'
import * as SignInTests from '~/modules/sign-in-test/service'
import * as Sms from '~/modules/sms/service'
import { closeApi } from '~/server-close'
import { createTestDeps, TEST_ACTOR, TEST_TENANT } from '~/testing'
import { manualTimers } from '~/testing/manual-timers'

// What an API process ends, and in which order, on SIGTERM. Nothing runs `server.ts` in a
// test (it needs a database before it listens), so the order lives in `closeApi` and
// `server.ts` is read for the one call.

const TODAY = '2026-10-08'
const NUMBER = '+14155550142'
const SCOPE = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }

function setUp() {
  const deps = createTestDeps()
  deps.clock.set(new Date(`${TODAY}T09:00:00.000Z`))
  deps.environmentSettings.seed(SCOPE.environmentId, {
    revision: 1,
    settings: {
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      sms: { enabled: true, allowedCountries: ['US'], dailyMessageLimit: 500, templates: {} },
    },
  })
  return deps
}

function message(overrides: Partial<Sms.CodeMessage> = {}): Sms.CodeMessage {
  return {
    to: NUMBER,
    code: '482913',
    asker: { type: 'user', id: 'user-1' },
    kind: 'phone_verification',
    newNumber: false,
    address: '198.51.100.7',
    detached: true,
    ...overrides,
  }
}

describe('closeApi', () => {
  test('a texted code on its way out is sent, and stored, before the pool is closed', async () => {
    const deps = setUp()
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const send = spyOn(deps.sms, 'send').mockImplementation(async () => {
      await held
    })
    const order: string[] = []
    await Sms.sendCode(
      deps,
      SCOPE,
      message({
        onTaken: async () => {
          order.push('code stored')
        },
      })
    )

    const closed = closeApi({
      jobs: {
        stopTimers: () => {
          order.push('timers stopped')
        },
        finish: async () => {
          order.push('jobs finished')
        },
      },
      server: {
        // Bun's `stop()` resolves "once every connection is closed", and lets requests in
        // flight finish, only when it is not told to close them: never `stop(true)`.
        stop: async (...args: unknown[]) => {
          order.push(args.length === 0 ? 'server stopped' : 'server stopped abruptly')
        },
      },
      container: {
        close: async () => {
          order.push('pool closed')
        },
      },
    })
    // The send is still held: nothing after it may have happened yet.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(order).toEqual(['timers stopped', 'server stopped'])
    release()
    await closed
    expect(order).toEqual([
      'timers stopped',
      'server stopped',
      'code stored',
      'jobs finished',
      'pool closed',
    ])
    send.mockRestore()
  })

  test('a send the provider refuses is counted back out before the pool is closed', async () => {
    const deps = setUp()
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined)
    let answer: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      answer = resolve
    })
    deps.sms.failing = true
    const refuse = deps.sms.send.bind(deps.sms)
    const send = spyOn(deps.sms, 'send').mockImplementation(async (text) => {
      await held
      return refuse(text)
    })
    await Sms.sendCode(deps, SCOPE, message())
    expect(await deps.smsUsage.sentOn(SCOPE.environmentId, TODAY)).toBe(1)
    let countAtClose = -1
    const closed = closeApi({
      jobs: { stopTimers: () => undefined, finish: async () => undefined },
      server: { stop: async () => undefined },
      container: {
        close: async () => {
          countAtClose = await deps.smsUsage.sentOn(SCOPE.environmentId, TODAY)
        },
      },
    })
    answer()
    await closed
    expect(countAtClose).toBe(0)
    send.mockRestore()
    warn.mockRestore()
  })

  // TULA-67. What a hook's call came to is counted after the request was answered, and the
  // count is a write: a process that closed its pool first would lose it with an error.
  test('the count of a hook\u2019s call on its way to the store is written before the pool is closed', async () => {
    const deps = setUp()
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined)
    const receiver = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => Response.json({ decision: 'allow' }),
    })
    // Let go of in the `finally` too: a count left held by a failed assertion would keep
    // every later `Hooks.settled()` of the run waiting.
    let land: () => void = () => undefined
    try {
      await Hooks.create(
        deps,
        SCOPE,
        {
          point: 'before_session',
          url: `http://127.0.0.1:${receiver.port}/hook`,
          enabled: true,
          deadlineMs: 100,
          failureMode: 'deny',
        },
        TEST_ACTOR
      )
      const held = new Promise<void>((resolve) => {
        land = resolve
      })
      const order: string[] = []
      const count = spyOn(deps.hooks, 'countCall').mockImplementation(async () => {
        await held
        order.push('call counted')
      })
      expect(
        await Hooks.beforeSession(deps, SCOPE, {
          userId: '0199c2f4-7a10-7c3e-9b1a-5d2e8f4a6c01',
          client: 'web',
          profile: 'web',
          amr: ['pwd'],
          signUp: false,
          ipAddress: '203.0.113.7',
        })
      ).toBe('clear')
      const closed = closeApi({
        jobs: {
          stopTimers: () => undefined,
          finish: async () => {
            order.push('jobs finished')
          },
        },
        server: {
          stop: async () => {
            order.push('server stopped')
          },
        },
        container: {
          close: async () => {
            order.push('pool closed')
          },
        },
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(order).toEqual(['server stopped'])
      land()
      await closed
      expect(order).toEqual(['server stopped', 'call counted', 'jobs finished', 'pool closed'])
      count.mockRestore()
    } finally {
      land()
      await receiver.stop(true)
      warn.mockRestore()
    }
  })

  // ADR 0058. A step a sign-in test left at its time limit goes on after the run answered,
  // and the verification of a sign-up is a write: a process that closed its pool first
  // would run it against a pool that is gone.
  describe('a step a sign-in test left at its time limit', () => {
    const tenant = { ...SCOPE, apiKeyId: 'key_1' }
    const actor = { ...TEST_ACTOR, type: 'agent' as const }

    // The limits are kept by the test's own timers (`manualTimers`), so that a step is left at
    // its limit when the test says so and not when a loaded machine's password hash is slower
    // than a real 300 ms (TULA-133). Each limit has a delay of its own to be named by.
    const STEP_MS = 300
    const CLEANUP_MS = 50

    /** A run whose verification is held until `land()`, with what happened in `order`. */
    async function runWithHeldVerification() {
      const deps = createTestDeps()
      deps.environments.add({
        id: SCOPE.environmentId,
        projectId: SCOPE.projectId,
        kind: 'development',
        createdAt: deps.clock.now(),
      })
      const order: string[] = []
      let land: () => void = () => undefined
      const held = new Promise<void>((resolve) => {
        land = resolve
      })
      let entered: () => void = () => undefined
      const enteredVerification = new Promise<void>((resolve) => {
        entered = resolve
      })
      const real = Flows.verifyEmail
      const verify = spyOn(Flows, 'verifyEmail').mockImplementation(async (...args) => {
        entered()
        await held
        try {
          return await real(...args)
        } finally {
          order.push('late step ended')
        }
      })
      const quiet = (['error', 'warn', 'info'] as const).map((level) =>
        spyOn(logger, level).mockImplementation(() => undefined)
      )
      const timers = manualTimers()
      const running = SignInTests.run(deps, tenant, actor, {
        limits: { stepMs: STEP_MS, hookMs: 0, cleanupMs: CLEANUP_MS },
        after: timers.after,
      })
      // The verification is at work, and it is the only step with a pending limit: leave it.
      await enteredVerification
      timers.fire(STEP_MS)
      // The clean-up waits for the step it left, for its own limit: that runs out too.
      await timers.registered(CLEANUP_MS)
      timers.fire(CLEANUP_MS)
      const report = await running
      const restore = async () => {
        land()
        await SignInTests.settled()
        await Notices.settled()
        for (const spy of [verify, ...quiet]) {
          spy.mockRestore()
        }
      }
      return { order, report, land: () => land(), restore }
    }

    const closing = (order: string[]) =>
      closeApi({
        jobs: {
          stopTimers: () => undefined,
          finish: async () => {
            order.push('jobs finished')
          },
        },
        server: {
          stop: async () => {
            order.push('server stopped')
          },
        },
        container: {
          close: async () => {
            order.push('pool closed')
          },
        },
      })

    test('ends before the pool is closed', async () => {
      const run = await runWithHeldVerification()
      try {
        expect(run.report).toMatchObject({ outcome: 'failed', cleanup: 'failed' })
        const closed = closing(run.order)
        // A turn of the event loop: enough for the listener's stop to be recorded, and for
        // anything that would end the wait early (nothing does, short of the bound's own
        // seconds) to show itself.
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(run.order).toEqual(['server stopped'])
        run.land()
        await closed
        expect(run.order).toEqual([
          'server stopped',
          'late step ended',
          'jobs finished',
          'pool closed',
        ])
      } finally {
        await run.restore()
      }
    })

    test('one that never ends holds a shutdown for its bound and no longer', async () => {
      const run = await runWithHeldVerification()
      try {
        // The bound is a timer of the test's: the wait is over when it goes off and not before,
        // however long the step stays at work.
        const bound = manualTimers()
        let over = false
        const waiting = SignInTests.settled(60, bound.after).then(() => {
          over = true
        })
        await bound.registered(60)
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(over).toBe(false)
        expect(bound.fire(60)).toBe(1)
        await waiting
        expect(over).toBe(true)
        expect(run.order).toEqual([])
      } finally {
        await run.restore()
      }
    })

    test('the bound is below the shutdown timeout and no longer than a step’s limit', () => {
      expect(SignInTests.SIGN_IN_TEST_SETTLE_MS).toBeLessThan(SHUTDOWN_TIMEOUT_MS)
      expect(SignInTests.SIGN_IN_TEST_SETTLE_MS).toBeLessThanOrEqual(
        SignInTests.SIGN_IN_TEST_STEP_MS
      )
    })
  })

  test('server.ts closes through closeApi and ends nothing by itself', async () => {
    const source = await Bun.file(join(import.meta.dir, 'server.ts')).text()
    expect(source).toContain('shutdownOnSignal(() => closeApi({ jobs, server, container }))')
    expect(source).not.toMatch(/container\.close\(|server\.stop\(|jobs\.finish\(/)
  })

  // The worker serves no flow route, so it never starts a text message: it has nothing of
  // this to wait for, and must not gain the import.
  test('worker.ts imports neither the SMS service nor closeApi', async () => {
    const source = await Bun.file(join(import.meta.dir, 'worker.ts')).text()
    const imported = new Bun.Transpiler({ loader: 'ts' })
      .scan(source)
      .imports.map((entry) => entry.path)
    expect(imported).not.toContain('~/modules/sms/service')
    expect(imported).not.toContain('~/server-close')
  })

  // The two numbers are equal, so a send that runs to its own deadline is not waited out:
  // the shutdown timer ends the process first. What that leaves is what a killed process
  // leaves: possibly a day's count one higher than what was sent, possibly a delivered text
  // whose code was never stored. Both err the safe way. A send deadline longer than the
  // shutdown timeout would make that the outcome of sends that do get an answer in time.
  test('the deadline of a send is not longer than the shutdown timeout', () => {
    expect(PROVIDER_TIMEOUT_MS).toBeLessThanOrEqual(SHUTDOWN_TIMEOUT_MS)
  })
})
