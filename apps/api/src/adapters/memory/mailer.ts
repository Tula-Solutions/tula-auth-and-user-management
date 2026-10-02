import type { Mailer, MailMessage } from '~/ports/mailer'

/** Mailer that keeps messages in memory so tests can read the code or link that was "sent". */
export class MemoryMailer implements Mailer {
  /** Every message sent, oldest first. */
  readonly outbox: MailMessage[]
  /** Simulates the mail relay being down (`send` rejects). */
  failing: boolean

  constructor() {
    // Assigned here rather than as field initializers: Bun's per-file coverage counts
    // initializers as an uncalled function.
    this.outbox = []
    this.failing = false
  }

  /** @inheritdoc */
  async send(message: MailMessage): Promise<void> {
    if (this.failing) {
      throw new Error('mail relay unavailable')
    }
    this.outbox.push(message)
  }

  /**
   * @returns The most recent message.
   * @throws Error when nothing was sent.
   */
  last(): MailMessage {
    const message = this.outbox.at(-1)
    if (!message) {
      throw new Error('no mail was sent')
    }
    return message
  }
}
