import type { Deps } from '~/dependencies'

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
  const lines = [
    'Someone tried to create an account with this email address, but you already have one.',
    'If that was you, sign in instead, or reset your password if you have forgotten it.',
    "If it wasn't you, you can safely ignore this email. Your account has not changed.",
  ]
  await deps.mailer.send({
    to,
    subject: 'You already have an account',
    text: lines.join('\n\n'),
    html: lines.map((line) => `<p>${line.replaceAll("'", '&#39;')}</p>`).join('\n'),
  })
}
