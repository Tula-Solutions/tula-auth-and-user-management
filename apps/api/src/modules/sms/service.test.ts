import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { DEFAULT_ENVIRONMENT_SETTINGS, type EnvironmentSettings } from '@tula/contract'
import { RateLimitError, ServiceUnavailableError } from '~/exceptions'
import { sha256Hex } from '~/lib/crypto'
import * as logger from '~/lib/logger'
import * as Sms from '~/modules/sms/service'
import { createTestDeps, TEST_TENANT, type TestDeps } from '~/testing'

// The one path a text message takes (ADR 0037): the settings, the sender, the limits, the
// daily limit, the send. Each limit has a test here that fails when the limit is taken out.

const TODAY = '2026-10-08'

const SCOPE: { projectId: string; environmentId: string } = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
}
const OTHER = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.productionEnvironmentId,
}
const CODE = '482913'

let deps: TestDeps
let revision = 0
let serial = 0

function configure(
  sms: Partial<EnvironmentSettings['sms']> = {},
  environmentId: string = SCOPE.environmentId
) {
  revision += 1
  deps.environmentSettings.seed(environmentId, {
    revision,
    settings: {
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      sms: { enabled: true, allowedCountries: ['US', 'DE', 'FR'], dailyMessageLimit: 500, ...sms },
    },
  })
}

beforeEach(() => {
  // Mid-morning, so that an hour or two forward stays inside one UTC day.
  deps = createTestDeps()
  deps.clock.set(new Date('2026-10-08T09:00:00.000Z'))
  configure()
  configure({}, OTHER.environmentId)
})

/** A United States number (destination prefix `+1`). */
const number = (area: number, line: number, exchange = 555) =>
  `+1${area}${exchange}${String(line).padStart(4, '0')}`

/** A German number (`+49`) and a French one (`+33`): other destinations. */
const german = (line: number) => `+4915112${String(line).padStart(6, '0')}`
const french = (line: number) => `+33612${String(line).padStart(6, '0')}`

/** An asker, a number and an address nobody has used: nothing of an earlier send limits it. */
function fresh(overrides: Partial<Sms.CodeMessage> = {}): Sms.CodeMessage {
  serial += 1
  return {
    to: number(202, serial % 10_000, 200 + (serial % 70) * 10),
    code: CODE,
    asker: { type: 'user', id: `user-${serial}` },
    newNumber: false,
    address: `198.51.${serial % 250}.${(serial * 7) % 250}`,
    ...overrides,
  }
}

/** How many codes the environment has counted as sent today. */
const sentToday = (scope = SCOPE) => deps.smsUsage.sentOn(scope.environmentId, TODAY)

/** Count `times` codes as already sent today to `prefix`, past every limit. */
async function counted(prefix: string, times: number) {
  for (let i = 0; i < times; i += 1) {
    await deps.smsUsage.takeFromDay(SCOPE, TODAY, prefix, 1_000_000, deps.clock.now())
  }
}

const send = (message: Sms.CodeMessage, scope = SCOPE) => Sms.sendCode(deps, scope, message)

/** What a send did: `sent`, or the code and status it was refused with. */
async function outcome(message: Sms.CodeMessage, scope = SCOPE): Promise<string> {
  try {
    await send(message, scope)
    return 'sent'
  } catch (error) {
    const { code, status } = error as { code?: string; status?: number }
    return `${code} ${status}`
  }
}

const LIMITED = 'rate_limited 429'

describe('a code that may be sent', () => {
  test('is texted in the environment’s words, and counted for its prefix', async () => {
    await send(fresh({ to: '+14155550142' }))
    expect(deps.sms.outbox.map(({ to }) => to)).toEqual(['+14155550142'])
    expect(deps.sms.last().text).toContain(CODE)
    expect(await deps.smsUsage.summary(SCOPE.environmentId, TODAY, 10)).toEqual({
      sent: 1,
      used: 0,
      prefixes: [{ prefix: '+1', sent: 1, used: 0 }],
      truncated: false,
    })
  })
})

