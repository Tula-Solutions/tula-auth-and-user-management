import type { Deps, Tenant } from '~/dependencies'
import * as Email from '~/modules/email/service'

/** What an invitation email needs. */
export interface InvitationEmail {
  /** The invited address, as the inviter typed it. */
  to: string
  /** The organization's name: user text, escaped and cleaned by `~/modules/email`. */
  organizationName: string
  /** The link: the redirect URL followed by `#tula_invitation=<token>`. */
  linkUrl: string
  /** Days until the link stops working. */
  ttlDays: number
}

/**
 * Send the email that invites an address to an organization.
 *
 * The layout and the copy live in `~/modules/email`. Nothing the inviter typed besides the
 * address (which only says where it goes) reaches the message: the organization's name is
 * the one piece of user text in it, and it goes through `displayName` and `escapeHtml` there.
 *
 * @param deps - The mailer, settings store and config.
 * @param tenant - The environment the invitation is for.
 * @param email - Recipient, organization name, link and expiry.
 * @throws Error when the relay fails (see {@link Mailer.send}). Callers must not log the
 *   message: it holds the link.
 */
export async function sendInvitation(
  deps: Pick<Deps, 'mailer' | 'environmentSettings' | 'config'>,
  tenant: Pick<Tenant, 'environmentId'>,
  email: InvitationEmail
): Promise<void> {
  await Email.send(deps, tenant, email.to, {
    type: 'organization_invitation',
    organizationName: email.organizationName,
    linkUrl: email.linkUrl,
    ttlDays: email.ttlDays,
  })
}
