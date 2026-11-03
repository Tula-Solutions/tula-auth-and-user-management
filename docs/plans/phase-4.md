# Tula Auth — Phase 4 plan

Enterprise single sign-on (SAML and OIDC connections per organization), SCIM provisioning and
an exportable audit log. The decisions are in [ADR 0067](../adr/0067-enterprise-sso.md); this
page is the order of the work. Tickets are in Linear, under TULA-134.

## Goal

At the end of Phase 4 a customer's IT admin can connect Okta, Microsoft Entra or any SAML or
OIDC identity provider to an organization, enforce it for the organization's domains, and have
users and groups provisioned over SCIM. An operator can export the audit log.

## Steps

| Ticket | Step | What it builds |
| --- | --- | --- |
| TULA-135 | SSO 01 | ADR 0067; this plan; the SAML response verifier and its mock signer |
| TULA-136 | SSO 02 | Prefactor: one shared completion path for external sign-in callbacks |
| TULA-138 | SSO 03 | Tracer: an OIDC enterprise connection signs a user in end to end |
| TULA-139 | SSO 04 | SAML connections sign users in (SP metadata, ACS, IdP metadata, two certificates) |
| TULA-140 | SSO 05 | Enforced connections, the break-glass role and MFA trust |
| TULA-144 | SSO 06 | Attribute mapping and IdP groups mapped to organization roles |
| TULA-145 | SSO 07 | Test sign-in for a connection, and activation only after a passing test |
| TULA-146 | SSO 08 | Dashboard SSO tab on the organization detail |
| TULA-141 | SSO 09 | "Continue with SSO" in `<SignIn>` (core, React, Next.js) |
| TULA-148 | SSO 10 | Org admins manage SSO (`org:sys:sso:manage`, client routes, `<OrganizationProfile>`) |
| TULA-149 | SSO 11 | Setup links and the self-serve SSO setup portal |
| TULA-142 | SSO 12 | SSO sign-in in the Swift, Kotlin and Expo clients |
| TULA-143 | SSO 13 | SCIM 2.0 Users and SCIM tokens per organization |
| TULA-150 | SSO 14 | SCIM Groups mapped to organization roles, and SCIM tokens from the portal |
| TULA-137 | SSO 15 | Audit log export (NDJSON/CSV, streamed, resumable) |
| TULA-147 | SSO 16 | MCP tools and `tula doctor` checks for SSO connections |
| TULA-151 | SSO 17 | Enterprise docs: SSO guide, a page per IdP, SCIM and audit export |
| TULA-152 | SSO 18 | Manual pass against real Okta and Entra tenants, and whole-phase review |
