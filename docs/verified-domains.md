# Verified domains

An organization can **claim an email domain** such as `acme.com` by proving it can read mail
there. People who then sign up with a verified address on that domain are either offered the
organization or joined to it, without anyone sending an invitation. It is how a company's
colleagues find their workspace by themselves.

Verified domains are part of [organizations](organizations.md), so they exist only while an
environment has [`organizations.enabled`](organizations.md#turn-organizations-on) on: while it is
off every route answers `organization.disabled` (403), nobody is offered an organization and
nobody is joined. The design and its reasons are in
[ADR 0065](adr/0065-organizations.md).

> [!IMPORTANT]
> A domain is believed for **a year**, not for ever. A domain can be lost and registered again
> by someone else, and nothing tells Tula. After 365 days an unrenewed claim matches nobody
> until a manager proves the domain again with a new code. See [A verification
> lasts a year](#a-verification-lasts-a-year).

## Claim a domain

Verification is an emailed code, not a DNS record. Claiming a domain takes three things: the
domain, an address that is **exactly on it**, and what a verified domain should do (`mode`).

:::steps

### Ask for a code

Give the domain, an address on it and a mode. The address receives a six-digit code in the
`organization_domain_verification` email ([email templates](email-templates.md)). The claim is
**pending** and grants nothing until the code is entered.

The address must be on the domain itself: `it@mail.acme.com` does not prove `acme.com`
(`organization.domain_address_mismatch`, 422). The domain is written in lower case, as a mail
server writes it; an internationalised name goes in punycode (`xn--bcher-kva.example`), because
Unicode is refused, not converted.

### Enter the code

The code lives **ten minutes** and allows **five guesses**. A new request replaces it and
starts the count again. Entering it makes the claim `verified`, sets `verifiedAt` and
`expiresAt` and clears the code.

Two organizations can have a pending claim on one name at once; when both enter their code, the
database lets one succeed and the other is told `organization.domain_taken`.

### Choose what it does

`mode` can be changed at any time without a new code. Setting `auto_join` is a *weakening*: it
adds people with no human step, so the change is recorded with `weakened: true`.

:::

:::tabs{sync="domain"}

#### Admin API

With the secret key. The address is free text that you type, so the code goes wherever you say.

<!-- snippet: examples/docs-snippets/organization-joining.ts#admin-claim-domain -->
```ts
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
```
<!-- /snippet -->

#### Client

For a signed-in member whose role holds `org:sys:domains:manage`. The server reads the role on
every call, never from the token, so a demoted manager is refused at once.

<!-- snippet: examples/docs-snippets/organization-joining.ts#core-claim-domain -->
```ts
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
```
<!-- /snippet -->

:::

A domain can be removed at any time. Removing it stops later offers and joins and **keeps the
members it brought**. An organization holds at most **10** domains, pending and verified
together (`organization.domain_limit`, 409). The prebuilt
[Domains tab](organization-profile.md#domains) and the dashboard's organization page do all of
this with screens.

## Suggest and auto-join

| `mode` | A user with a verified address on the domain… |
| --- | --- |
| `suggest` | …is **offered** the organization, and joins it themselves if they choose to. |
| `auto_join` | …becomes a member **when they sign up**, with the environment's [`defaultRole`](organizations.md#turn-organizations-on). Others are offered it. |

`auto_join` happens **when the account is created** (a sign-up, or a first sign-in that creates it). Signing in to an existing account never joins anyone, for two reasons: a member an
administrator removed would otherwise rejoin at their next sign-in, so "remove" would mean
nothing; and an account that existed before the domain was verified got its address long
before the claim. Those users, and everyone in `suggest` mode, are offered the organization
instead. Both modes feed the same suggestions.

The match is strict:

- only an address that is **verified** counts;
- only the **exact** domain: `ada@mail.acme.com` never matches `acme.com`;
- a banned user matches nothing;
- the role is always the environment's `defaultRole`, never one the domain chooses;
- a lapsed claim matches nobody (below);
- a public mail domain never matches, even for a claim stored before the list grew.

Joining at sign-up never fails the sign-up: if the join cannot be made the sign-up completes
and the error is logged.

### Offer the organizations

`suggestions` lists the organizations the signed-in user's verified address leads to, and `join`
makes them a member. The server decides again on `join`: a domain that was removed, an address that
changed or a user who was banned in the meantime is `organization.suggestion_unavailable` (403),
the same code for an organization that does not exist, so it tells a user nothing about what
exists. A suggestion carries the organization's id, name and slug and nothing about its members.

<!-- snippet: examples/docs-snippets/organization-joining.ts#core-suggestions -->
```ts
const { data: suggestions } = await tula.organizations.suggestions()
const [first] = suggestions
if (first) {
  // The server decides again, and gives the environment's `defaultRole`.
  const organization = await tula.organizations.join(first.id)
  await tula.organizations.setActive(organization.id)
}
```
<!-- /snippet -->

[`<OrganizationSwitcher>`](organization-switcher.md) lists them under "You can join".

## Domains that cannot be claimed

A **public mail domain** proves nothing about its holder, since anyone can get an address there.
The deny list (`PUBLIC_EMAIL_DOMAINS` and `PUBLIC_EMAIL_BRANDS` in
`@tula-tech/contract/organization-domain-rules`) is the large free mailbox providers
(`gmail.com`, `outlook.com`, `icloud.com`, `proton.me`, `aol.com`, …), the internet providers
that give every customer an address, forwarding aliases and relays (`duck.com`, Apple's private
relay) and disposable inboxes. A provider that sells mailboxes under many country domains
(`yahoo.co.uk`, `hotmail.fr`) is listed as a brand, and every country domain of it counts. A
company's own domain is never on the list. Claiming one is `organization.domain_public` (422).

The same function runs when a user would join, so a claim stored before the list grew matches
nobody.

A name another organization **has verified and that has not lapsed** is `organization.domain_taken`
(409). Asking spends one of the organization's ten codes of the hour even when the answer is
"taken", so a manager cannot probe which names are claimed elsewhere at no cost.

## A verification lasts a year

A verified domain carries `expiresAt`, 365 days after the code was entered, and a `status`:

| `status` | Meaning | Matches users? |
| --- | --- | --- |
| `pending` | A code was sent and not entered. `verifiedAt` and `expiresAt` are `null`. | No |
| `verified` | The code was entered and `expiresAt` is in the future. | Yes, by `mode` |
| `needs_reverification` | `expiresAt` has passed. | **No** |

The status is worked out from the date and the clock, not stored as a word that something has to
flip, so a stopped job or a skewed timer cannot leave a lapsed domain matching. A lapsed domain
loses nothing else: its row, its `mode` and the members it brought stay, and nothing is deleted.

### Prove it again with a new code

Claim the same domain again with the same call as the first time. It emails a new code to an
address on the domain; entering it restarts the year (`organization_domain.verified` is recorded
with `reverified: true`). Until then a domain that has not lapsed **keeps working**, with its
mode, and asking does not change the mode (the request's `mode` is ignored; change it with
`update`). A lapsed domain with no code waiting answers `verification.expired` on `verify`: ask
for a code first.

<!-- snippet: examples/docs-snippets/organization-joining.ts#admin-reverify-domain -->
```ts
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
```
<!-- /snippet -->

### Reminders

A daily job emails the organization's managers **30 days and 7 days** before a verification lapses
(the members whose role holds `org:sys:domains:manage`, at most 10, with a verified address and
not banned). Each reminder is sent once per verification, however many API instances run the job;
verifying again starts the series over. One email covers all the organization's domains at that
threshold.

The `organization_domain_expiring` email names the organization and **how many** domains, never
a domain, and carries no code and no link: a domain name reads as a link, and a reminder should
not be mistaken for a phishing attempt. Open the organization's domain settings and ask for a
code there. Its wording is an [email template](email-templates.md) you can change.

A domain verified before verification had a lifetime has **at least 30 days** from the upgrade, so
nobody is cut off the day it ships and every manager is reminded first.

### A lapsed name can be claimed again

While a verification holds, the name is that organization's alone. Once it has lapsed, whoever
proves the domain now takes it: the earlier claim is removed when the new one is verified, and
its members stay members. A claim that is pending is never kept for ever either: it is deleted an
hour after its code expired, while a verified domain is never purged.

## Limits

Codes cost mail and can be aimed at an address someone else owns, so sending is limited on
several axes at once.

| Limit | Value |
| --- | --- |
| A code | 6 digits, valid 10 minutes, 5 guesses |
| Codes one organization sends | 1 a minute and 10 an hour |
| Codes in a day: an organization an administrator made | 30 |
| Codes in a day: an organization a user created | 10 |
| Codes in a day: all the organizations one user created, together | 20 |
| Codes in a day: the whole environment | 200 |
| Codes sent to one address | 5 an hour |
| Domains in one organization | 10 |
| Verifying a code, per IP | 10 a minute |
| Claiming, changing, removing or joining a suggestion, per IP | 20 a minute |
| Reading the domains or the suggestions, per IP | 60 a minute |

The lower caps for a **user-created** organization keep a few of them from spending the
environment's whole allowance and delaying every other claim to the next day. An administrator
who needs more makes the organization from the admin API, which keeps the higher cap.

A wrong code counts before it is compared, and a sixth guess meets a back-off that grows with
every further wrong code even if it is the right code. Over any limit the answer is
`rate_limited` (429) with `Retry-After`.

## Error codes

| Code | Status | When |
| --- | --- | --- |
| `organization.disabled` | 403 | Organizations are off in this environment. |
| `organization.not_a_member` | 403 | The user is not in the organization, or it does not exist. |
| `auth.forbidden` | 403 | A member whose role lacks `org:sys:domains:manage`. |
| `organization.domain_public` | 422 | A public mail domain cannot be claimed. |
| `organization.domain_address_mismatch` | 422 | The address is not exactly on the domain. |
| `organization.domain_taken` | 409 | Another organization has verified the domain, and it has not lapsed. |
| `organization.domain_limit` | 409 | The organization holds 10 domains already. |
| `verification.invalid_code` | 422 | A wrong code; it says how many guesses remain. |
| `verification.too_many_attempts` | 429 | The code's five guesses are used. |
| `verification.expired` | 410 | The code lapsed or was replaced, or a lapsed domain has no code waiting. |
| `organization.suggestion_unavailable` | 403 | The organization cannot be joined from this account. |
| `organization.member_exists` | 409 | The user is a member of it already. |
| `rate_limited` | 429 | A limit above was reached. |

## What is recorded

`organization_domain.claimed`, `.verified`, `.updated` and `.removed` are [events and audit
entries](webhooks.md) targeting the domain. They hold the organization's id, the domain (public,
and the one name allowed in its own field), the mode and, where `auto_join` is chosen,
`weakened: true`. **They never hold the address the code was sent to.** A member added by a
domain gets `organization_membership.added` with `via` set to `domain_auto_join` or
`domain_suggestion`; the actor of an automatic join is the system.

## See also

- [Invitations](invitations.md): the other way to join an organization.
- [`<OrganizationProfile>`](organization-profile.md#domains) and
  [`<OrganizationSwitcher>`](organization-switcher.md): the screens.
- [Organizations](organizations.md) and [Roles and permissions](roles-and-permissions.md).
- [ADR 0065](adr/0065-organizations.md): the decisions behind all of this.
