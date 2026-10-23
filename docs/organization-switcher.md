# OrganizationSwitcher

`<OrganizationSwitcher>` is the prebuilt control that shows which organization the signed-in user is acting in and lets them change it. It lists the organizations they belong to, the personal account where the environment allows one, the organizations their email domain offers, an invitation they opened, and the way to create or manage an organization. It is in `@tula-tech/react` and, with the same props, in `@tula-tech/nextjs`.

Read [Organizations](organizations.md) first for what an active organization is. The other two pieces are [`<CreateOrganization>`](create-organization.md) and [`<OrganizationProfile>`](organization-profile.md).

## Try it

:::playground{preset="organizations"}

A live sandbox of the three organization components with a panel to switch organizations on and off. It needs a browser with script. Sign in as `ada@example.test`: she belongs to Acme as an admin and to Globex as a member, has an invitation to Hooli, and is offered Initech through her email domain.

:::

## Use it

Inside a `<TulaProvider>`, for a signed-in user. Give the provider the pages the switcher links to, so that "Manage organization" and "Create organization" open your routes and not a dialog.

```tsx
import { OrganizationSwitcher, TulaProvider } from '@tula-tech/react'
import '@tula-tech/react/styles.css'

<TulaProvider
  publishableKey={import.meta.env.VITE_TULA_PUBLISHABLE_KEY}
  organizationProfileUrl='/organization'
  createOrganizationUrl='/organization/new'
>
  <OrganizationSwitcher onSwitch={() => router.refresh()} />
</TulaProvider>
```

A switch is a new access token with another `org_id`. Anything your app read from the session before (server components, a query cache) is stale after it: refresh it in `onSwitch`. In Next.js the route handler sets the new cookies before `onSwitch` runs, so `router.refresh()` is enough.

## Props

| Prop | Type | What it does |
| --- | --- | --- |
| `onSwitch` | `(organizationId: string \| null) => void` | Called after the active organization changed. `null` is the personal account. |
| `invitationToken` | `string` | The token of an invitation the user opened. The switcher shows what it offers, with "Accept" and "Decline". |
| `onInvitationHandled` | `(outcome: 'accepted' \| 'declined') => void` | Called once the invitation was answered, so that your app can forget the token. |
| `organizationProfileUrl` | `string` | Where `<OrganizationProfile>` lives. Overrides the provider's value. Without either, "Manage organization" opens the profile in a dialog. |
| `createOrganizationUrl` | `string` | Where `<CreateOrganization>` lives. Overrides the provider's value. Without either, "Create organization" opens the form in a dialog. |
| `appearance` | `Appearance` | Theme tokens, colour scheme and class names for this component. |

A destination is only ever a prop (or the provider's), and is checked to be a relative path or an `http(s)` address, as every other destination in the components.

## An invitation link

An invitation email links to the page you named when you invited (`invitationUrl` of [`<OrganizationProfile>`](organization-profile.md#invitations), or the provider's). The token is in the URL fragment, which a browser never sends to a server. Read it once, take it out of the address bar and hand it to the switcher:

```tsx
import { OrganizationSwitcher, readInvitationLink } from '@tula-tech/react'
import { useEffect, useState } from 'react'

function Organizations() {
  const [token, setToken] = useState<string>()
  useEffect(() => {
    const link = readInvitationLink(window.location.href)
    if (link) {
      window.history.replaceState(null, '', link.cleanUrl)
      setToken(link.token)
    }
  }, [])
  return <OrganizationSwitcher invitationToken={token} onInvitationHandled={() => setToken(undefined)} />
}
```

The server decides again: only the account the invitation was sent to, with its email address verified, can answer it. Another account gets the message "This invitation was sent to another email address." An expired, revoked or used invitation says which.

## What it shows

| State | What the user sees |
| --- | --- |
| Signed out, or organizations off in the environment | Nothing. |
| Loading | The button says "Loading your organizations…". |
| The list could not be read | The reason, and "Try again". |
| Open | The user's organizations (the current one marked), "Personal account" where the environment has one, "You can join" suggestions, "Manage organization" where the role holds a permission to manage, and "Create organization" where users may create them. |
| An invitation was handed over | An "Invitation" card with the organization, the role, "Accept" and "Decline". |
| A switch failed | The error in the open panel; the current organization stays. |

The button is named "Organization: <name>" (or "Organization: Personal account"), and "… You have an invitation." while one is waiting. The panel is a disclosure: Escape closes it and returns the focus to the button, as does a click or the focus moving outside. A result that arrives after the user signed out, or after another user signed in, is dropped.

## Words and styling

The words are the `organizationSwitcher` group of the [localization](reference/react.md); the shared ones (`organizations`) are reused. The parts you can style by `appearance.elements` are `organizationSwitcher`, `organizationSwitcherTrigger`, `organizationPanel`, `organizationList` and `organizationItem`; the dialogs reuse the ones of [`<OrganizationProfile>`](organization-profile.md#words-and-styling) and `<CreateOrganization>`.

## See also

- [`<CreateOrganization>`](create-organization.md) and [`<OrganizationProfile>`](organization-profile.md).
- [Organizations](organizations.md): the active organization, the claims and `has()`.
- [Roles and permissions](roles-and-permissions.md): what a role allows.
