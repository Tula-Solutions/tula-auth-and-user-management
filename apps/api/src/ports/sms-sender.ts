/** One outgoing text message. The sender id is the adapter's configuration, not the caller's. */
export interface SmsMessage {
  /** Recipient, in E.164 form (`+14155550100`). */
  to: string
  /** The whole message, plain text. It holds a code: never log it. */
  text: string
}

/**
 * Why a message was not sent. Fixed words: an adapter never passes on a provider's own text,
 * which can quote the number.
 *
 * - `not_configured`: the deployment has no SMS sender (`SMS_PROVIDER=none`).
 * - `failed`: the sender was asked and did not take the message.
 */
export type SmsFailureReason = 'not_configured' | 'failed'

/** A message that was not sent. Carries a fixed word and nothing of the message. */
export class SmsSendError extends Error {
  /** Why, as one of the fixed words. */
  readonly reason: SmsFailureReason

  /**
   * @param reason - Why the message was not sent.
   */
  constructor(reason: SmsFailureReason) {
    super(`sms not sent: ${reason}`)
    this.name = 'SmsSendError'
    this.reason = reason
  }
}

/**
 * Sends text messages (verification codes).
 *
 * Whether a message **may** go to a number (the environment's `sms` settings, the country
 * allow-list) is decided before this is called, by `Settings.requireSms`: an adapter sends
 * what it is given.
 */
export interface SmsSender {
  /**
   * @param message - The message to send.
   * @throws SmsSendError when it was not sent. An adapter that cannot send fails closed: it
   *   never writes the message anywhere else (a log line least of all).
   */
  send(message: SmsMessage): Promise<void>
}

/** A message a development or test sender kept instead of sending. */
export interface ReceivedSms extends SmsMessage {
  /** When the sender was handed it. */
  sentAt: Date
}

/**
 * The readable side of a sender that keeps its messages: the development inbox, and the
 * memory adapter tests use. A sender that really sends has none.
 */
export interface SmsInbox {
  /**
   * @param to - Only the messages for this number (E.164). Left out: every message kept.
   * @returns The messages still kept, oldest first.
   */
  messages(to?: string): ReceivedSms[]
}
