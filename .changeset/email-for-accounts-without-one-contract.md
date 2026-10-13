---
'@tula-tech/contract': minor
---

An email address for an account that has none, and the accounts a provider's removal locks
out (ADR 0059).

- The error code `email.already_set` (409): the account already has an address.
- The activity `user.email_added` (`method`: `self` or `admin`; `verified`), with its
  schema and fixture.
- Two email kinds, `email_in_use` (what an address that already has an account is sent
  instead of a code) and `email_added` (the notice to the address that was added).
- `OAuthProviderDependentsSchema` (`{ provider, accounts, more }`) and
  `DEPENDENT_ACCOUNTS_SCAN_LIMIT`: how many accounts could not sign in without a provider.
  A number and a boolean, never who.
- `oauthProviderWeakenings` now also takes `enabled` and the counted `dependents`, and
  names `enabled` when a provider that accounts depend on is switched off or removed.
  `oauth_provider.updated` and `.deleted` gain `dependentAccounts` and
  `dependentAccountsIncomplete`.
- The OpenAPI document gains `requestEmailAddressCode`, `verifyEmailAddress`,
  `setUserEmail` and `getOAuthProviderDependents`.
