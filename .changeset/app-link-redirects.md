---
'@tula/contract': minor
'@tula/admin': minor
'@tula/config': minor
'@tula/cli': minor
---

App-link and custom-scheme redirects ([docs/native-apps.md](../docs/native-apps.md),
ADR 0044).

- `@tula/contract`: a new Zod-free entry point, `@tula/contract/redirect-url`
  (`redirectUrlKind`, `isRedirectUrl`, `isCustomSchemeRedirectUrl`,
  `REDIRECT_SCHEMES_NEVER_CUSTOM`, `OAUTH_PROVIDERS_WITH_PKCE`,
  `OAUTH_PROVIDERS_WITHOUT_PKCE`, `bindsCodeWithPkce`, `customSchemeRedirectRefusal`).
  `urls.allowedRedirectUrls` accepts a custom scheme in reverse-domain form
  (`com.example.app:/oauth`); listing one is a weakening (`urls.allowedRedirectUrls`). A
  web entry must now start with `https://` or `http://` as written. A native app has
  `appLinkPaths` (`isAppLinkPath`, `normalizeAppLinkPaths`, `MAX_APP_LINK_PATHS`); the two
  file builders serve `applinks` and `handle_all_urls` for an app that has some;
  `nativeAppWeakenings` reports a gained path; the `native_app.*` events carry a count of
  paths. `request.redirect_not_allowed` may carry `params.reason`.
- `@tula/admin`: the generated types have `appLinkPaths` on a native app and on its create
  and update bodies.
- `@tula/config`: `appLinkPaths` on a `nativeApps` entry.
- `@tula/cli`: `tula diff` and `tula apply` plan `appLinkPaths` as a set. Left out of an
  entry the paths are unmanaged (kept, and the diff says how many the server has); written,
  also as `[]`, the list is the whole set. A gained path is `nativeApps.<platform>/<identifier>.appLinkPaths` and needs
  `--allow-weaker` under `--yes`, as does a custom-scheme redirect URL the file adds.
