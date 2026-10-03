import type { Deps, Tenant } from '~/dependencies'
import * as Email from '~/modules/email/service'

type MailDeps = Pick<Deps, 'mailer' | 'environmentSettings' | 'config'>

/**
 * Tell an account's owner that someone tried to sign up with their email.
 *
 * Sent instead of a verification code when the address already has an account, so the sign-up
 * response can be identical for new and existing emails. It contains no code and no link that
 * acts on the account.
 *
 * @param deps - The mailer, settings store and config.
 * @param tenant - The environment the sign-up was made in.
 * @param to - The account's email address.
 * @throws Error when the relay fails (see {@link Mailer.send}).
 */
export async function sendAccountExistsNotice(
  deps: MailDeps,
  tenant: Pick<Tenant, 'environmentId'>,
  to: string
): Promise<void> {
  await Email.send(deps, tenant, to, { type: 'account_exists' })
}

/**
 * Tell an address's owner that someone asked to reset a password there, but it has no account.
 *
 * Sent instead of a reset code, so starting a reset answers, costs and is rate limited the same
 * for addresses with and without an account. It contains no code and no link.
 *
 * @param deps - The mailer, settings store and config.
 * @param tenant - The environment the reset was requested in.
 * @param to - The address the reset was requested for.
 * @throws Error when the relay fails (see {@link Mailer.send}).
 */
export async function sendNoAccountNotice(
  deps: MailDeps,
  tenant: Pick<Tenant, 'environmentId'>,
  to: string
): Promise<void> {
  await Email.send(deps, tenant, to, { type: 'no_account' })
}
