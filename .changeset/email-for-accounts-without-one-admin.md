---
'@tula/admin': minor
---

Two operations (ADR 0059): `setUserEmail` gives an account with no email address one,
stored unverified and never replacing an address, and `getOAuthProviderDependents` answers
how many accounts could not sign in without a provider (`{ provider, accounts, more }`).
