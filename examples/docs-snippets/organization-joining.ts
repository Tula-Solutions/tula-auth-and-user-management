import { createAdminClient, isTulaAdminError } from '@tula-tech/admin'
import { createTulaClient, isTulaError, readInvitationLink } from '@tula-tech/core'

// The invitation and verified-domain calls shown in docs/invitations.md and
// docs/verified-domains.md, through `@tula-tech/admin` (the operator's side, with the secret
// key) and `@tula-tech/core` (the signed-in user's side). Copied by region
// (`bun run docs:generate`) and compiled by `bun run typecheck:scripts`. Nothing here runs.

/** The environment's secret key (`tula_sk_…`), read from the server's own configuration. */
declare const secretKey: string

const admin = createAdminClient({ baseUrl: 'https://auth.example.com', secretKey })
const tula = createTulaClient({
  publishableKey: 'tula_pk_dev_…',
  baseUrl: 'https://auth.example.com',
})

/** Invite an address from the server, read the pending invitations and withdraw one. */
export async function inviteFromTheServer(organizationId: string) {
  // #region admin-invite
  // The link leads to `redirectUrl`, which must be one of the environment's allowed redirect
  // URLs, with the token in its fragment: `https://app.example.com/join#tula_invitation=…`.
  const { data: invitation } = await admin.call('inviteToOrganization', {
    params: { id: organizationId },
    body: {
      email: 'ada@example.com',
      role: 'member',
      redirectUrl: 'https://app.example.com/join',
    },
  })
  // invitation.status === 'pending'; invitation.expiresAt is seven days away.

  // Pending invitations, newest first. Ask for another state with `status`.
  const { data: pending } = await admin.call('listOrganizationInvitations', {
    params: { id: organizationId },
    query: { status: 'pending' },
  })

  // Withdraw one: its link stops working.
  await admin.call('revokeOrganizationInvitation', {
    params: { id: organizationId, invitationId: invitation.id },
  })
  // #endregion
  return pending
}

/** Tell a refusal of the admin API's invitation call apart. */
export async function inviteOrExplain(organizationId: string) {
  // #region admin-invite-errors
  try {
    await admin.call('inviteToOrganization', {
      params: { id: organizationId },
      body: {
        email: 'ada@example.com',
        role: 'viewer',
        redirectUrl: 'https://app.example.com/join',
      },
    })
  } catch (error) {
    if (isTulaAdminError(error) && error.code === 'organization.role_unknown') {
      // The role key names no role of this environment.
    } else if (isTulaAdminError(error) && error.code === 'rate_limited') {
      // 50 an hour for the organization, 1000 a day for the environment.
    } else {
      throw error
    }
  }
  // #endregion
}

/** A signed-in member with `org:sys:invitations:manage` invites an address. */
export async function inviteFromTheClient(organizationId: string) {
  // #region core-invite
  try {
    // The role must be one whose permissions the inviter holds all of themselves.
    const invitation = await tula.organizations.invitations.invite(organizationId, {
      email: 'ada@example.com',
      role: 'member',
      redirectUrl: 'https://app.example.com/join',
    })
    // The token is only in the email. Nothing here can read it.
    return invitation
  } catch (error) {
    if (isTulaError(error) && error.code === 'organization.invitation_exists') {
      // That address has a pending invitation already: withdraw it, or wait for it to lapse.
    }
    throw error
  }
  // #endregion
}

/** The page an invitation link leads to: read the token once, show the offer, answer it. */
export async function answerAnInvitation() {
  // #region core-accept-invitation
  const link = readInvitationLink(window.location.href)
  if (!link) {
    return null
  }
  // Take the token out of the address bar before anything else, so it stays out of the history.
  history.replaceState(null, '', link.cleanUrl)

  // No session needed: enough to prefill a sign-up with the invited address.
  const offer = await tula.organizations.invitations.preview(link.token)
  // offer: { organizationName, role, email, expiresAt }

  // Accepting needs a signed-in account whose verified address is the invited one.
  const joined = await tula.organizations.invitations.accept(link.token)
  await tula.organizations.setActive(joined.id)

  // Or turn it down: nobody joins and the link is used up.
  // await tula.organizations.invitations.decline(link.token)
  return { offer, joined }
  // #endregion
}

