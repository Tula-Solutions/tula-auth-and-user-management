---
'@tula/contract': minor
'@tula/core': minor
'@tula/admin': minor
'@tula/react': minor
'@tula/nextjs': minor
'@tula/config': minor
'@tula/cli': minor
'@tula/mcp': patch
'create-tula': patch
---

Sign in with X and Facebook, and accounts with no email address.

Neither provider is asked for an email address, so a first sign-in with either makes an
account that has none. **`User.email` is now `string | null`** in the contract and in every
generated type: code that reads a user's `email` has to allow for `null`. The same holds
for the `before_sign_up` hook's question (`data.email`).

- `@tula/contract`: `x` and `facebook` in `OAUTH_PROVIDERS`; `OAUTH_PROVIDERS_WITHOUT_ADDRESS`
  and `givesNoAddress(provider)`, the one place that says which providers give no address;
  the strategies `oauth_x` and `oauth_facebook`, which are also `user.created` methods and
  `HOOK_SIGN_UP_METHODS`. `UserSchema.email` and `HookBeforeSignUpDataSchema.email` are
  nullable.
- `@tula/core` and `@tula/admin`: the generated types carry the two providers, the two
  strategies and the nullable `email`. No run-time change. `verifyHook`'s examples check
  the address for `null`.
- `@tula/react`: "Continue with X" and "Continue with Facebook" buttons on `<SignIn>` and
  `<SignUp>`, and both names under "Connected accounts". The marks are drawn inline and
  were not checked against X's or Meta's brand guidelines. `<UserButton>` and
  `<UserProfile>` draw a user with no address by name, with no address line, no
  verification badge and no password section.
- `@tula/nextjs`: `currentUser()` may return a user whose `email` is `null`.
- `@tula/config`: `providers.x` and `providers.facebook` (`clientId`,
  `clientSecret: env('NAME')`; for Facebook the app id and the app secret).
- `@tula/cli`: `tula diff` and `tula apply` manage both.
- `@tula/mcp`: `get_user` and `list_users` return `email: null` for such a user; the
  scaffolds greet a user who has neither a first name nor an address.
- `create-tula`: the app templates do the same.

An account with no address gets no security emails, cannot sign in by emailed code or link,
cannot have a password, and cannot be given an address yet. Facebook's sign-in has no PKCE
and no nonce (Meta documents neither for this flow). What X charges for the API call a
sign-in makes was not confirmed. See `docs/providers/x.md` and `docs/providers/facebook.md`
before offering either.
