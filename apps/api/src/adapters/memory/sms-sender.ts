import type { Clock } from '~/ports/clock'
import {
  type ReceivedSms,
  type SmsInbox,
  type SmsMessage,
  SmsSendError,
  type SmsSender,
} from '~/ports/sms-sender'

/** SMS sender that keeps every message in memory so tests can read the code that was "sent". */
export class MemorySmsSender implements SmsSender, SmsInbox {
  /** Every message sent, oldest first. */
  readonly outbox: ReceivedSms[]
  /** Simulates the sender being down (`send` rejects with `failed`). */
  failing: boolean
  private readonly clock: Clock

  /**
   * @param clock - Stamps each message.
   */
  constructor(clock: Clock) {
    // Assigned here rather than as field initializers: Bun's per-file coverage counts
    // initializers as an uncalled function.
    this.outbox = []
    this.failing = false
    this.clock = clock
  }

  /** @inheritdoc */
  async send(message: SmsMessage): Promise<void> {
    if (this.failing) {
      throw new SmsSendError('failed')
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
