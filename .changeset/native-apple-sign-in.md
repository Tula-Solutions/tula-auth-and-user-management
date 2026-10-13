---
'@tula/contract': minor
'@tula/core': minor
---

Native Sign in with Apple by identity token
([docs/native-apps.md](../docs/native-apps.md#signing-in-with-apple-without-a-browser),
ADR 0047).

- `@tula/contract`: `ID_TOKEN_PROVIDERS` gains `apple`. Which client kinds may start the
  sign-in is per provider (`ID_TOKEN_CLIENT_KINDS`: `ios` and `android` for Google, `ios`
  alone for Apple), and `takesAdditionalClientIds` says which provider has
  `additionalClientIds` (Google alone). The exchange's body
  (`IdTokenExchangeRequestSchema`) may carry `givenName` and `familyName` beside the token
  (`MAX_ID_TOKEN_NAME_LENGTH`), read for Apple only.
- `@tula/core`: `signIn.withIdToken({ provider: 'apple' })` for an `ios` client, and
  `exchange(idToken, name?)`, which passes on the name the Sign in with Apple sheet gave
  the app (`IdTokenName`). The client does not hash the nonce: an app hands the sheet the
  lowercase hexadecimal SHA-256 of `nonce`.

**For an operator.** A native Apple token is accepted for the bundle ID of an iOS app the
environment has registered. An environment that already has a registered iOS app **and**
Apple enabled accepts such tokens for that app once the server is upgraded, with no new
setting.
