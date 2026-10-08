import { type SmsMessage, SmsSendError, type SmsSender } from '~/ports/sms-sender'

/**
 * The sender of a deployment that has none (`SMS_PROVIDER=none`, the default): every send
 * fails with the fixed word `not_configured`.
 *
 * It fails closed on purpose. An environment can switch SMS on in its settings while the
 * deployment has nothing to send with; the message must then go nowhere, and above all not
 * into a log line: it holds a code.
 */
export const unconfiguredSmsSender: SmsSender = {
  configured: false,
  /** @inheritdoc */
  async send(_message: SmsMessage): Promise<void> {
    throw new SmsSendError('not_configured')
  },
}