describe('the order: settings, sender, limits, daily limit, send', () => {
  test.each([
    ['SMS switched off', { enabled: false }, '+14155550142', 'sms.disabled 403'],
    ['no country allowed', { allowedCountries: [] }, '+14155550142', 'sms.disabled 403'],
    ['a country not on the list', {}, '+447911123456', 'sms.country_not_allowed 422'],
    ['a calling code no country has', {}, '+99912345678', 'sms.country_not_allowed 422'],
  ])('%s: nothing is counted, and nothing is sent', async (_name, sms, to, refusal) => {
    configure(sms)
    const hit = spyOn(deps.rateLimiter, 'hit')
    const read = spyOn(deps.smsUsage, 'takeFromDay')
    expect(await outcome(fresh({ to }))).toBe(refusal)
    expect(hit).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    hit.mockRestore()
    read.mockRestore()
    expect(deps.sms.outbox).toEqual([])
    expect(await sentToday()).toBe(0)
  })

  test('no sender: refused after the settings, and before any limit is counted', async () => {
    deps.sms.configured = false
    const hit = spyOn(deps.rateLimiter, 'hit')
    expect(await outcome(fresh())).toBe('sms.unavailable 503')
    // What the environment refuses is still said first.
    expect(await outcome(fresh({ to: '+447911123456' }))).toBe('sms.country_not_allowed 422')
    expect(hit).not.toHaveBeenCalled()
    hit.mockRestore()
    expect(await sentToday()).toBe(0)
  })

  test('the limits are counted from the narrowest to the widest, the day last, then the send', async () => {
    const steps: string[] = []
    const hit = deps.rateLimiter.hit.bind(deps.rateLimiter)
    const limiter = spyOn(deps.rateLimiter, 'hit').mockImplementation((key, ...rest) => {
      steps.push(key.slice(0, key.indexOf(':')))
      return hit(key, ...rest)
    })
    const takeFromDay = deps.smsUsage.takeFromDay.bind(deps.smsUsage)
    const record = spyOn(deps.smsUsage, 'takeFromDay').mockImplementation((...args) => {
      steps.push('day: taken')
      return takeFromDay(...args)
    })
    const deliver = deps.sms.send.bind(deps.sms)
    const sender = spyOn(deps.sms, 'send').mockImplementation((message) => {
      steps.push('send')
      return deliver(message)
    })
    await send(fresh({ newNumber: true }))
    for (const spy of [limiter, record, sender]) {
      spy.mockRestore()
    }
    expect(steps).toEqual([
      'sms_asker_cooldown',
      'sms_asker',
      'sms_asker_new_number',
      'sms_number_cooldown',
      'sms_number',
      'sms_address',
      'sms_prefix',
      'sms_environment',
      'day: taken',
      'send',
    ])
  })

  test('a send a narrow limit refuses is not counted against the wider ones, or the day', async () => {
    const message = fresh()
    await send(message)
    const hit = spyOn(deps.rateLimiter, 'hit')
    const read = spyOn(deps.smsUsage, 'takeFromDay')
    // The same asker within the minute.
    expect(await outcome({ ...fresh(), asker: message.asker })).toBe(LIMITED)
    expect(hit.mock.calls.map(([key]) => key.slice(0, key.indexOf(':')))).toEqual([
      'sms_asker_cooldown',
    ])
    expect(read).not.toHaveBeenCalled()
    hit.mockRestore()
    read.mockRestore()
    expect(await sentToday()).toBe(1)
  })

  // Accepted, and pinned so that nobody "fixes" it (ADR 0037, "Narrow limits are counted
  // first"): counting the wide limits first would let one asker's refused tries use up the
  // allowance every user of the environment shares.
  describe('narrow limits are counted before wide ones: a send a wide limit refuses still costs the asker', () => {
    const asker = { type: 'user', id: 'maya' } as const

    /** Which limit refused each send, in order: the word in the operator's log. */
    async function refusedBy(work: () => Promise<void>): Promise<string[]> {
      const limits: string[] = []
      // A narrow limit is said as information and a wide one as a warning: one list of both.
      const note = (_message: string, fields?: object) => {
        limits.push((fields as { limit: string }).limit)
      }
      const info = spyOn(logger, 'info').mockImplementation(note)
      const warn = spyOn(logger, 'warn').mockImplementation(note)
      await work()
      info.mockRestore()
      warn.mockRestore()
      return limits
    }

    /** The environment's day is spent, and nothing of the limiter is. */
    async function spentDay() {
      configure({ dailyMessageLimit: 400 })
      await counted('+49', 400)
    }

    test('their minute', async () => {
      await spentDay()
      expect(
        await refusedBy(async () => {
          expect(await outcome(fresh({ asker }))).toBe(LIMITED)
          // At once, with the day reopened: it is the asker's own minute that refuses now.
          configure({ dailyMessageLimit: 1000 })
          expect(await outcome(fresh({ asker }))).toBe(LIMITED)
        })
      ).toEqual(['daily', 'asker'])
      expect(deps.sms.outbox).toEqual([])
      deps.clock.advance('1m')
      expect(await outcome(fresh({ asker }))).toBe('sent')
    })

    test('one of their hour’s tries', async () => {
      await spentDay()
      expect(
        await refusedBy(async () => {
          for (let i = 0; i < Sms.SMS_ASKER_PER_HOUR; i += 1) {
            expect(await outcome(fresh({ asker }))).toBe(LIMITED)
            deps.clock.advance('1m')
          }
          // The minute has passed and the day is reopened: the hour's tries are all gone,
          // on sends of which none went out.
          configure({ dailyMessageLimit: 1000 })
          expect(await outcome(fresh({ asker }))).toBe(LIMITED)
        })
      ).toEqual([...Array.from({ length: Sms.SMS_ASKER_PER_HOUR }, () => 'daily'), 'asker'])
      expect(deps.sms.outbox).toEqual([])
      // Somebody else was not charged for them.
      expect(await outcome(fresh())).toBe('sent')
    })

    test('one of their day’s new numbers', async () => {
      await spentDay()
      expect(
        await refusedBy(async () => {
          for (let i = 0; i < Sms.SMS_NEW_NUMBERS_PER_DAY; i += 1) {
            expect(await outcome(fresh({ asker, newNumber: true }))).toBe(LIMITED)
            deps.clock.advance('2h')
          }
          configure({ dailyMessageLimit: 1000 })
          expect(await outcome(fresh({ asker, newNumber: true }))).toBe(LIMITED)
        })
      ).toEqual([
        ...Array.from({ length: Sms.SMS_NEW_NUMBERS_PER_DAY }, () => 'daily'),
        'new_number',
      ])
      expect(deps.sms.outbox).toEqual([])
      // A number that is not new to them still goes out.
      deps.clock.advance('2h')
      expect(await outcome(fresh({ asker, newNumber: false }))).toBe('sent')
    })

    test('and the wide limits are not counted for a send a narrow one refused', async () => {
      const first = fresh({ asker })
      await send(first)
      const hit = spyOn(deps.rateLimiter, 'hit')
      const take = spyOn(deps.smsUsage, 'takeFromDay')
      expect(await outcome(fresh({ asker }))).toBe(LIMITED)
      expect(hit.mock.calls.map(([key]) => key.slice(0, key.indexOf(':')))).toEqual([
        'sms_asker_cooldown',
      ])
      expect(take).not.toHaveBeenCalled()
      hit.mockRestore()
      take.mockRestore()
    })
  })

  test('a message the sender does not take is sms.unavailable, and is taken back out of the counts', async () => {
    configure({ dailyMessageLimit: 1 })
    deps.sms.failing = true
    const warn = spyOn(logger, 'warn')
    expect(await outcome(fresh())).toBe('sms.unavailable 503')
    expect(warn.mock.calls).toEqual([
      ['text message not sent', { environmentId: SCOPE.environmentId, reason: 'failed' }],
    ])
    warn.mockRestore()
    expect(await sentToday()).toBe(0)
    expect((await deps.smsUsage.summary(SCOPE.environmentId, TODAY, 10)).prefixes).toEqual([
      { prefix: '+1', sent: 0, used: 0 },
    ])
    // It did not spend the day's one message: the next hour's send goes out.
    deps.sms.failing = false
    deps.clock.advance('1h')
    expect(await outcome(fresh())).toBe('sent')
  })

  test('a failed send that cannot be taken back out is still sms.unavailable', async () => {
    deps.sms.failing = true
    const record = spyOn(deps.smsUsage, 'recordNotSent').mockRejectedValue(new Error('db down'))
    const warn = spyOn(logger, 'warn')
    expect(await outcome(fresh())).toBe('sms.unavailable 503')
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      'text message not sent',
      'text message not counted',
    ])
    warn.mockRestore()
    record.mockRestore()
    // One too high: the side that sends less.
    expect(await sentToday()).toBe(1)
  })
})

