# Invitations

An invitation asks one email address to join an [organization](organizations.md) with a role. The
invitee gets an email with a single-use link; they open it, sign in or sign up with that address,
and accept or decline. Nothing is granted until they accept, and nobody joins through a link
that was sent to someone else.

Invitations are part of organizations, so they exist only while an environment has
[`organizations.enabled`](organizations.md#turn-organizations-on) on. While it is off every route
below answers `organization.disabled` (403). The design and its reasons are in
[ADR 0065](adr/0065-organizations.md).

## How an invitation works

| Step | What happens |
| --- | --- |
| Invite | A member whose role holds `org:sys:invitations:manage`, or your server with the secret key, gives an address, a role key and a `redirectUrl`. |
| Email | The address is sent the `organization_invitation` email ([email templates](email-templates.md)). Its link is your `redirectUrl` followed by `#tula_invitation=<token>`. |
| Open | Your page reads the token from the fragment, takes it out of the address bar and shows what is on offer. This needs no session. |
| Answer | The signed-in account whose **verified** email is the invited address accepts (it becomes a member with the invitation's role) or declines. |

An invitation is **pending** until it is answered, withdrawn or out of time. Its `status` is one
of `pending`, `accepted`, `declined`, `revoked` and `expired`. `expired` is not stored: it is a
pending invitation whose seven days are over.

:::steps

### Pick the page the link leads to

`redirectUrl` is the page that will read the token. It must be listed in the environment's
[`urls.allowedRedirectUrls`](self-host.md#settings-of-an-environment) and is matched **exactly**. It
must be an `https` address, or a loopback one in the `local` tier. A custom scheme such as
`myapp://join` is refused, because the link is opened from an email in a browser: a native app
opens its page through an app link ([native apps](native-apps.md)).

### Send it

From your server, with the secret key, you can invite to any role. From a signed-in member's
client, the role must be one whose permissions the inviter holds **all of** themselves
(`organization.role_not_assignable` otherwise), so nobody can hand out more than they have.

:::tabs{sync="invite"}

#### Admin API

<!-- snippet: examples/docs-snippets/organization-joining.ts#admin-invite -->
```ts
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
```
<!-- /snippet -->

#### Client

<!-- snippet: examples/docs-snippets/organization-joining.ts#core-invite -->
```ts
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
```
<!-- /snippet -->

:::

The answer is the invitation (its `id`, `email`, `role`, `status`, `invitedBy` and `expiresAt`).
**It never holds the token**: that is only in the email. If the email cannot be sent the
invitation is withdrawn again and the error is raised, so no invitation is left that nobody can
open.

### Read the token on your page

The token travels in the URL **fragment** (`#tula_invitation=…`), which a browser never sends to a
server: it is in no server log and in no `Referer`. `readInvitationLink` reads it and gives back
the address without it, to put in the address bar before anything else happens.

<!-- snippet: examples/docs-snippets/organization-joining.ts#core-accept-invitation -->
```ts
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
```
<!-- /snippet -->

`preview` answers the organization's name, the role's key, the invited address and the expiry,
for a pending invitation only. It exists so that a sign-up can be prefilled; the token is the
proof of having been sent it. The token is always sent in a request body, never in a path or a
query.

With React, hand the token to `<OrganizationSwitcher invitationToken>`, which shows the offer
with "Accept" and "Decline": see [An invitation link](organization-switcher.md#an-invitation-link).

:::

## Invitations for the signed-in user

A signed-in user does not need the link to find an invitation: `mine()` lists the pending
invitations addressed to their own **verified** address (an unverified address has none), newest
first, as an `id`, the organization's name, the role's key and the expiry, never a token.
`acceptMine(id)` and `declineMine(id)` answer one by its `id`, with exactly the checks of
`accept` and `decline`; an `id` that is not the user's own is `organization.invitation_not_found`.

<!-- snippet: examples/docs-snippets/organization-joining.ts#core-my-invitations -->
```ts
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
```
<!-- /snippet -->

[`<OrganizationSwitcher>`](organization-switcher.md) draws this list under "Invitations for you",
each with "Accept" and "Decline", so a user who lost the email still finds the invitation.

## Accepting and declining

Accepting needs a signed-in session, and the server checks two things about it:

- the session's email, normalized, **is the invited address** (`organization.invitation_wrong_account`
  otherwise), and
- that address is **verified** (`organization.invitation_email_unverified` otherwise). An
  address nobody has proven is not a reason to let someone in.

Accepting uses the invitation up and creates the membership in one transaction, with the
invitation's role. The session does not switch by itself: call `setActive` (or let the switcher do
it). A user who is a member already gets `organization.member_exists` (409) and the invitation
stays pending. Declining uses the invitation up and joins nobody. Either way the link cannot be
used again.

A link forwarded to someone else joins nothing: the check is on the account, not on who holds
the link.

## Seven days

An invitation can be answered for **seven days** after it was sent (`INVITATION_EXPIRY_DAYS`).
After that its link answers `organization.invitation_expired`. Inviting an address whose pending
invitation has lapsed replaces it in the same transaction; inviting one whose invitation is still
pending is `organization.invitation_exists`. At most one invitation per organization and address
is pending at a time. The retention job deletes an invitation seven days after it expired,
whatever became of it, because the row holds an address ([retention](adr/0017-retention.md)).

## A role that was deleted

An invitation stores the role's **key**, not a link to the role, so deleting a custom role is
never blocked by a pending invitation. If the role is gone when the invitation is accepted, the
server answers `organization.invitation_role_gone` (409) and the invitation **stays pending**.
It is never given the environment's `defaultRole` instead: that would grant access the inviter
did not choose. To fix it, withdraw the invitation and invite again with a role that exists.
Declining does not need the role, so an invitee can still turn it down.

## Error codes

| Code | Status | When |
| --- | --- | --- |
| `organization.disabled` | 403 | Organizations are off in this environment. |
| `organization.not_a_member` | 403 | The signed-in user is not in the organization (or it does not exist: the answer is the same). |
| `organization.permission_required` | 403 | The member's role lacks `org:sys:invitations:manage`. |
| `organization.role_not_assignable` | 403 | The inviter does not hold every permission of the role they offered. Admin API calls are not limited this way. |
| `organization.role_unknown` | 422 | The role key names no role of the environment. |
| `organization.member_exists` | 409 | The address already belongs to a member. |
| `organization.invitation_exists` | 409 | The address already has a pending invitation to this organization. |
| `organization.invitation_not_found` | 404 | No invitation has this token or id. |
| `organization.invitation_expired` | 410 | More than seven days have passed. |
| `organization.invitation_revoked` | 410 | It was withdrawn. |
| `organization.invitation_used` | 410 | It was already accepted or declined. |
| `organization.invitation_wrong_account` | 403 | The signed-in account is not the invited address. |
| `organization.invitation_email_unverified` | 403 | It is the invited address, but unverified. |
| `organization.invitation_role_gone` | 409 | The invitation's role was deleted; it stays pending. |
| `request.redirect_not_allowed` | 400 | `redirectUrl` is not one of the environment's allowed redirect URLs, or uses a custom scheme. |
| `rate_limited` | 429 | A limit below was reached; `Retry-After` says when to try again. |

Codes are stable and never reused, and the documentation site gives each one an address of its own.

<!-- snippet: examples/docs-snippets/organization-joining.ts#core-invitation-errors -->
```ts
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
```
<!-- /snippet -->

## Limits

| Limit | Value |
| --- | --- |
| Invitations one organization sends | 50 an hour |
| Invitations one environment sends | 1,000 a day, the admin API's included |
| Reads (the list of an organization's invitations), per IP | 60 a minute |
| Inviting, withdrawing, accepting, declining and previewing, per IP and route | 20 a minute |

A request over a limit is `rate_limited` (429) with a `Retry-After`. The counters hold ids and
never an address or an IP. If the store behind them cannot answer, the request is refused
(`service.unavailable`, 503), never let through.

## What is recorded

Each step is an [event and an audit entry](webhooks.md): `organization_invitation.created`,
`.accepted`, `.declined` and `.revoked`, targeting the invitation. They hold the organization's id
and the role's key (and the user's id for accepted and declined), never the address or the
token. Accepting also records `organization_membership.added`.

The email's wording is the `organization_invitation` [email template](email-templates.md): it
has the placeholders `link` (required), `appName` and `expiresInDays`. The organization's name
reaches the default wording safely escaped, and no text the inviter typed does.

## The screens

- [`<OrganizationProfile>`](organization-profile.md#invitations): the Invitations tab invites,
  lists and withdraws.
- [`<OrganizationSwitcher>`](organization-switcher.md#an-invitation-link): shows an invitation
  the user opened, with "Accept" and "Decline".
- The dashboard's organization page lists, sends and withdraws invitations ([dashboard](dashboard.md#screens)).

## See also

- [Verified domains](verified-domains.md): the other way to join an organization, by the address
  you sign up with.
- [Organizations](organizations.md) and [Roles and permissions](roles-and-permissions.md).
- [ADR 0065](adr/0065-organizations.md): the decisions behind all of this.