/** Tell the reasons an invitation cannot be accepted apart. */
export async function whyNotAccepted(token: string) {
  // #region core-invitation-errors
  try {
    await tula.organizations.invitations.accept(token)
  } catch (error) {
    if (!isTulaError(error)) {
      throw error
    }
    switch (error.code) {
      case 'organization.invitation_wrong_account':
        // Signed in as someone else: offer to switch accounts.
        break
      case 'organization.invitation_email_unverified':
        // The right address, not yet proven: send them through email verification first.
        break
      case 'organization.invitation_role_gone':
        // The role was deleted after the invitation was sent. Nobody joins; ask for a new one.
        break
      case 'organization.invitation_expired':
      case 'organization.invitation_revoked':
      case 'organization.invitation_used':
        // The link is dead: ask the inviter to send a new one.
        break
      default:
        throw error
    }
  }
  // #endregion
}

/** The server claims a domain for an organization and proves it with the emailed code. */
export async function claimFromTheServer(organizationId: string, code: string) {
  // #region admin-claim-domain
  // Emails a six-digit code to an address that is exactly on the domain. Until the code is
  // entered the claim is `pending` and matches nobody.
  const { data: claim } = await admin.call('startOrganizationDomain', {
    params: { id: organizationId },
    body: { domain: 'acme.com', email: 'it@acme.com', mode: 'suggest' },
  })

  // Five wrong guesses use the code up; it lives ten minutes.
  const { data: verified } = await admin.call('verifyOrganizationDomain', {
    params: { id: organizationId, domainId: claim.id },
    body: { code },
  })
  // verified.status === 'verified'; verified.expiresAt is a year away.

  // Change what the domain does. `auto_join` is a weakening: it adds people with no human step.
  await admin.call('updateOrganizationDomain', {
    params: { id: organizationId, domainId: claim.id },
    body: { mode: 'auto_join' },
  })
  // #endregion
  return verified
}

/** Find the domains that have lapsed and ask for a new code for each. */
export async function reverifyLapsedDomains(organizationId: string) {
  // #region admin-reverify-domain
  const { data: domains } = await admin.call('listOrganizationDomains', {
    params: { id: organizationId },
  })
  for (const domain of domains.data) {
    if (domain.status === 'needs_reverification') {
      // The same call as the first claim. The new code restarts the year once it is entered;
      // `mode` is ignored here, so change it with `updateOrganizationDomain`.
      await admin.call('startOrganizationDomain', {
        params: { id: organizationId },
        body: { domain: domain.domain, email: `it@${domain.domain}`, mode: domain.mode },
      })
    }
  }
  // #endregion
}

/** A manager claims a domain from the client, with the permission `org:sys:domains:manage`. */
export async function claimFromTheClient(organizationId: string, code: string) {
  // #region core-claim-domain
  try {
    const claim = await tula.organizations.domains.start(organizationId, {
      domain: 'acme.com',
      email: 'ada@acme.com',
      mode: 'suggest',
    })
    return await tula.organizations.domains.verify(organizationId, claim.id, code)
  } catch (error) {
    if (isTulaError(error) && error.code === 'organization.domain_taken') {
      // Another organization holds a verification of that domain that has not lapsed.
    }
    throw error
  }
  // #endregion
}

/** Offer a user the organizations their verified address leads to, and let them join one. */
export async function joinFromASuggestion() {
  // #region core-suggestions
  const { data: suggestions } = await tula.organizations.suggestions()
  const [first] = suggestions
  if (first) {
    // The server decides again, and gives the environment's `defaultRole`.
    const organization = await tula.organizations.join(first.id)
    await tula.organizations.setActive(organization.id)
  }
  // #endregion
}

/** List the invitations addressed to the signed-in user and answer one, with no token. */
export async function answerMyInvitations() {
  // #region core-my-invitations
  // Pending invitations to the user's own verified address, newest first. No token is involved:
  // the session and the address are the proof. An unverified address has none.
  const { data: mine } = await tula.organizations.invitations.mine()
  const [first] = mine
  if (first) {
    // first: { id, organizationName, role, expiresAt }
    const joined = await tula.organizations.invitations.acceptMine(first.id)
    await tula.organizations.setActive(joined.id)
    // Or turn it down: await tula.organizations.invitations.declineMine(first.id)
  }
  // #endregion
}