describe('counts that cannot count', () => {
  test.each([
    ['the database is not there', new Error('connection to db.internal:5432 refused')],
    // What Postgres says when the environment's turn did not come within the wait.
    ['its turn does not come', new Error('canceling statement due to lock timeout')],
  ])('the day cannot be taken (%s): nothing is sent', async (_name, error) => {
    const failing = spyOn(deps.smsUsage, 'takeFromDay').mockRejectedValue(error)
    const warn = spyOn(logger, 'warn')
    expect(await outcome(fresh())).toBe('service.unavailable 503')
    expect(warn.mock.calls).toEqual([
      [
        'text message not sent',
        { environmentId: SCOPE.environmentId, reason: 'not_counted', err: expect.any(String) },
      ],
    ])
    warn.mockRestore()
    failing.mockRestore()
    expect(deps.sms.outbox).toEqual([])
  })

  test('a store that says so itself is passed on as it is', async () => {
    const failing = spyOn(deps.smsUsage, 'takeFromDay').mockRejectedValue(
      new ServiceUnavailableError()
    )
    expect(await outcome(fresh())).toBe('service.unavailable 503')
    failing.mockRestore()
    expect(deps.sms.outbox).toEqual([])
    expect(await sentToday()).toBe(0)
  })

  test('the send path takes no environment lock: a lock that cannot be had stops nothing', async () => {
    // The lock's holder keeps a database connection while its work needs another; on a path
    // every signed-in user reaches, enough sends at once would leave them all waiting.
    const lock = spyOn(deps.environmentLock, 'runExclusive').mockRejectedValue(
      new ServiceUnavailableError()
    )
    expect(await outcome(fresh())).toBe('sent')
    expect(lock).not.toHaveBeenCalled()
    lock.mockRestore()
  })
})

