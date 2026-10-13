import { isTestAddress } from '@tula-tech/contract'
import type { Deps, Tenant } from '~/dependencies'
import { capturesMail } from '~/lib/captured-mail'
import * as logger from '~/lib/logger'
import * as Settings from '~/modules/settings/service'
import { type EmailMessage, renderTemplate, templateKind } from './templates'

/**
 * Send one of Tula's emails, in the layout and with the app name of the environment it is for,
 * and in the environment's own wording where it has saved a template for the message's kind
 * (`emails.templates`, ADR 0039).
 *
 * Every email goes through here, so none can be sent that does not say which app it is from.
 *
 * A template that cannot be used for this message (it no longer passes its kind's rules, or
 * its subject would lead a notice with a digit) is not an error: that part is sent as the
 * built-in copy, and the fact is logged by environment and kind. The wording itself is never
 * logged.
 *
 * Two kinds of message are never sent (ADR 0058). One handed to a sign-in test's capture
 * (`captureMail`) is kept there as it was asked for. One for an address of the reserved test
 * domain, with any other mailer, is dropped and logged by environment and kind: no such
 * mailbox exists, and the caller is answered as for any address.
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
  if (capturesMail(deps.mailer)) {
    // A sign-in test's own mail (ADR 0058): kept in the server's process, as it was asked
    // for, and never sent. The code is read by name: a message without one has none.
    deps.mailer.capture({
      to,
      type: message.type,
      ...('code' in message && typeof message.code === 'string' && { code: message.code }),
    })
    return
  }
  if (isTestAddress(to)) {
    // Nobody has such a mailbox (`.invalid` cannot be delivered to), and the deployment's
    // relay is never handed one: whatever asked is answered as for any address.
    logger.info('email not sent: the address is in the reserved test domain', {
      environmentId: tenant.environmentId,
      kind: templateKind(message),
    })
    return
  }
  const { app, emails } = await Settings.current(deps, tenant)
  const kind = templateKind(message)
  // Own keys only: a kind is one of a fixed list, but the map came from storage.
  const template = Object.hasOwn(emails.templates, kind) ? emails.templates[kind] : undefined
  const rendered = renderTemplate(app, message, template)
  for (const { part, reason } of rendered.unused) {
    logger.warn('email template not used: the built-in copy was sent for that part', {
      environmentId: tenant.environmentId,
      kind,
      part,
      reason,
    })
  }
  await deps.mailer.send({ to, ...rendered.message })
}
