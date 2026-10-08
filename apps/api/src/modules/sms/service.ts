import type { Deps, Tenant } from '~/dependencies'
import { AuthError } from '~/exceptions'
import * as logger from '~/lib/logger'
import * as Settings from '~/modules/settings/service'
import { type SmsFailureReason, SmsSendError } from '~/ports/sms-sender'
import { codeText } from './templates'

/** What a code message needs. */
export interface CodeMessage {
  /** Recipient, in E.164 form. */
  to: string
  /** The code. */
  code: string
}

/**
 * Refuse a request that would send a message from a deployment that has no sender.
 *
 * Called after `Settings.requireSms` and **before any send limit is counted**: a try that
 * can only fail must not use up the user's, or the number's, allowance. One log line for the
 * operator, the same as for a send that failed.
 *
 * @param deps - The SMS sender.
 * @param tenant - The environment, for the log line.
 * @throws AuthError `sms.unavailable` when the deployment has no sender.
 */
export function requireSender(
  deps: Pick<Deps, 'sms'>,
  tenant: Pick<Tenant, 'environmentId'>
): void {
  if (!deps.sms.configured) {
    logger.warn('text message not sent', {
      environmentId: tenant.environmentId,
      reason: 'not_configured' satisfies SmsFailureReason,
    })
    throw new AuthError('sms.unavailable')
  }
}

/**
 * Text a verification code to a number, in the words and with the app name of the
 * environment it is for.
 *
 * Every text message goes through here, so none can be sent that does not say which app it
 * is from. **It does not decide whether the message may be sent**: the caller has already
 * asked `Settings.requireSms` for this number, before anything was counted.
 *
 * A message that could not be sent is `sms.unavailable` (503) for the caller and one log
 * line for the operator, with the sender's fixed word and the environment: never the number,
 * the code or the text.
 *
 * @param deps - SMS sender, settings store and config.
 * @param tenant - The environment the code is for.
 * @param message - The recipient and the code.
 * @throws AuthError `sms.unavailable` when the sender did not take the message.
 *
 * @example
 * ```ts
 * await Sms.sendCode(deps, tenant, { to: '+14155550100', code: '123456' })
 * ```
 */
export async function sendCode(
  deps: Pick<Deps, 'sms' | 'environmentSettings' | 'config'>,
  tenant: Pick<Tenant, 'environmentId'>,
  message: CodeMessage
): Promise<void> {
  const { app, urls } = await Settings.current(deps, tenant)
  const text = codeText({
    appName: app.name,
    allowedOrigins: urls.allowedOrigins,
    code: message.code,
  })
  try {
    await deps.sms.send({ to: message.to, text })
  } catch (error) {
    logger.warn('text message not sent', {
      environmentId: tenant.environmentId,
      // A fixed word from the adapter. Anything else that was thrown is not read at all: a
      // provider's own message can quote the number.
      reason: error instanceof SmsSendError ? error.reason : 'failed',
    })
    throw new AuthError('sms.unavailable')
  }
}
