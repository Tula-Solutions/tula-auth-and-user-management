---
'@tula/contract': minor
'@tula/core': minor
'@tula/admin': minor
'@tula/react': minor
'@tula/config': minor
'@tula/cli': minor
'@tula/mcp': minor
'create-tula': patch
---

Sign in with Microsoft (Entra ID work and school accounts, and personal accounts).

- `@tula/contract`: `microsoft` in `OAUTH_PROVIDERS`; the first-factor strategy
  `oauth_microsoft`; `MicrosoftTenantSchema`, `MicrosoftTenant` and
  `MICROSOFT_TENANT_ALIASES`; `tenant` on `OAuthProviderUpdate` (required for Microsoft:
  `common`, `organizations`, `consumers` or a tenant id; a domain name is refused) and, as
  `string | null`, on `OAuthProviderSettings`; `oauth_microsoft` as a `user.created` method
  and `tenant` as a name in `oauth_provider.updated.changed`; `oauth_microsoft` among
  `HOOK_SIGN_UP_METHODS`, so a `before_sign_up` hook may be asked with that `method`.
- `@tula/core` and `@tula/admin`: the generated types carry the new provider, strategy and
  field. No run-time change in `@tula/core`.
- `@tula/react`: a "Continue with Microsoft" button on `<SignIn>` and `<SignUp>` and
  "Microsoft" under "Connected accounts". The mark is drawn inline; nothing is fetched.
- `@tula/config`: `providers.microsoft` (`clientId`, `clientSecret: env('NAME')`, `tenant`)
  and the type `MicrosoftProviderConfig`.
- `@tula/cli`: `tula diff` and `tula apply` manage Microsoft and its `tenant`. A change of
  tenant keeps the stored secret, as switching a provider on or off does.
- `@tula/mcp`: `list_oauth_providers` returns each provider's `tenant`.
- `create-tula`: the scaffold's comments about the mock provider no longer list the
  providers by name.