describe('per asker', () => {
  const asker = { type: 'user', id: 'maya' } as const

  test('one a minute', async () => {
    expect(await outcome(fresh({ asker }))).toBe('sent')
    deps.clock.advance(59_999)
    expect(await outcome(fresh({ asker }))).toBe(LIMITED)
    deps.clock.advance(1)
    expect(await outcome(fresh({ asker }))).toBe('sent')
    expect(deps.sms.outbox).toHaveLength(2)
  })

  test(`${Sms.SMS_ASKER_PER_HOUR} an hour`, async () => {
    for (let i = 0; i < Sms.SMS_ASKER_PER_HOUR; i += 1) {
      expect(await outcome(fresh({ asker }))).toBe('sent')
      deps.clock.advance('1m')
    }
    expect(await outcome(fresh({ asker }))).toBe(LIMITED)
    // Somebody else is not affected, and the hour ends.
    expect(await outcome(fresh())).toBe('sent')
    deps.clock.advance('1h')
    expect(await outcome(fresh({ asker }))).toBe('sent')
  })

  test(`${Sms.SMS_NEW_NUMBERS_PER_DAY} numbers that are new to them in a day, however slowly`, async () => {
    for (let i = 0; i < Sms.SMS_NEW_NUMBERS_PER_DAY; i += 1) {
      expect(await outcome(fresh({ asker, newNumber: true }))).toBe('sent')
      deps.clock.advance('2h')
    }
    const sent = deps.sms.outbox.length
    const next = fresh({ asker, newNumber: true })
    expect(await outcome(next)).toBe(LIMITED)
    // Asking again for that number is as refused as the first time: the caller still says
    // it is new, because nothing was sent to it.
    deps.clock.advance('2h')
    expect(await outcome({ ...next })).toBe(LIMITED)
    expect(deps.sms.outbox).toHaveLength(sent)
    // A number they were already being texted at is not a new one.
    deps.clock.advance('2h')
    expect(await outcome(fresh({ asker, newNumber: false }))).toBe('sent')
    // The allowance is one asker's.
    expect(await outcome(fresh({ newNumber: true }))).toBe('sent')
    deps.clock.advance('24h')
    expect(await outcome(fresh({ asker, newNumber: true }))).toBe('sent')
  })

  test('an asker in another environment has an allowance of their own', async () => {
    expect(await outcome(fresh({ asker }))).toBe('sent')
    expect(await outcome(fresh({ asker }), OTHER)).toBe('sent')
  })
})

