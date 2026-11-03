---
"@tula-tech/contract": minor
"@tula-tech/core": minor
"@tula-tech/admin": minor
"@tula-tech/react": patch
"@tula-tech/nextjs": patch
"@tula-tech/expo": patch
---

Invitations to an organization by email (ADR 0065, Orgs 04). `@tula-tech/core` gets `client.organizations.invitations` (`invite`, `list`, `revoke`, `preview`, `accept`, `decline`) and `readInvitationLink(url)`, which reads the token from the `#tula_invitation=…` fragment of the emailed link and returns the URL without it. Only the account the invitation was sent to, with that address verified, can accept or decline it; the token is single use, valid for 7 days, stored only as a hash and never in a response. `@tula-tech/admin` gains the admin routes (`GET`/`POST /v1/admin/organizations/{id}/invitations`, `DELETE …/{invitationId}`). The contract gains the invitation schemas, the email kind `organization_invitation` (with the template placeholder `expiresInDays`; there is none for the organization's name or the address), the permission constant `INVITATIONS_MANAGE_PERMISSION`, four activity types (`organization_invitation.created`, `.accepted`, `.declined`, `.revoked`) and ten error codes (`organization.permission_required`, `.role_not_assignable`, `.invitation_exists`, `.invitation_not_found`, `.invitation_expired`, `.invitation_revoked`, `.invitation_used`, `.invitation_wrong_account`, `.invitation_email_unverified`, `.invitation_role_gone`). `@tula-tech/react`, `@tula-tech/nextjs` and `@tula-tech/expo` only carry the new types and error codes.
