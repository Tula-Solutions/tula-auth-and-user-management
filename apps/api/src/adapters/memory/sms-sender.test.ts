import { describe, expect, test } from 'bun:test'
import { FixedClock } from '~/adapters/memory/clock'
import { smsInboxSuite, smsSenderSuite } from '~/adapters/sms-sender.suite'
import { SmsSendError } from '~/ports/sms-sender'
import { MemorySmsSender } from './sms-sender'

smsInboxSuite('MemorySmsSender', (clock) => new MemorySmsSender(clock))
smsSenderSuite(
  'MemorySmsSender',
  () => {
    const sender = new MemorySmsSender(new FixedClock())
    return {
      sender,
      fail: () => {
        sender.failing = true
      },
      loseAnswer: () => {
        sender.failing = 'unconfirmed'
      },
    }
  },
  { configured: true }
)

describe('MemorySmsSender', () => {
  test('says it is configured, until a test says otherwise', () => {
    const sender = new MemorySmsSender(new FixedClock())
    expect(sender.configured).toBe(true)
    sender.configured = false
    expect(sender.configured).toBe(false)
  })

  test('a failing sender rejects with the fixed word and keeps nothing', async () => {
    const sender = new MemorySmsSender(new FixedClock())
    sender.failing = true
    const failure = await sender
      .send({ to: '+14155550100', text: 'secret 123456' })
      .catch((error) => error)
    expect(failure).toBeInstanceOf(SmsSendError)
    expect(failure.reason).toBe('failed')
    expect(failure.message).not.toContain('123456')
    expect(failure.message).not.toContain('4155550100')
    expect(sender.outbox).toEqual([])
  })

  test('a sender told to lose its answers rejects with "unconfirmed" and keeps nothing', async () => {
    const sender = new MemorySmsSender(new FixedClock())
    sender.failing = 'unconfirmed'
    const failure = await sender
      .send({ to: '+14155550100', text: 'secret 123456' })
      .catch((error) => error)
    expect(failure).toBeInstanceOf(SmsSendError)
    expect(failure.reason).toBe('unconfirmed')
    expect(sender.outbox).toEqual([])
  })

  test('last() is the newest message, and says so when there is none', async () => {
    const sender = new MemorySmsSender(new FixedClock())
    expect(() => sender.last()).toThrow('no text message was sent')
    await sender.send({ to: '+14155550100', text: 'one' })
    await sender.send({ to: '+14155550100', text: 'two' })
    expect(sender.last().text).toBe('two')
  })
})
