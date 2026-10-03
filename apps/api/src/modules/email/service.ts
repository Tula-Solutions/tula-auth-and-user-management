import type { Deps, Tenant } from '~/dependencies'
import * as Settings from '~/modules/settings/service'
import { type EmailMessage, render } from './templates'

/**
 * Send one of Tula's emails, in the layout and with the app name of the environment it is for.
 *
 * Every email goes through here, so none can be sent that does not say which app it is from.
 *
 * @param deps - Mailer, settings store and config.
 * @param tenant - The environment the email is sent for.
 * @param to - Recipient, as the user entered it.
 * @param message - What to say (see `templates.ts` for the copy of each type).
 * @throws Error when the relay fails (see `Mailer.send`). Callers must not log the message: it
 *   holds codes and links.
 *
 * @example
 * ```ts
 * await Email.send(deps, tenant, 'maya@example.com', {
 *   type: 'email_verification', code: '123456', ttlMinutes: 10,
 * })
 * ```
 */
export async function send(
  deps: Pick<Deps, 'mailer' | 'environmentSettings' | 'config'>,
  tenant: Pick<Tenant, 'environmentId'>,
  to: string,
  message: EmailMessage
): Promise<void> {
  const { app } = await Settings.current(deps, tenant)
  await deps.mailer.send({ to, ...render(app, message) })
}
