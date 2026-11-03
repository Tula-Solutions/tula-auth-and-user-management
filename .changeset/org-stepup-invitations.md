---
"@tula-tech/contract": minor
"@tula-tech/core": minor
"@tula-tech/react": minor
"@tula-tech/nextjs": patch
---

Deleting an organization from the client needs a recent sign-in, and a user can list and answer their own invitations (TULA-131). `DELETE /v1/client/me/organizations/{organizationId}` now answers `auth.step_up_required` (403) for a session that has not proven itself lately; `<OrganizationProfile>` runs the step-up dialog and repeats the delete, and shows no error when the user closes it. New routes `GET /v1/client/me/organization-invitations` (the pending invitations sent to the user's own verified address: an id, the organization's name, the role and the expiry, never the token; paged) and `POST …/{invitationId}/accept` and `…/decline` (the session authorizes it; an id that is not the caller's is `organization.invitation_not_found`). `@tula-tech/contract` gains `MyOrganizationInvitationSchema`, `MyOrganizationInvitationListSchema` and `MyOrganizationInvitationQuerySchema`. `@tula-tech/core` gains `organizations.invitations.mine()`, `.acceptMine(id)` and `.declineMine(id)`. `<OrganizationSwitcher>` lists those invitations when the panel opens, with Accept and Decline; its words are `organizationSwitcher.pendingInvitationsTitle`, `pendingInvitationText`, `pendingInvitationAcceptLabel` and `pendingInvitationDeclineLabel`. `@tula-tech/nextjs` re-exports the components. The member list now looks its users up in one call.
