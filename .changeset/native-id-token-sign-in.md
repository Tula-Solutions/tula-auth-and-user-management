---
'@tula/contract': minor
'@tula/core': minor
'@tula/admin': minor
'@tula/config': minor
'@tula/cli': minor
'@tula/mcp': minor
---

Native sign-in with Google's ID token
([docs/native-apps.md](../docs/native-apps.md#signing-in-with-google-without-a-browser),
ADR 0045).

- `@tula/contract`: the two requests of the sign-in (`IdTokenStartRequestSchema`,
  `IdTokenStartSchema`, `IdTokenExchangeRequestSchema`, `ID_TOKEN_PROVIDERS`,
  `MAX_ID_TOKEN_LENGTH`). A provider's settings have `additionalClientIds`
  (`AdditionalClientIdsSchema`, `isGoogleClientId`, `MAX_ADDITIONAL_CLIENT_IDS`): the
  client ids, beside the provider's own, whose ID tokens are accepted. Google only. A
  gained one is a weakening (`oauthProviderWeakenings`); `oauth_provider.updated` may name
  the field in `changed` and carry `additionalClientIdCount`.
- `@tula/core`: `signIn.withIdToken({ provider: 'google' })` for an `ios` or `android`
  client. It answers the server's nonce and an `exchange(idToken)` that returns the flow.
  The start carries a device proof when the client has a device key.
- `@tula/admin`: the generated types have `additionalClientIds` on a provider and on its
  update body.
- `@tula/config`: `providers.google.additionalClientIds` (`GoogleProviderConfig`). Left out
  means none. A file that names none keeps its fingerprint.
- `@tula/cli`: `tula diff` and `tula apply` plan Google's `additionalClientIds` as a set.
  The file's list is the whole set; a gained id is `providers.google.additionalClientIds`
  and needs `--allow-weaker` under `--yes`. A `ProviderChange` has `weakened`.
- `@tula/mcp`: `list_oauth_providers` returns `additionalClientIds`.
