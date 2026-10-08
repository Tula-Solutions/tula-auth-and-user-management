import { describe, expect, test } from 'bun:test'
import { FixedClock } from '~/adapters/memory/clock'
import type { SmsInbox, SmsSender } from '~/ports/sms-sender'

/**
 * Behaviour every SMS sender that keeps its messages must have (the memory adapter and the
 * development inbox).
 *
 * @param name - Adapter name for the test output.
 * @param create - Builds a fresh adapter on the given clock.
 */
export function smsInboxSuite(
  name: string,
  create: (clock: FixedClock) => SmsSender & SmsInbox
): void {
  describe(`${name} (kept messages)`, () => {
    test('keeps what it was handed, oldest first, with the time it was handed it', async () => {
      const clock = new FixedClock()
      const sender = create(clock)
      const first = clock.now()
      await sender.send({ to: '+14155550100', text: 'one' })
      clock.advance('1m')
      await sender.send({ to: '+4915112345678', text: 'two' })

      expect(sender.messages()).toEqual([
        { to: '+14155550100', text: 'one', sentAt: first },
        { to: '+4915112345678', text: 'two', sentAt: clock.now() },
      ])
    })

    test('reads one number’s messages by exact match', async () => {
      const sender = create(new FixedClock())
      await sender.send({ to: '+14155550100', text: 'one' })
      await sender.send({ to: '+141555501000', text: 'a longer number' })
      await sender.send({ to: '+14155550100', text: 'two' })

      expect(sender.messages('+14155550100').map((message) => message.text)).toEqual(['one', 'two'])
      expect(sender.messages('+1415555010')).toEqual([])
      expect(sender.messages('14155550100')).toEqual([])
    })

    test('is empty before anything was sent', () => {
      expect(create(new FixedClock()).messages()).toEqual([])
    })

    test('what a reader gets is a copy of the list: emptying it loses nothing', async () => {
      const sender = create(new FixedClock())
      await sender.send({ to: '+14155550100', text: 'one' })
      sender.messages().length = 0
      expect(sender.messages()).toHaveLength(1)
    })
  })
}
