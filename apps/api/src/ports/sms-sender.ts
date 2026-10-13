/** One outgoing text message. The sender id is the adapter's configuration, not the caller's. */
export interface SmsMessage {
  /** Recipient, in E.164 form (`+14155550100`). */
  to: string
  /** The whole message, plain text. It holds a code: never log it. */
  text: string
}

/**
 * Why a send did not end as "sent". Fixed words: an adapter never passes on a provider's own
 * text, which can quote the number.
 *
 * - `not_configured`: the deployment has no SMS sender (`SMS_PROVIDER=none`). Nothing was
 *   asked of anyone.
 * - `failed`: the sender was asked and **said no**. The message did not go, and that is
 *   known: an adapter says this only on an answer that refuses (over HTTP, a 4xx).
 * - `unconfirmed`: the sender was asked and **no answer says the message was refused**: a
 *   deadline, a connection that died, or an answer that is the provider's own failure (over
 *   HTTP, any 5xx: a gateway can answer one for a request the service behind it took). The
 *   message may have gone out, and may be billed.
 *
 * The difference is the caller's to act on (`Sms.sendCode`): a message that is known not to
 * have gone is taken back out of the day's count, and one that may have gone stays counted.
 * So an adapter that cannot tell says `unconfirmed`, never `failed`: a limit on what is
 * spent must err towards sending less.
 */
export type SmsFailureReason = 'not_configured' | 'failed' | 'unconfirmed'

/**
 * A send that did not end as "sent". Carries a fixed word and nothing of the message. For
 * `unconfirmed` the message may have been sent all the same ({@link SmsFailureReason}).
 */
export class SmsSendError extends Error {
  /** Why, as one of the fixed words. */
  readonly reason: SmsFailureReason

  /**
   * @param reason - Why the send did not end as "sent".
   */
  constructor(reason: SmsFailureReason) {
    super(`sms not sent: ${reason}`)
    this.name = 'SmsSendError'
    this.reason = reason
  }
}

/**
 * What the caller of a send knows about the message beside its recipient and its text.
 * Nothing of it is the message's: a sender that really sends reads none of it, waits for
 * none of it, and passes none of it to a provider.
 */
export interface SmsSendContext {
  /**
   * Given for a message whose code **cannot be used yet** when the sender is handed it: the
   * caller makes it usable only after the sender's answer (a sign-in's texted code, whose
   * token is stored once the sender took the message; ADR 0037). It resolves `true` once the
   * code can be used and `false` when it never will be (the token could not be stored). It
   * resolves only after `send` has, so **no sender may wait for it before answering**.
   *
   * It is for a sender that keeps its messages to be read (the development inbox): such a
   * sender shows the message only once this resolved `true`, so that a code a tool reads
   * there is one that can be presented, and never shows it otherwise. Left out, the message
   * is kept when it is handed over: the caller's own work has its code usable before it
   * answers its request.
   */
  usable?: Promise<boolean>
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
   * Whether this deployment has a way to send a message at all. `false` for the sender of a
   * deployment with none (`SMS_PROVIDER=none`): then nothing offers a phone number, and a
   * request that would send is refused before anything is counted.
   */
  readonly configured: boolean
  /**
   * @param message - The message to send.
   * @param context - What the caller knows beside the message ({@link SmsSendContext}). A
   *   sender that really sends ignores it: what it sends, and when it answers, are the same
   *   with and without it.
   * @throws SmsSendError when it was not sent (`not_configured`, `failed`) or when nothing
   *   says whether it was (`unconfirmed`). An adapter that cannot send fails closed: it
   *   never writes the message anywhere else (a log line least of all), and it resolves only
   *   for a message the provider took.
   */
  send(message: SmsMessage, context?: SmsSendContext): Promise<void>
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
