---
paths:
  - "apps/api/src/modules/native-app/**"
  - "apps/api/src/modules/instance/**"
  - "apps/api/src/modules/passkey/**"
  - "apps/api/src/env.ts"
  - "packages/contract/src/native-app*"
  - "apps/dashboard/src/features/native-apps/**"
---

# Native apps

Moved here from `AGENTS.md`, word for word, and canonical for this area: `AGENTS.md` lists
this file under "Area rules" and does not repeat it. A section named in a sentence as
"above" or "below" is found through that list.

## Native apps (`modules/native-app`, see ADR 0040)

A **native app** is an iOS or Android app an environment's operator says is theirs: a team
and a bundle ID, or a package name and the SHA-256 fingerprints of its signing certificates.
The server builds Apple's `apple-app-site-association` and Android's `assetlinks.json` from
them, hands an app the links of the exact paths its operator gave it
([ADR 0044](../../docs/adr/0044-app-link-and-custom-scheme-redirects.md)), and accepts a
registered app's passkey responses ("A native app's passkey response", below; ADR 0027).
**The bundle IDs of an environment's iOS apps are also the audiences of a native Sign in
with Apple** ("OAuth providers", [ADR 0047](../../docs/adr/0047-native-apple-sign-in.md)): a
registered iOS app's Apple identity tokens sign users in where Apple is enabled, and a
removed app's are refused at once. Nothing else is built on an app.

- **The two files are served under the environment's own path and nowhere else**
  (`/v1/environments/:environmentId/.well-known/apple-app-site-association` and
  `…/assetlinks.json`, beside the JWKS). Never at the API's root, and never by the `Host`
  header or anything else a request carries: the environment is the id in the path, checked
  with `deps.environments.findById` before a row is read (an unknown one is the JWKS's 404).
  The operator's own domain answers the well-known paths by passing the request on
  (`docs/native-apps.md`); never answer either route with a redirect, the platforms follow
  none.
- **What a file says beyond the identifiers is the server's to decide.** The files are built
  only by the contract's `appleAppSiteAssociation` and `assetLinks`, from the environment's
  rows. Apple's has `webcredentials` and Android's the relations of `ASSET_LINKS_RELATIONS`
  (`get_login_creds`), and, **only for an app with `appLinkPaths`**, what hands it links:
  an `applinks.details` entry whose `components` are those exact paths (never a `*` or a
  `?`), and on Android `ASSET_LINKS_APP_LINK_RELATION` (`handle_all_urls`). A request
  brings paths and never a relation, a component or a section: the request schemas are
  strict for that reason. A new section or relation is a decision in an ADR.
- **An app has no link path unless its operator gave it one, and a path is exact**
  (`isAppLinkPath`, at most `MAX_APP_LINK_PATHS`; the table's check
  `native_apps_app_link_paths_shape` repeats it): no wildcard, query, fragment, dot segment
  or trailing slash, never `/` alone. **Android's file cannot name a path, so one path
  there is every link of the domain**: say so wherever a path is asked for (the docs, the
  dashboard's field and its question, the schema's JSDoc), never "these paths" for Android.
- **The server never ties a redirect URL to an app.** An app link is an `https` entry of
  `urls.allowedRedirectUrls`, matched exactly like a page; nothing checks its host or path
  against an app or the files' domain (the server does not know that domain). Never add a
  rule that allows a redirect because an app is registered.
- **No app of a platform means no section, never an empty one**: `{}` and `[]`.
- **Identifiers are validated by the contract's patterns** (`packages/contract/src/native-app.ts`),
  shared by the API, the dashboard and `@tula/config`: never a second copy of one. No
  wildcard in a bundle ID; a team ID is ten upper-case letters and digits and is not folded;
  a fingerprint is accepted in either spelling and stored upper case with colons, as a
  sorted set (`normalizeCertFingerprints`). The table's checks repeat the shapes: keep both.
- **An app is its platform and its identifier** (`UNIQUE (environment_id, platform,
  identifier)`), compared exactly, and neither changes: the runtime role may update only
  `team_id`, `sha256_cert_fingerprints`, `app_link_paths` and `updated_at`.
- **The cap is counted and inserted under the environment's lock** (`deps.environmentLock`,
  scope `native_apps`; `MAX_NATIVE_APPS`), and **an update is a compare-and-set** on the
  team, the fingerprints and the link paths the service read (`NativeAppStore.update`'s
  `expected`): the
  weakening recorded with a change must be the one that was judged.
- **What widens is the contract's `nativeAppWeakenings` and nothing else**: an app
  registered, an iOS app's team changed, a fingerprint gained, a link path gained. It is
  the audit entry's `weakened`, the dashboard's question and `tula apply --yes`'s refusal
  without `--allow-weaker`. A removal, and a fingerprint or a path taken away, are not.
- **No identifier in an event or an audit entry**: `native_app.created`, `.updated` and
  `.deleted` carry the platform, a count of fingerprints, a count of link paths, the names
  of the changed fields (`NATIVE_APP_FIELDS`) and `weakened`. A bundle ID, a package name,
  a team, a fingerprint and a path are public and are still not ids, enums, booleans or
  numbers.
- **The public routes take no key, set no cookie and are limited per address** (bucket
  `app_association`, as the JWKS is), with `Cache-Control: public, max-age=300`
  (`ASSOCIATION_MAX_AGE_SECONDS`). Nothing guessable or costly is behind them.
- **Whether Apple and Android accept the files has not been shown** (no device, no vendor
  tool): ADR 0040 and `docs/native-apps.md` list what is unverified. Do not word either
  file as tested against a platform until one has fetched it.
