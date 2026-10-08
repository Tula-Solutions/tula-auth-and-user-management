---
'@tula/contract': minor
'@tula/core': minor
'@tula/admin': minor
'@tula/react': minor
'@tula/config': minor
'@tula/cli': minor
---

Sign in with Discord and LinkedIn.

- `@tula/contract`: `discord` and `linkedin` in `OAUTH_PROVIDERS`; the first-factor
  strategies `oauth_discord` and `oauth_linkedin`, which are also `user.created` methods and
  `HOOK_SIGN_UP_METHODS`, so a `before_sign_up` hook may be asked with either `method`. Each
  takes `clientId` and `clientSecret`, like Google and GitHub.
- `@tula/core` and `@tula/admin`: the generated types carry the two providers and
  strategies. No run-time change.
- `@tula/react`: "Continue with Discord" and "Continue with LinkedIn" buttons on `<SignIn>`
  and `<SignUp>`, and both names under "Connected accounts". The marks are drawn inline;
  nothing is fetched. They were drawn without either brand page open: check them against
  Discord's and LinkedIn's brand guidelines before shipping.
- `@tula/config`: `providers.discord` and `providers.linkedin` (`clientId`,
  `clientSecret: env('NAME')`).
- `@tula/cli`: `tula diff` and `tula apply` manage both.

LinkedIn's sign-in has no PKCE and no nonce (LinkedIn documents neither). The account is the
`sub` of the verified ID token; the address and whether it is verified are read from
LinkedIn's userinfo endpoint. See `docs/providers/linkedin.md` before offering it.
