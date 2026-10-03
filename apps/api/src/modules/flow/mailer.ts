import type { Deps } from '~/dependencies'

async function sendNotice(
  deps: Pick<Deps, 'mailer'>,
  to: string,
  subject: string,
  lines: string[]
): Promise<void> {
  await deps.mailer.send({
    to,
    subject,
    text: lines.join('\n\n'),
    html: lines.map((line) => `<p>${line.replaceAll("'", '&#39;')}</p>`).join('\n'),
  })
}

/**
 * Tell an account's owner that someone tried to sign up with their email.
 *
 * Sent instead of a verification code when the address already has an account, so the sign-up
 * response can be identical for new and existing emails. It contains no code and no link that
 * acts on the account.
 *
 * @param deps - The mailer.
 * @param to - The account's email address.
 * @throws Error when the relay fails (see {@link Mailer.send}).
 */
export async function sendAccountExistsNotice(
  deps: Pick<Deps, 'mailer'>,
  to: string
): Promise<void> {
  await sendNotice(deps, to, 'You already have an account', [
    'Someone tried to create an account with this email address, but you already have one.',
    'If that was you, sign in instead. If you have forgotten your password, you can reset it from the sign-in screen.',
    "If it wasn't you, you can safely ignore this email. Your account has not changed.",
  ])
}

/**
 * Tell an address's owner that someone asked to reset a password there, but it has no account.
 *
 * Sent instead of a reset code, so starting a reset answers, costs and is rate limited the same
 * for addresses with and without an account. It contains no code and no link.
 *
 * @param deps - The mailer.
 * @param to - The address the reset was requested for.
 * @throws Error when the relay fails (see {@link Mailer.send}).
 */
export async function sendNoAccountNotice(deps: Pick<Deps, 'mailer'>, to: string): Promise<void> {
  await sendNotice(deps, to, 'Password reset requested', [
    'Someone asked to reset the password for this email address, but there is no account for it.',
    'If that was you, you may have signed up with a different address, or you can create an account.',
    "If it wasn't you, you can safely ignore this email.",
  ])
}