- **A native app's passkey response is accepted by the origin its platform writes, and by
  nothing else** ([ADR 0027](../../docs/adr/0027-passkeys.md), "Native apps").
  `Passkeys.relyingParty` reads the environment's apps (`Passkeys.nativeOrigins`) for a
  request with **no `Origin`** that declares `ios` or `android`: an Android app's origin is
  the contract's `androidApkKeyHashOrigin(fingerprint)`, one per registered fingerprint
  (never a second copy of that encoding: the conformance runner uses the same function);
  an iOS app's is `https://<rpId>`, accepted once at least one iOS app is registered
  **and the environment allows that origin** (`Passkeys.acceptedNativeOrigins`, the one
  statement of the native rule, which asks `acceptsPageOrigin`, the function that judges a
  page's origin: exact entries of `urls.allowedOrigins` in every tier, never CORS's
  loopback rule). The string is also a page's: without that, a response made on a page the
  operator left off the list could be sent with no `Origin` as `ios`. Never accept the iOS
  origin on the registration alone, never compare it a second way, and keep "an iOS app,
  origin not allowed" answering exactly as "no iOS app" does (`request.origin_not_allowed`
  before an attempt or a challenge; the side-by-side tests in
  `modules/passkey/native.test.ts`). `native_app_passkeys` warns of it, by asking that
  same function. So
  **removing an app or a fingerprint takes its origin away at once**, a ceremony under way
  included, and the passkeys stay: nothing stores which origin a passkey was registered
  from, and nothing may come to depend on it. An Android origin names a certificate, not a
  package; an iOS origin names nobody. **Neither origin has been seen from a device, and
  Apple documents none**: do not word either as tested against a platform.
- **The diagnostics have three checks of native apps, and none requests an operator's
  domain** (`modules/instance/native.ts`: `native_app_identities`, `native_app_files`,
  `native_app_passkeys`; ADR 0040, "What `tula doctor` checks"; ADR 0031's table). They read
  inside the one bounded scan `master_key` makes (one `nativeApps.list` an environment,
  never a second scan; an environment's settings are read once a run and shared with
  `sms_sender`), look at the deadline's signal before that read, and answer counts: never
  an identifier, a team, a fingerprint, a relying-party id or an environment's id. The log
  names a row by the ids the server made and by nothing an operator typed. "Well formed" is
  `NativeApps.wellFormed`, which parses with the contract's schemas: never a second copy of
  a pattern. The files are compared with what `NativeApps.associationFiles` builds, which is
  the function the public routes serve: keep both on it. **The only address fetched is the
  server's own `PUBLIC_URL`** (`deps.diagnostics.httpDocument`, at most
  `NATIVE_APP_FILES_FETCHED` requests a run, no redirect followed, never a loopback one):
  never `https://<rpId>/…`, an allowed origin or any other address of an operator's, and
  never through the outbound guard to get there. So **`ok` is worded for the server's own
  copies** and says that whether Apple or Android can reach them at the apps' domain was
  not checked; never reword a check to say an app, a domain or a file is verified. With no
  app in any environment looked at the three are `skipped`. With passkeys on, a relying
  party that cannot be associated is `warn`, never `fail`, and so is an iOS app where the
  relying party's own origin is not allowed (`iosRefused`, asked of
  `Passkeys.acceptedNativeOrigins`, never worked out a second time; beside the other
  warning it is a clause, because of the 512 characters). **Passkeys off is `ok` and
  said** (the files serve saved passwords too: never make it a warning again, `--strict`
  would fail a deployment with nothing to put right), and so is a loopback relying party
  **in the `local` tier only** (`deps.config.tier`, never `NODE_ENV`); one that is not set
  or is no domain name is `warn` in every tier. **A sentence about a fetch says "PUBLIC_URL,
  the server's own address"**, and a `401` or a `403` there is `warn` (an access wall in
  front of the API's own host says nothing about the apps' domain) while a redirect, any
  other status and an answer that is not JSON stay `fail`, said before any `warn` of the
  sample. **A read that fails for one environment makes the three `skipped`, whatever an
  earlier environment showed** (a check never reports from a partial read as if it were
  whole; the log still names the row): keep the test that pins it. **A scan that did not
  read every environment says so first** ("Only the first N of M environments were read;
  the other K were not."), in every answer of the three, and is never `ok`: one function
  (`whole`, reached only through `answered`) puts it there, so no branch of a check writes
  it or can leave without it. First, because a reader's tool keeps the start of a string
  and the end is what a cut removes; never move it to the end or build it into a sentence.
  Every sentence stays inside 512 characters (`@tula/mcp`'s cap): the test builds **every**
  answer the checks can give (each finding present or absent, the four tiers, every pair
  of fetch outcomes, read whole or not, at the largest counts), never a chosen few, and a
  new finding or outcome is added to that enumeration. A new finding gets a
  fixed sentence, a row in `modules/instance/native.test.ts` (with the canaries) and a line
  in both ADRs.
- **`PUBLIC_URL` holds no user name, password, query or fragment** (`env.ts` refuses each
  at boot, in every tier, naming the variable and never the value; an `@` anywhere in the
  authority of the text as typed is refused too, because the parser reads `https://@host`
  as no credentials and the issuer is built from the text). It is the issuer of
  every access token and the address of the server's requests to itself, where `fetch`
  would send the credentials as basic authentication: never loosen it, and a new request
  the server makes to itself is built from it and nothing else.
