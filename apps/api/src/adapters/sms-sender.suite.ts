import { describe, expect, test } from 'bun:test'
import { FixedClock } from '~/adapters/memory/clock'
import { type SmsInbox, SmsSendError, type SmsSender } from '~/ports/sms-sender'

/** One sender under test, and how the suite makes it take or refuse a message. */
export interface SmsSenderHarness {
  sender: SmsSender
  /**
   * Make every later send fail the way this adapter fails (the provider refusing, the
   * sender being down). Left out for an adapter that cannot fail, and for the one that
   * always does.
   */
  fail?: () => void
  /**
   * Make every later send end with no answer either way (a deadline, a connection that
   * dies): the message may have reached the provider. Left out for an adapter that has
   * nobody to lose an answer from.
   */
  loseAnswer?: () => void
  /** Undo whatever the harness stubbed. Called after every test. */
  cleanup?: () => void
}

/** What a sender does with a message, which the suite cannot find out by asking it. */
export interface SmsSenderTraits {
  /** What `configured` says: whether the deployment has a sender at all. */
  configured: boolean
}

const MESSAGE = { to: '+14155550142', text: 'Your Northline verification code is 739204.' }

/** Everything an error carries that could be printed, logged or serialized. */
function everythingIn(error: unknown): string {
  const own = error instanceof Error ? { ...error } : {}
  return [
    String(error),
    error instanceof Error ? error.message : '',
    error instanceof Error ? (error.stack ?? '') : '',
    JSON.stringify(own),
    JSON.stringify(error instanceof Error ? (error.cause ?? null) : null),
  ].join('\n')
}

/**
 * Behaviour every SMS sender must have, whatever it does with a message: the memory adapter,
 * the development inbox, the sender of a deployment without one, and Twilio.
 *
 * @param name - Adapter name for the test output.
 * @param create - Builds a fresh sender, with what the suite needs to make it fail.
 * @param traits - What this adapter says of itself.
 */
export function smsSenderSuite(
  name: string,
  create: () => SmsSenderHarness,
  traits: SmsSenderTraits
): void {
  describe(`${name} (SmsSender)`, () => {
    function withSender<T>(run: (harness: SmsSenderHarness) => Promise<T>): Promise<T> {
      const harness = create()
      return run(harness).finally(() => harness.cleanup?.())
    }

    test(`says the deployment ${traits.configured ? 'has' : 'has no'} sender`, () =>
      withSender(async ({ sender }) => {
        expect(sender.configured).toBe(traits.configured)
      }))

    test.skipIf(!traits.configured)('a message it takes resolves with nothing', () =>
      withSender(async ({ sender }) => {
        expect(await sender.send(MESSAGE)).toBeUndefined()
      })
    )

    test.skipIf(!traits.configured)(
      'a message whose code cannot be used yet is taken without waiting to be told it can',
      () =>
        withSender(async ({ sender }) => {
          // What a sign-in hands over (`SmsSendContext.usable`): it resolves only after the
          // sender has answered, so a sender that waited for it would never answer.
          const never = new Promise<boolean>(() => {})
          expect(await sender.send(MESSAGE, { usable: never })).toBeUndefined()
        })
    )

    test.skipIf(traits.configured)('a deployment without a sender refuses every message', () =>
      withSender(async ({ sender }) => {
        const failure = await sender.send(MESSAGE).catch((error) => error)
        expect(failure).toBeInstanceOf(SmsSendError)
        expect(failure.reason).toBe('not_configured')
      })
    )

    test('a message it does not take is the port’s failure: a fixed word, nothing of the message', () =>
      withSender(async ({ sender, fail }) => {
        if (traits.configured && !fail) {
          // An adapter that cannot fail has nothing to show here.
          return
        }
        fail?.()
        const failure = await sender.send(MESSAGE).catch((error) => error)
        expect(failure).toBeInstanceOf(SmsSendError)
        // "Not sent" is said only by a sender that knows it: never for a lost answer.
        expect(failure.reason).toBe(traits.configured ? 'failed' : 'not_configured')
        expect(failure.message).toBe(`sms not sent: ${failure.reason}`)
        const printed = everythingIn(failure)
        // Not the number, not its digits, not the code, not a word of the text.
        for (const part of [MESSAGE.to, '4155550142', '739204', 'Northline']) {
          expect(printed).not.toContain(part)
        }
      }))

    test('a send whose answer was lost is the port’s third word, never "failed" and never sent', () =>
      withSender(async ({ sender, loseAnswer }) => {
        if (!loseAnswer) {
          return
        }
        loseAnswer()
        const failure = await sender.send(MESSAGE).catch((error) => error)
        expect(failure).toBeInstanceOf(SmsSendError)
        // The caller keeps the message counted for this word and takes it back for the
        // other two, so an adapter must not blur them.
        expect(failure.reason).toBe('unconfirmed')
        expect(failure.message).toBe('sms not sent: unconfirmed')
        const printed = everythingIn(failure)
        for (const part of [MESSAGE.to, '4155550142', '739204', 'Northline']) {
          expect(printed).not.toContain(part)
        }
      }))

    test('it fails closed: once it stops taking messages none is reported as sent', () =>
      withSender(async ({ sender, fail }) => {
        if (!fail) {
          return
        }
        expect(await sender.send(MESSAGE)).toBeUndefined()
        fail()
        await expect(sender.send(MESSAGE)).rejects.toBeInstanceOf(SmsSendError)
        await expect(sender.send(MESSAGE)).rejects.toBeInstanceOf(SmsSendError)
      }))
  })
}

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

    test('says the deployment has a sender', () => {
      expect(create(new FixedClock()).configured).toBe(true)
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
