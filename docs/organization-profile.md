# OrganizationProfile

`<OrganizationProfile>` is the prebuilt page for managing one organization: its details, members, invitations and verified domains. It draws only the tabs and controls the user's role permits, and the server checks every call again. It is in `@tula-tech/react` and in `@tula-tech/nextjs`. [`<OrganizationSwitcher>`](organization-switcher.md) links to it, or draws it in a dialog when you give it no page.

## Use it

```tsx
import { OrganizationProfile } from '@tula-tech/react'

export function OrganizationPage() {
  return (
    <OrganizationProfile
      invitationUrl='/organizations'
      afterLeaveUrl='/organizations'
      afterDeleteUrl='/organizations'
    />
  )
}
```

It manages the organization the session acts in. Name another one with `organizationId` (the user must be a member of it).

## Props

| Prop | Type | What it does |
| --- | --- | --- |
| `organizationId` | `string` | The organization to manage. Defaults to the active one. |
| `section` | `'general' \| 'members' \| 'invitations' \| 'domains'` | The tab to open first. A value this version does not know is shown as "This section is not supported", with a button to the general settings. |
| `invitationUrl` | `string` | The page an invitation email's link leads to. Overrides the provider's. Without either, the Invitations tab cannot send invitations. |
| `afterLeaveUrl` | `string` | Where to go after the user left the organization. |
| `afterDeleteUrl` | `string` | Where to go after the user deleted it. |
| `onGone` | `(kind: 'left' \| 'deleted', organizationId: string) => void` | Called after either, before any navigation. |
| `appearance` | `Appearance` | Theme tokens, colour scheme and class names. |
| `headingLevel` | `1` to `6` | The level of the title; the section titles are one below. |

## Which tabs a role sees

A tab is drawn when the user's role holds its permission (read from the organization list, which the API computes from the membership on every call). The tabs are read again when the profile opens, so a role changed since the list was fetched does not leave a control the server will refuse.

| Tab | Needs | What it does |
| --- | --- | --- |
| General | none | Shows the details. With `org:sys:organization:manage` the name and short name can be changed. Everyone can leave; with `org:sys:organization:delete` the organization can be deleted. |
| Members | `org:sys:memberships:read` or `:manage` | Lists the members and their roles. With `org:sys:memberships:manage` a role can be changed (among the roles the user may give) and a member removed. |
| Invitations | `org:sys:invitations:manage` | Invite an address with a role, see the pending invitations, revoke one. |
| Domains | `org:sys:domains:manage` | Claim a domain, verify it with the emailed code, choose what a verified domain does, remove it. |

With the built-in roles, an `admin` sees all four and a `member` sees General and Members.

## General

- **Rename.** The name and the short name; a taken short name is announced under its field.
- **Leave.** Asks first ("Leave <name>?"). The last member who can manage members cannot leave: the component shows "An organization must keep at least one member who can manage its members." and stays. Leaving the active organization moves the session to the personal account where the environment has one, otherwise to another organization.
- **Delete.** Asks for the organization's name to be typed; the button stays unavailable until it matches. Deleting removes the members, invitations and domains for good.

After either, the page says "You left <name>." or "<name> was deleted." with the focus on the title, then goes to `afterLeaveUrl` or `afterDeleteUrl`.

## Members

The user's own row is marked "You" and has no "Remove": leaving is on the General tab. Removing asks first and keeps the removed member's account. A change that would leave the organization without a member who can manage members is refused with `organization.last_manager` and the message is shown.

## Invitations

Needs the page the link leads to: `invitationUrl` here or on the provider. Without one the tab says "Invitations cannot be sent from here yet." and sends nothing. The invitee gets a single-use link that works for seven days; see [Invitations](invitations.md) for the server's side and [`<OrganizationSwitcher>`](organization-switcher.md#an-invitation-link) for the page that receives it. An address that is already a member, or already invited, is refused under the field.

## Domains

Claim a domain by giving it and an address on it; the code is emailed to that address. Typing the six digits verifies it (five guesses). A verified domain either suggests the organization to people who sign up with a verified address on it (`suggest`) or adds them (`auto_join`). A verification lasts a year: a domain whose year has passed is marked "Needs verifying again", matches nobody, and is offered a new code (see [Verified domains](verified-domains.md#a-verification-lasts-a-year)). A mode this version does not know is shown as "Not supported by this version" and kept as it is. A public email domain cannot be claimed, and a domain another organization verified is refused.

## When access changes

The server answers `organization.permission_required` or `auth.forbidden` when the user's role changed, and `organization.not_a_member` when they were removed. The component reads the user's organizations again and says "Your permissions in this organization changed. What you can do was updated." The control that was refused disappears; a user who is no longer a member is told "You are no longer a member of this organization." and the tabs go.

## Other states

| State | What the user sees |
| --- | --- |
| Signed out, or organizations off | Nothing. |
| No organization active (and no `organizationId`) | "No organization is active. You are using your personal account." |
| Loading | "Loading your organizations…". |
| The list could not be read | The reason and "Try again". |
| An unknown `section` | "This section is not supported" and "Show general settings". |

Every result belongs to the session it was asked for: an answer that arrives after sign-out is dropped, and so is its effect on the page.

## Words and styling

The words are the `organizationProfile` group of the [localization](reference/react.md). The parts you can style by `appearance.elements` are `tabList`, `tab`, `tabPanel`, `memberList`, `memberItem`, `invitationList`, `invitationItem`, `domainList`, `domainItem`, `select` and `dangerZone`, beside the shared ones. The tabs follow the ARIA tabs pattern: arrow keys, Home and End move between them and select them, and only the selected one is in the tab order.

## See also

- [`<OrganizationSwitcher>`](organization-switcher.md) and [`<CreateOrganization>`](create-organization.md).
- [Roles and permissions](roles-and-permissions.md): the permissions above and custom roles.
- [Invitations](invitations.md) and [Verified domains](verified-domains.md): the server's side of the two tabs.
- [Organizations](organizations.md): turning organizations on and the claims in the token.
