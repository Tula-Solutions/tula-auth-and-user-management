import type { Clock } from '~/ports/clock'
import type {
  ReceivedSms,
  SmsInbox,
  SmsMessage,
  SmsSendContext,
  SmsSender,
} from '~/ports/sms-sender'

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
 *
 * **A message is readable once its code can be used, and not before.** A sign-in's message
 * is handed over before its token is stored ({@link SmsSendContext.usable}): it is taken at
 * once, as a provider would take it, and kept out of the inbox until the caller says the
 * code can be used. A tool that polls the inbox would otherwise read a code and present it
 * while nothing stood behind it (the right code, answered as a wrong one). A message whose
 * code never becomes usable is never shown: a reader waits and gives up, and the server's
 * log says why. Every other message is readable when it is handed over.
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
  async send(message: SmsMessage, context?: SmsSendContext): Promise<void> {
    const received = { to: message.to, text: message.text, sentAt: this.clock.now() }
    if (context?.usable === undefined) {
      this.keep(received)
      return
    }
    // Not waited for: it resolves only after this has answered. A rejection is "never
    // usable", as `false` is. Nothing is logged here: the message holds a code.
    void context.usable.then(
      (usable) => {
        if (usable) {
          this.keep(received)
        }
      },
      () => undefined
    )
  }

  /** Make a message readable; the oldest goes when one more arrives in a full inbox. */
  private keep(received: ReceivedSms): void {
    this.kept.push(received)
    if (this.kept.length > DEV_SMS_INBOX_SIZE) {
      this.kept.shift()
    }
  }

  /** @inheritdoc */
  messages(to?: string): ReceivedSms[] {
    return this.kept.filter((message) => to === undefined || message.to === to)
  }
}
