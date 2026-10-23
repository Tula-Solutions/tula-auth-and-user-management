---
"@tula-tech/expo": patch
---

Organizations in the native clients (ADR 0065, Orgs 09). `@tula-tech/expo` re-exports `readInvitationLink`, `InvitationLink` and the organization types of `@tula-tech/core` (`UserOrganization`, `UserOrganizationList`, `ActiveOrganization`, `InvitationPreview`, `AcceptedInvitation`, `OrganizationInvitation`, `OrganizationSuggestion`), so one import serves an organization screen; its client already has `client.organizations`. The Swift and Kotlin clients, which are not npm packages, gain `organizations` with the same calls (list, create, set or clear the active organization, invitations, suggestions and joining), the active organization read from the access token's claims and `TulaInvitationLink`; their docs and a journey for each organization scenario are in the same change.
