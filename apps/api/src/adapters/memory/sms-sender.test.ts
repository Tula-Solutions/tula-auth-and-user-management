import { describe, expect, test } from 'bun:test'
import { FixedClock } from '~/adapters/memory/clock'
import { smsInboxSuite } from '~/adapters/sms-sender.suite'
import { SmsSendError } from '~/ports/sms-sender'
import { MemorySmsSender } from './sms-sender'

smsInboxSuite('MemorySmsSender', (clock) => new MemorySmsSender(clock))

describe('MemorySmsSender', () => {
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

  test('last() is the newest message, and says so when there is none', async () => {
    const sender = new MemorySmsSender(new FixedClock())
    expect(() => sender.last()).toThrow('no text message was sent')
    await sender.send({ to: '+14155550100', text: 'one' })
    await sender.send({ to: '+14155550100', text: 'two' })
    expect(sender.last().text).toBe('two')
  })
})
