/** One outgoing email. The sender address is the adapter's configuration, not the caller's. */
export interface MailMessage {
  /** Recipient address. */
  to: string
  subject: string
  /** Plain-text body (always sent; some clients show only this). */
  text: string
  /** HTML body. Callers must escape any interpolated values. */
  html: string
}

/** Sends transactional email (verification codes, security notices). */
export interface Mailer {
  /**
   * @param message - The email to send.
   * @throws Error when the relay rejects or cannot be reached. Callers must not log the message
   *   body: it contains codes and links.
   */
  send(message: MailMessage): Promise<void>
}
