import { describe, expect, spyOn, test } from 'bun:test'
import { FixedClock } from '~/adapters/memory/clock'
import { smsInboxSuite, smsSenderSuite } from '~/adapters/sms-sender.suite'
import { SmsSendError } from '~/ports/sms-sender'
import { DEV_SMS_INBOX_SIZE, DevSmsSender } from './dev'
import { unconfiguredSmsSender } from './unconfigured'

smsInboxSuite('DevSmsSender', (clock) => new DevSmsSender(clock))
// The inbox cannot fail: it has nothing to be refused by.
smsSenderSuite('DevSmsSender', () => ({ sender: new DevSmsSender(new FixedClock()) }), {
  configured: true,
})
smsSenderSuite('unconfiguredSmsSender', () => ({ sender: unconfiguredSmsSender }), {
  configured: false,
})

describe('DevSmsSender', () => {
  test('keeps the newest fifty and drops the oldest', async () => {
    expect(DEV_SMS_INBOX_SIZE).toBe(50)
    const sender = new DevSmsSender(new FixedClock())
    for (let n = 1; n <= 51; n += 1) {
      await sender.send({ to: '+14155550100', text: `message ${n}` })
    }
    const kept = sender.messages()
    expect(kept).toHaveLength(50)
    expect(kept[0]?.text).toBe('message 2')
    expect(kept.at(-1)?.text).toBe('message 51')
  })

  describe('a message whose code cannot be used yet', () => {
    const HELD = { to: '+14155550100', text: 'code 123456' }
    /** A `usable` the test settles, and a turn of the loop for the inbox to act on it. */
    function later() {
      let settle: (usable: boolean) => void = () => {}
      let fail: (error: Error) => void = () => {}
      const usable = new Promise<boolean>((resolve, reject) => {
        settle = resolve
        fail = reject
      })
      const turn = () => new Promise((resolve) => setTimeout(resolve, 0))
      return { usable, settle, fail, turn }
    }

    test('is taken at once and readable only once it is said to be usable', async () => {
      const clock = new FixedClock()
      const sender = new DevSmsSender(clock)
      const handedAt = clock.now()
      const { usable, settle, turn } = later()
      await sender.send(HELD, { usable })
      await turn()
      expect(sender.messages()).toEqual([])
      clock.advance('1m')
      settle(true)
      await turn()
      // Stamped with the time it was handed over, not the time it became readable.
      expect(sender.messages()).toEqual([{ ...HELD, sentAt: handedAt }])
    })

    test('is never readable when its code never becomes usable', async () => {
      const sender = new DevSmsSender(new FixedClock())
      const refused = later()
      await sender.send(HELD, { usable: refused.usable })
      refused.settle(false)
      await refused.turn()
      expect(sender.messages()).toEqual([])
    })

    test('a rejection is "never usable", and nobody is left with an unhandled one', async () => {
      const sender = new DevSmsSender(new FixedClock())
      const rejections: unknown[] = []
      const onRejection = (reason: unknown) => rejections.push(reason)
      process.on('unhandledRejection', onRejection)
      try {
        const broken = later()
        await sender.send(HELD, { usable: broken.usable })
        broken.fail(new Error('code 123456 for +14155550100'))
        await broken.turn()
        expect(sender.messages()).toEqual([])
        expect(rejections).toEqual([])
      } finally {
        process.off('unhandledRejection', onRejection)
      }
    })

    test('does not hold back a message handed over after it', async () => {
      const sender = new DevSmsSender(new FixedClock())
      const { usable, settle, turn } = later()
      await sender.send({ to: '+14155550100', text: 'held' }, { usable })
      await sender.send({ to: '+14155550100', text: 'plain' })
      expect(sender.messages().map((message) => message.text)).toEqual(['plain'])
      settle(true)
      await turn()
      expect(sender.messages().map((message) => message.text)).toEqual(['plain', 'held'])
    })

    test('counts against the fifty only once it is readable', async () => {
      const sender = new DevSmsSender(new FixedClock())
      const { usable, settle, turn } = later()
      await sender.send({ to: '+14155550100', text: 'held' }, { usable })
      for (let n = 1; n <= DEV_SMS_INBOX_SIZE; n += 1) {
        await sender.send({ to: '+14155550100', text: `message ${n}` })
      }
      expect(sender.messages()).toHaveLength(DEV_SMS_INBOX_SIZE)
      expect(sender.messages()[0]?.text).toBe('message 1')
      settle(true)
      await turn()
      expect(sender.messages()).toHaveLength(DEV_SMS_INBOX_SIZE)
      expect(sender.messages()[0]?.text).toBe('message 2')
      expect(sender.messages().at(-1)?.text).toBe('held')
    })
  })

  test('writes nothing to the console or standard output: a code must not reach a log', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      spyOn(console, method).mockImplementation(() => {})
    )
    const out = spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await new DevSmsSender(new FixedClock()).send({ to: '+14155550100', text: 'code 123456' })
      for (const spy of [...spies, out]) {
        expect(spy).not.toHaveBeenCalled()
      }
    } finally {
      for (const spy of [...spies, out]) {
        spy.mockRestore()
      }
    }
  })
})

describe('unconfiguredSmsSender', () => {
  test('every send fails with the fixed word and nothing of the message', async () => {
    const failure = await unconfiguredSmsSender
      .send({ to: '+14155550100', text: 'code 123456' })
      .catch((error) => error)
    expect(failure).toBeInstanceOf(SmsSendError)
    expect(failure.reason).toBe('not_configured')
    expect(failure.message).toBe('sms not sent: not_configured')
  })
})
