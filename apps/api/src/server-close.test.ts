import { describe, expect, spyOn, test } from 'bun:test'
import { join } from 'node:path'
import { DEFAULT_ENVIRONMENT_SETTINGS } from '@tula/contract'
import { PROVIDER_TIMEOUT_MS } from '~/adapters/oauth/id-token'
import * as logger from '~/lib/logger'
import { SHUTDOWN_TIMEOUT_MS } from '~/lib/shutdown'
import * as Sms from '~/modules/sms/service'
import { closeApi } from '~/server-close'
import { createTestDeps, TEST_TENANT } from '~/testing'

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
      sms: { enabled: true, allowedCountries: ['US'], dailyMessageLimit: 500 },
    },
  })
  return deps
}

function message(overrides: Partial<Sms.CodeMessage> = {}): Sms.CodeMessage {
  return {
    to: NUMBER,
    code: '482913',
    asker: { type: 'user', id: 'user-1' },
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
  // the shutdown timer ends the process first. Such a send is `unconfirmed` either way (the
  // day's count kept, no code stored), which is the state a killed process leaves. A longer
  // send deadline would change that for sends that do get an answer.
  test('the deadline of a send is not longer than the shutdown timeout', () => {
    expect(PROVIDER_TIMEOUT_MS).toBeLessThanOrEqual(SHUTDOWN_TIMEOUT_MS)
  })
})
