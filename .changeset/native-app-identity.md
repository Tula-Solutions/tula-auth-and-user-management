---
'@tula/contract': minor
'@tula/admin': minor
'@tula/config': minor
'@tula/cli': minor
---

Native app identity ([docs/native-apps.md](../docs/native-apps.md)). An environment
registers its iOS apps (a team ID and a bundle ID) and Android apps (a package name and the
SHA-256 fingerprints of its signing certificates) through `/v1/admin/native-apps`, and the
server serves Apple's `apple-app-site-association` and Android's `assetlinks.json` for it
under `/v1/environments/<id>/.well-known/`. The files name the apps for the domain's
credentials only (`webcredentials`, `get_login_creds`); they hand an app no link.

`@tula/contract` gains the schemas, the identifier patterns and caps, the two file builders
(`appleAppSiteAssociation`, `assetLinks`), `nativeAppWeakenings` and three event types
(`native_app.created`, `native_app.updated`, `native_app.deleted`). `@tula/admin` gains the
typed operations. `@tula/config` takes `nativeApps` on an environment and exports
`NativeAppConfig`, `IosAppConfig` and `AndroidAppConfig`; an environment without the key is
not read, not changed and keeps its fingerprint. `tula diff` plans them (an app is its
platform and its identifier) and marks as weaker an app registered, an iOS app's changed
team and a gained fingerprint; `tula apply --yes` refuses such a plan without
`--allow-weaker`, writes native apps last, and `--json` gains `nativeApps`.
