import type { Deps, Tenant } from '~/dependencies'
import * as Email from '~/modules/email/service'
import type { VerificationPurpose } from '~/ports/verification-token-store'

/**
 * The purposes whose code goes out by email. A `phone_verification` code is texted, by the
 * caller's own delivery (`modules/phone`): there is no email for it.
 */
export type EmailedPurpose = Exclude<VerificationPurpose, 'phone_verification'>

/** What a verification email needs. */
export interface CodeEmail {
  purpose: EmailedPurpose
  /** Recipient, as the user entered it. */
  to: string
  code: string
  /** Magic link, when the flow offers one. */
  linkUrl?: string
  /** Minutes until the code and link expire. */
  ttlMinutes: number
}

/**
 * Send a verification or password-reset code (and optional magic link).
 *
 * The layout and the copy live in `~/modules/email`; the email names the environment's app and
 * the code leads the subject, so it is readable from a notification without opening the email.
 *
 * @param deps - The mailer, settings store and config.
 * @param tenant - The environment the code is for.
 * @param email - Recipient, code, optional link and expiry.
 * @throws Error when the relay fails (see {@link Mailer.send}).
 */
export async function sendCode(
  deps: Pick<Deps, 'mailer' | 'environmentSettings' | 'config'>,
  tenant: Pick<Tenant, 'environmentId'>,
  email: CodeEmail
): Promise<void> {
  await Email.send(deps, tenant, email.to, {
    type: email.purpose,
    code: email.code,
    ttlMinutes: email.ttlMinutes,
    linkUrl: email.linkUrl,
  })
}
