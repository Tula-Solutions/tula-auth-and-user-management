---
'@tula/contract': minor
'@tula/core': minor
'@tula/react': minor
---

Sign in with Google, GitHub and Apple, with an environment's own OAuth credentials.

- `@tula/contract`: new `OAuthProvider`, `OAuthStartRequest`, `OAuthStart`,
  `OAuthExchangeRequest`, `Identity`, `IdentityList`, `IdentityLinkStart`,
  `OAuthProviderSettings` and `OAuthProviderUpdate`; error codes `oauth.access_denied`,
  `oauth.provider_error`, `oauth.state_invalid`, `oauth.ticket_invalid`,
  `oauth.different_browser`, `oauth.email_missing`, `oauth.email_unverified`,
  `oauth.account_exists`, `oauth.identity_in_use`, `oauth.already_linked` and
  `identity.last_sign_in_method`; `ClientConfig.signIn.oauth`; the setting
  `notifications.identityChanged`; the fragment parameters `OAUTH_TICKET_PARAM` and
  `OAUTH_ERROR_PARAM`. **Changed:** the settings schema no longer refuses a document with
  every sign-in method off (the server does, unless an OAuth provider is enabled);
  `hasEnabledSignInMethod` and `AT_LEAST_ONE_SIGN_IN_METHOD` are exported for that check.
- `@tula/core`: `signIn.withOAuth`, `signIn.handleOAuthCallback`, `signIn.canUseOAuth` and
  `user.identities.{list, link, unlink}`. The round trip's binding is kept in
  `sessionStorage` for the tab; no token is.
- `@tula/react`: "Continue with …" buttons on `<SignIn>` and `<SignUp>`, `<OAuthCallback>` and
  `useOAuthCallback()`, "Connected accounts" in `<UserProfile>`, the `oauthCallbackUrl` option,
  new localization strings (`oauth`, and seven under `userProfile`) and element names
  (`oauthButtons`, `oauthIcon`, `divider`, `identityList`, `identityItem`).
