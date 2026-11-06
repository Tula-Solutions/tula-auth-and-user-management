# CreateOrganization

`<CreateOrganization>` is the prebuilt form that makes an organization. The user types a name, the short name follows it until they type their own, and the new organization becomes the one the session acts in. It is in `@tula-tech/react` and in `@tula-tech/nextjs`. [`<OrganizationSwitcher>`](organization-switcher.md) links to it, or draws it in a dialog when you give it no page.

## Use it

```tsx
import { CreateOrganization } from '@tula-tech/react'

export function NewOrganizationPage() {
  return <CreateOrganization afterCreateUrl='/organizations' />
}
```

## Props

| Prop | Type | What it does |
| --- | --- | --- |
| `afterCreateUrl` | `string` | Where to go once the organization exists. Without it the component says it was created. |
| `onCreated` | `(organization: UserOrganization) => void` | Called once the organization exists, before any navigation. |
| `switchToNew` | `boolean` | Make the new organization the active one. Defaults to `true`. |
| `appearance` | `Appearance` | Theme tokens, colour scheme and class names. |
| `headingLevel` | `1` to `6` | The level of the title. Defaults to 1. |

## What it shows

| State | What the user sees |
| --- | --- |
| Signed out | Nothing. |
| Organizations off, or users may not create them | "Creating organizations is not available here." |
| The form | "Create an organization": a "Name" field and a "Short name" field with its hint. |
| An empty field | The message under that field, the focus on the first one, nothing sent. |
| The short name is taken | "An organization with that slug already exists." under the field, with the focus on it. |
| The user's limit was reached, or creation is not allowed | The error above the form. |
| Too many tries | "Too many requests. Try again in …" with the wait. |
| Created | The title "Organization created" with the focus on it, and "<name> was created and is now the active organization." |
| Created, but the switch failed | "<name> was created, but switching to it failed. Choose it from the list." The form is not offered again. |

An answer that arrives after the session ended is dropped: it neither switches nor calls `onCreated`.

## Words and styling

The words are the `createOrganization` group of the [localization](reference/react.md) and the shared `organizations` group. The component uses the form parts every Tula component has (`card`, `field`, `button`, …); see the [React reference](reference/react.md) for their names.

## See also

- [`<OrganizationSwitcher>`](organization-switcher.md) and [`<OrganizationProfile>`](organization-profile.md).
- [Organizations](organizations.md): creating organizations from the client and the admin API, and who may.