describe('per number', () => {
  const to = '+14155550142'

  test('one a minute, whoever asks', async () => {
    expect(await outcome(fresh({ to }))).toBe('sent')
    expect(await outcome(fresh({ to }))).toBe(LIMITED)
    deps.clock.advance('1m')
    expect(await outcome(fresh({ to }))).toBe('sent')
  })

  test(`${Sms.SMS_NUMBER_PER_HOUR} an hour, whoever asks`, async () => {
    for (let i = 0; i < Sms.SMS_NUMBER_PER_HOUR; i += 1) {
      expect(await outcome(fresh({ to }))).toBe('sent')
      deps.clock.advance('1m')
    }
    expect(await outcome(fresh({ to }))).toBe(LIMITED)
    // Its neighbour is another number.
    expect(await outcome(fresh({ to: '+14155550143' }))).toBe('sent')
    expect(deps.sms.messages(to)).toHaveLength(Sms.SMS_NUMBER_PER_HOUR)
  })
})

describe('per address', () => {
  const address = '203.0.113.7'

  test(`${Sms.SMS_ADDRESS_PER_HOUR} an hour from one address, whoever asks and whatever the number`, async () => {
    for (let i = 0; i < Sms.SMS_ADDRESS_PER_HOUR; i += 1) {
      expect(await outcome(fresh({ address }))).toBe('sent')
    }
    expect(await outcome(fresh({ address }))).toBe(LIMITED)
    expect(deps.sms.outbox).toHaveLength(Sms.SMS_ADDRESS_PER_HOUR)
    // Another address is not affected, and the hour ends.
    expect(await outcome(fresh())).toBe('sent')
    deps.clock.advance('1h')
    expect(await outcome(fresh({ address }))).toBe('sent')
  })

  test('a send with no request address is not held to it, and to every other limit', async () => {
    for (let i = 0; i < Sms.SMS_ADDRESS_PER_HOUR + 1; i += 1) {
      expect(await outcome(fresh({ address: null }))).toBe('sent')
    }
    const hit = spyOn(deps.rateLimiter, 'hit')
    await send(fresh({ address: null }))
    expect(hit.mock.calls.map(([key]) => key.slice(0, key.indexOf(':')))).toEqual([
      'sms_asker_cooldown',
      'sms_asker',
      'sms_number_cooldown',
      'sms_number',
      'sms_prefix',
      'sms_environment',
    ])
    hit.mockRestore()
    // The number's own limit still holds without an address.
    const to = '+14155550142'
    expect(await outcome(fresh({ to, address: null }))).toBe('sent')
    expect(await outcome(fresh({ to, address: null }))).toBe(LIMITED)
  })
})

describe('per destination prefix', () => {
  test('an hourly share of the daily limit for the numbers of one prefix', async () => {
    // 40 a day: 4 an hour for one prefix, 10 an hour for the environment.
    configure({ dailyMessageLimit: 40 })
    expect(Sms.limitsOf(40)).toEqual({ prefixPerHour: 4, environmentPerHour: 10, perDay: 40 })
    for (let line = 0; line < 4; line += 1) {
      expect(await outcome(fresh({ to: number(415, line) }))).toBe('sent')
    }
    // A fifth number of the destination: other asker, other address, another area code, a
    // number never texted.
    expect(await outcome(fresh({ to: number(212, 99) }))).toBe(LIMITED)
    expect(deps.sms.messages(number(212, 99))).toEqual([])
    expect(await sentToday()).toBe(4)
    // Another destination is still open.
    expect(await outcome(fresh({ to: german(1) }))).toBe('sent')
    deps.clock.advance('1h')
    expect(await outcome(fresh({ to: number(212, 99) }))).toBe('sent')
  })

  test('the prefix is counted per environment', async () => {
    configure({ dailyMessageLimit: 10 })
    expect(await outcome(fresh({ to: number(415, 1) }))).toBe('sent')
    expect(await outcome(fresh({ to: number(415, 2) }))).toBe(LIMITED)
    expect(await outcome(fresh({ to: number(415, 3) }), OTHER)).toBe('sent')
  })
})

