---
"@tula-tech/contract": minor
"@tula-tech/admin": patch
---

An organization can have SCIM tokens (ADR 0067, "SCIM"). The contract gains `SCIM_TOKEN_PREFIX` (`tula_scim_`) and the audit and event types `scim_token.created`, `scim_token.revoked` and `user.scim_provisioned`, whose payloads hold ids and flags only, and the audit actor type `directory`. `@tula-tech/admin` gains the typed calls for `/v1/admin/scim-tokens`. The SCIM routes themselves (`/v1/scim/v2`) are for an identity provider and are in no SDK.
