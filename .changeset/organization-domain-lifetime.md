---
"@tula-tech/contract": minor
"@tula-tech/core": patch
"@tula-tech/admin": patch
---

A verification of an organization's domain now lasts a year (ADR 0065, "Lapse"). Past it, the domain matches nobody: no auto-join at sign-up and no suggestion, until a manager claims the domain again and enters the new emailed code. The contract gains `DOMAIN_VERIFICATION_LIFETIME_DAYS` (365), `DOMAIN_REMINDER_DAYS` (30 and 7), `DOMAIN_REVERIFICATION_GRACE_DAYS` (30, for domains verified before this change) and `ORGANIZATION_DOMAIN_STATUSES`; an `OrganizationDomain` gains `status` (`pending`, `verified` or `needs_reverification`) and `expiresAt`, and `codeExpiresAt` is also set while a verified domain is being proven again. The event `organization_domain.verified` gains an optional `reverified: true`. The email kind `organization_domain_expiring` (a notice with the placeholders `appName` and `expiresInDays`) is the reminder sent to an organization's managers 30 and 7 days ahead; it names the organization and a count, never a domain. `@tula-tech/core` and `@tula-tech/admin` only carry the new fields. Sending codes is also fairer: an organization a user created sends 10 a day (30 for one an administrator made), all of one user's organizations share 20 a day, and being told that a name is claimed elsewhere (`organization.domain_taken`) spends one of the organization's ten sends an hour.