describe('per environment', () => {
  test('an hourly share of the daily limit, whatever the prefix', async () => {
    // 8 a day: 2 an hour for the environment (and 1 for a prefix).
    configure({ dailyMessageLimit: 8 })
    expect(Sms.limitsOf(8)).toEqual({ prefixPerHour: 1, environmentPerHour: 2, perDay: 8 })
    expect(await outcome(fresh({ to: number(201, 1) }))).toBe('sent')
    expect(await outcome(fresh({ to: german(1) }))).toBe('sent')
    expect(await outcome(fresh({ to: french(1) }))).toBe(LIMITED)
    expect(await sentToday()).toBe(2)
    // Another environment has an hour of its own.
    expect(await outcome(fresh({ to: french(1) }), OTHER)).toBe('sent')
    deps.clock.advance('1h')
    expect(await outcome(fresh({ to: french(2) }))).toBe('sent')
    expect(deps.sms.outbox).toHaveLength(4)
  })
})

describe('the daily limit', () => {
  test('stops sending once it is reached, until the next UTC day', async () => {
    // 4 a day is 1 an hour for the environment: one message an hour, four hours running.
    configure({ dailyMessageLimit: 4 })
    for (let hour = 0; hour < 4; hour += 1) {
      expect(await outcome(fresh())).toBe('sent')
      deps.clock.advance('1h')
    }
    // 13:00: the hour is new, the day is spent.
    const warn = spyOn(logger, 'warn')
    expect(await outcome(fresh())).toBe(LIMITED)
    expect(warn.mock.calls).toEqual([
      [
        'text message not sent',
        { environmentId: SCOPE.environmentId, reason: 'limit', limit: 'daily' },
      ],
    ])
    warn.mockRestore()
    deps.clock.advance('8h')
    expect(await outcome(fresh())).toBe(LIMITED)
    expect(deps.sms.outbox).toHaveLength(4)
    // Another environment's day is its own.
    expect(await outcome(fresh(), OTHER)).toBe('sent')
    // 00:00 UTC.
    deps.clock.set(new Date('2026-10-09T00:00:00.000Z'))
    expect(await outcome(fresh())).toBe('sent')
  })

  test('the wait it answers with ends at midnight UTC', async () => {
    configure({ dailyMessageLimit: 1 })
    await send(fresh())
    deps.clock.set(new Date('2026-10-08T23:00:00.000Z'))
    const refusal = await send(fresh()).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(RateLimitError)
    expect((refusal as RateLimitError).retryAfter).toBe(3600)
  })

  test('raising it lets the day go on; lowering it ends the day at once', async () => {
    configure({ dailyMessageLimit: 1 })
    await send(fresh())
    deps.clock.advance('1h')
    expect(await outcome(fresh())).toBe(LIMITED)
    configure({ dailyMessageLimit: 400 })
    expect(await outcome(fresh())).toBe('sent')
    configure({ dailyMessageLimit: 2 })
    deps.clock.advance('1h')
    expect(await outcome(fresh())).toBe(LIMITED)
  })

  test('two sends at once cannot both take the day’s last message', async () => {
    // 8 a day, 7 of them gone: two destinations, so that neither hourly limit refuses.
    configure({ dailyMessageLimit: 8 })
    await counted('+33', 7)
    // Both are past every limiter check before either takes: the takes meet at the store,
    // which reads the day and adds to it in one step.
    const takeFromDay = deps.smsUsage.takeFromDay.bind(deps.smsUsage)
    let arrived = 0
    let release: () => void = () => {}
    const both = new Promise<void>((resolve) => {
      release = resolve
    })
    const take = spyOn(deps.smsUsage, 'takeFromDay').mockImplementation(async (...args) => {
      arrived += 1
      if (arrived === 2) {
        release()
      }
      await both
      return takeFromDay(...args)
    })
    const outcomes = await Promise.all([
      outcome(fresh({ to: number(415, 1) })),
      outcome(fresh({ to: german(1) })),
    ])
    take.mockRestore()
    expect(arrived).toBe(2)
    expect(outcomes.sort()).toEqual([LIMITED, 'sent'])
    expect(deps.sms.outbox).toHaveLength(1)
    expect(await sentToday()).toBe(8)
  })

  test('a send the day refuses adds nothing to it', async () => {
    configure({ dailyMessageLimit: 4 })
    await counted('+49', 4)
    expect(await outcome(fresh())).toBe(LIMITED)
    expect(await sentToday()).toBe(4)
    expect(deps.sms.outbox).toEqual([])
  })

  test('it is counted where every instance counts: a limiter that forgot does not reopen the day', async () => {
    configure({ dailyMessageLimit: 1 })
    await send(fresh())
    // Another instance, or this one after a restart: a limiter with nothing in it, the same
    // database.
    const restarted = createTestDeps({
      environmentSettings: deps.environmentSettings,
      smsUsage: deps.smsUsage,
      clock: deps.clock,
    })
    const refusal = await Sms.sendCode(restarted, SCOPE, fresh()).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(RateLimitError)
    expect(restarted.sms.outbox).toEqual([])
  })
})

