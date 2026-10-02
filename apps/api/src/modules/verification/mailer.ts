import type { Deps } from '~/dependencies'
import type { VerificationPurpose } from '~/ports/verification-token-store'

/** What a verification email needs. */
export interface CodeEmail {
  purpose: VerificationPurpose
  /** Recipient, as the user entered it. */
  to: string
  code: string
  /** Magic link, when the flow offers one. */
  linkUrl?: string
  /** Minutes until the code and link expire. */
  ttlMinutes: number
}

const COPY: Record<VerificationPurpose, { subject: string; intro: string; action: string }> = {
  email_verification: {
    subject: 'is your verification code',
    intro: 'Enter this code to verify your email address:',
    action: 'Verify email',
  },
  password_reset: {
    subject: 'is your password reset code',
    intro: 'Enter this code to reset your password:',
    action: 'Reset password',
  },
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * Send a verification or password-reset code (and optional magic link).
 *
 * The code leads the subject so it is readable from a notification without opening the email.
 *
 * @param deps - The mailer.
 * @param email - Recipient, code, optional link and expiry.
 * @throws Error when the relay fails (see {@link Mailer.send}).
 */
export async function sendCode(deps: Pick<Deps, 'mailer'>, email: CodeEmail): Promise<void> {
  const copy = COPY[email.purpose]
  const expiry = `This code expires in ${email.ttlMinutes} minutes.`
  const ignore = "If you didn't request this, you can safely ignore this email."
  const link = email.linkUrl
  await deps.mailer.send({
    to: email.to,
    subject: `${email.code} ${copy.subject}`,
    text: [
      copy.intro,
      '',
      email.code,
      '',
      ...(link ? [`Or open this link: ${link}`, ''] : []),
      expiry,
      ignore,
    ].join('\n'),
    html: [
      `<p>${copy.intro}</p>`,
      `<p style="font-size:28px;font-weight:600;letter-spacing:4px">${escapeHtml(email.code)}</p>`,
      ...(link ? [`<p><a href="${escapeHtml(link)}">${copy.action}</a></p>`] : []),
      `<p>${expiry}</p>`,
      `<p>${escapeHtml(ignore)}</p>`,
    ].join('\n'),
  })
}
