# Tula Auth — Phase 3 plan

Organizations (users who belong to groups, with roles that reach the token) and bulk user
import (a team arrives from another provider with its password hashes). The decisions are in
[ADR 0065](../adr/0065-organizations.md); this page is the order of the work. Tickets are in
Linear, under TULA-110.

## Goal

At the end of Phase 3 a B2B product can model companies and teams with Tula alone: an
operator creates organizations and roles, users create, join, switch and are invited to
them, the access token says which organization is active and what the role may do, and the
SDKs, the prebuilt components and the dashboard know it. A team coming from Clerk, Auth0,
Firebase, Supabase or Better Auth imports its users, passwords included.

## Steps

| Ticket | Step | What it builds |
| --- | --- | --- |
| TULA-111 | Orgs 01 | ADR 0065; the tables, grants and row-level security; the `organizations` settings; the admin routes for organizations and memberships; events; the conformance scenario |
| TULA-112 | Orgs 02 | A user's own organizations (`/v1/client/me/organizations`), the active organization on the session, `org_id`, `org_role` and `org_perms` in the token |
| TULA-113 | Orgs 03 | Custom roles and permissions, in the admin API and in the config file |
| TULA-115 | Orgs 04 | Invitations by email: invite, accept, decline, revoke, expire |
| TULA-116 | Orgs 05 | Verified domains with suggest and auto-join |
| TULA-117 | Orgs 06 | `has()` and the active organization in Next.js and the React hooks |
| TULA-119 | Orgs 07 | `OrganizationSwitcher`, `CreateOrganization` and `OrganizationProfile` |
| TULA-120 | Orgs 08 | Organizations and Roles in the dashboard |
| TULA-121 | Orgs 09 | Organizations in the Swift, Kotlin and Expo clients |
| TULA-123 | Orgs 10 | The organizations guide, MCP read tools and the Tula UI items |
| TULA-114 | Import 01 | Bulk user import through the admin API, with bcrypt and argon2 hashes |
| TULA-118 | Import 02 | Firebase scrypt and PBKDF2-SHA256 hashes |
| TULA-122 | Import 03 | `tula import --from clerk\|auth0\|firebase\|supabase\|better-auth`, and the migration guides |

## Out of scope

SAML and SCIM, billing, per-organization branding and settings, nested organizations, DNS
verification of a domain, MCP `plan_migration` and `import_users`, and native organization
screens.
