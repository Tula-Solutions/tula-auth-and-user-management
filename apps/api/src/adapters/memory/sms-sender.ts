import type { Clock } from '~/ports/clock'
import {
  type ReceivedSms,
  type SmsInbox,
  type SmsMessage,
  type SmsSendContext,
  SmsSendError,
  type SmsSender,
} from '~/ports/sms-sender'

/** SMS sender that keeps every message in memory so tests can read the code that was "sent". */
export class MemorySmsSender implements SmsSender, SmsInbox {
  /** Every message sent, oldest first. */
  readonly outbox: ReceivedSms[]
  /** `false` simulates a deployment with no sender (`SMS_PROVIDER=none`). */
  configured: boolean
  /**
   * Simulates a send that does not go through: `true` for a sender that refuses (`send`
   * rejects with `failed`), `'unconfirmed'` for one whose answer is lost (the message may
   * have gone out). Nothing is kept either way.
   */
  failing: boolean | 'unconfirmed'
  private readonly clock: Clock

  /**
   * @param clock - Stamps each message.
   */
  constructor(clock: Clock) {
    // Assigned here rather than as field initializers: Bun's per-file coverage counts
    // initializers as an uncalled function.
    this.outbox = []
    this.configured = true
    this.failing = false
    this.clock = clock
  }

  /**
   * Keeps the message the moment it is handed over, whatever `_context` says: the outbox
   * is what the sender was given, which is what unit tests assert on. A test that goes on
   * to use a sign-in's code waits for its token with `Sms.settled()` (the development
   * inbox, read over HTTP by tools that cannot, holds such a message back instead).
   *
   * @inheritdoc
   */
  async send(message: SmsMessage, _context?: SmsSendContext): Promise<void> {
    if (this.failing) {
      throw new SmsSendError(this.failing === true ? 'failed' : 'unconfirmed')
    }
    this.outbox.push({ to: message.to, text: message.text, sentAt: this.clock.now() })
  }

  /** @inheritdoc */
  messages(to?: string): ReceivedSms[] {
    return this.outbox.filter((message) => to === undefined || message.to === to)
  }

  /**
   * @returns The most recent message.
   * @throws Error when nothing was sent.
   */
  last(): ReceivedSms {
    const message = this.outbox.at(-1)
    if (!message) {
      throw new Error('no text message was sent')
    }
    return message
  }
}