describe('the limits a daily limit gives', () => {
  test.each([
    [1, { prefixPerHour: 1, environmentPerHour: 1, perDay: 1 }],
    [4, { prefixPerHour: 1, environmentPerHour: 1, perDay: 4 }],
    [5, { prefixPerHour: 1, environmentPerHour: 2, perDay: 5 }],
    [500, { prefixPerHour: 50, environmentPerHour: 125, perDay: 500 }],
    [1_000_000, { prefixPerHour: 100_000, environmentPerHour: 250_000, perDay: 1_000_000 }],
  ])('%p a day', (dailyMessageLimit, limits) => {
    expect(Sms.limitsOf(dailyMessageLimit)).toEqual(limits)
  })

  test.each([0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    '%p is not a limit: one message a day, never none at all',
    (dailyMessageLimit) => {
      expect(Sms.limitsOf(dailyMessageLimit)).toEqual({
        prefixPerHour: 1,
        environmentPerHour: 1,
        perDay: 1,
      })
    }
  )
})

describe('a limiter that cannot count', () => {
  test.each([
    'sms_asker_cooldown',
    'sms_asker',
    'sms_asker_new_number',
    'sms_number_cooldown',
    'sms_number',
    'sms_address',
    'sms_prefix',
    'sms_environment',
  ])('at %s: nothing is sent', async (failing) => {
    const hit = deps.rateLimiter.hit.bind(deps.rateLimiter)
    const spy = spyOn(deps.rateLimiter, 'hit').mockImplementation(async (key, ...rest) => {
      if (key.startsWith(`${failing}:`)) {
        throw new ServiceUnavailableError()
      }
      return hit(key, ...rest)
    })
    expect(await outcome(fresh({ newNumber: true }))).toBe('service.unavailable 503')
    spy.mockRestore()
    expect(deps.sms.outbox).toEqual([])
    expect(await sentToday()).toBe(0)
  })
})

describe('what a refusal says', () => {
  test('the same answer for every limit, and the limit’s name only in the log', async () => {
    configure({ dailyMessageLimit: 8 })
    const info = spyOn(logger, 'info')
    const warn = spyOn(logger, 'warn')
    const asker = { type: 'user', id: 'maya' } as const
    const first = fresh({ asker })
    await send(first)
    const refusals = [
      await send(fresh({ asker })).catch((error: unknown) => error),
      await send(fresh({ to: first.to })).catch((error: unknown) => error),
      // The destination's hour (one message), then the environment's (two).
      await send(fresh({ to: number(415, 2) })).catch((error: unknown) => error),
      await send(fresh({ to: german(1) })).then(() =>
        send(fresh({ to: french(1) })).catch((error: unknown) => error)
      ),
    ]
    for (const refusal of refusals) {
      expect(refusal).toBeInstanceOf(RateLimitError)
      // `rate_limited`, how long to wait, and nothing else.
      expect(Object.keys((refusal as RateLimitError).params ?? {})).toEqual(['retryAfter'])
    }
    const lines = [...info.mock.calls, ...warn.mock.calls]
    expect(lines.map(([, fields]) => (fields as { limit: string }).limit)).toEqual([
      'asker',
      'number',
      'prefix',
      'environment',
    ])
    // A line names the environment and the limit: never a number, a prefix or an address.
    for (const [message, fields] of lines) {
      expect(message).toBe('text message not sent')
      expect(Object.keys(fields as object).sort()).toEqual(['environmentId', 'limit', 'reason'])
    }
    info.mockRestore()
    warn.mockRestore()
  })
})

describe('what the shared store is given', () => {
  test('ids and keyed hashes: no number, no prefix, no address', async () => {
    const hit = spyOn(deps.rateLimiter, 'hit')
    const message = fresh({ to: '+14155550142', address: '203.0.113.7', newNumber: true })
    await send(message)
    const keys = hit.mock.calls.map(([key]) => key)
    hit.mockRestore()
    expect(keys).toHaveLength(8)
    for (const key of keys) {
      for (const secret of [
        '14155550142',
        '4155550142',
        '415555',
        '203.0.113.7',
        sha256Hex('+14155550142'),
        sha256Hex('203.0.113.7'),
        sha256Hex('+1'),
      ]) {
        expect(key).not.toContain(secret)
      }
      // The environment, then nothing but ids or a keyed hash (64 hex characters).
      expect(key).toMatch(
        new RegExp(`^sms_[a-z_]+:${SCOPE.environmentId}(:user:[a-z0-9-]+|:[0-9a-f]{64})?$`)
      )
    }
  })

  test('the same number, prefix and address give other keys in another environment', async () => {
    const message = fresh({ to: '+14155550142', address: '203.0.113.7' })
    const hit = spyOn(deps.rateLimiter, 'hit')
    await send(message)
    await send(message, OTHER)
    const keys = hit.mock.calls.map(([key]) => key)
    hit.mockRestore()
    const hashes = (environmentId: string) =>
      keys
        .filter((key) => key.includes(environmentId))
        .map((key) => /[0-9a-f]{64}$/.exec(key)?.[0])
        .filter(Boolean)
    expect(hashes(SCOPE.environmentId)).toHaveLength(4)
    for (const hash of hashes(SCOPE.environmentId)) {
      expect(hashes(OTHER.environmentId)).not.toContain(hash)
    }
  })
})

describe('a code that was used', () => {
  test('is counted against the prefix and the day it was sent on', async () => {
    const to = '+14155550142'
    await send(fresh({ to }))
    const sentAt = deps.clock.now()
    deps.clock.set(new Date('2026-10-09T00:00:01.000Z'))
    await Sms.recordUsed(deps, SCOPE, { to, sentAt })
    expect(await deps.smsUsage.summary(SCOPE.environmentId, TODAY, 10)).toMatchObject({
      sent: 1,
      used: 1,
    })
  })

  test('counts that cannot be written do not fail the confirmation', async () => {
    const record = spyOn(deps.smsUsage, 'recordUsed').mockRejectedValue(new Error('db down'))
    const warn = spyOn(logger, 'warn')
    await Sms.recordUsed(deps, SCOPE, { to: '+14155550142', sentAt: deps.clock.now() })
    expect(warn.mock.calls.map(([message]) => message)).toEqual(['text message not counted'])
    warn.mockRestore()
    record.mockRestore()
  })
})

describe('what the operator reads', () => {
  test('the codes of the last days by prefix, unused first, with no number in it', async () => {
    for (let line = 0; line < 3; line += 1) {
      await send(fresh({ to: number(415, line) }))
    }
    const used = fresh({ to: german(7) })
    await send(used)
    await Sms.recordUsed(deps, SCOPE, { to: used.to, sentAt: deps.clock.now() })
    expect(await Sms.usage(deps, SCOPE, { days: 7 })).toEqual({
      since: '2026-10-02',
      days: 7,
      sent: 4,
      used: 1,
      unused: 3,
      prefixes: [
        { prefix: '+1', sent: 3, used: 0, unused: 3 },
        { prefix: '+49', sent: 1, used: 1, unused: 0 },
      ],
      truncated: false,
    })
    // One day is today alone.
    expect((await Sms.usage(deps, SCOPE, { days: 1 })).since).toBe('2026-10-08')
    expect((await Sms.usage(deps, OTHER, { days: 7 })).sent).toBe(0)
  })

  test('a day that is over is left out of a span that starts after it', async () => {
    await send(fresh())
    deps.clock.set(new Date('2026-10-10T09:00:00.000Z'))
    expect((await Sms.usage(deps, SCOPE, { days: 2 })).sent).toBe(0)
    expect((await Sms.usage(deps, SCOPE, { days: 3 })).sent).toBe(1)
  })
})
