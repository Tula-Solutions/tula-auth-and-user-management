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
