import type { Clock } from '~/ports/clock'
import type { ReceivedSms, SmsInbox, SmsMessage, SmsSender } from '~/ports/sms-sender'

/** Messages the development inbox keeps; the oldest goes when one more arrives. */
export const DEV_SMS_INBOX_SIZE = 50

/**
 * The development SMS sender (`SMS_PROVIDER=dev`): it sends nothing and keeps the last
 * {@link DEV_SMS_INBOX_SIZE} messages in this process's memory, where the local inbox route
 * (`GET /v1/dev/sms/messages`) reads them. **A development and test aid** (ADR 0037).
 *
 * `env.ts` refuses it outside `ENVIRONMENT=local` and with a `PUBLIC_URL` that is not
 * loopback, and `container.ts` checks the tier again: whoever can read the inbox reads every
 * code. Nothing is written to a log or a file, and a restart empties it. Each API instance
 * has its own.
 */
export class DevSmsSender implements SmsSender, SmsInbox {
  /** @inheritdoc */
  readonly configured: boolean
  private readonly clock: Clock
  private readonly kept: ReceivedSms[]

  /**
   * @param clock - Stamps each message.
   */
  constructor(clock: Clock) {
    this.configured = true
    this.clock = clock
    this.kept = []
  }

  /** @inheritdoc */
  async send(message: SmsMessage): Promise<void> {
    this.kept.push({ to: message.to, text: message.text, sentAt: this.clock.now() })
    if (this.kept.length > DEV_SMS_INBOX_SIZE) {
      this.kept.shift()
    }
  }

  /** @inheritdoc */
  messages(to?: string): ReceivedSms[] {
    return this.kept.filter((message) => to === undefined || message.to === to)
  }
}
