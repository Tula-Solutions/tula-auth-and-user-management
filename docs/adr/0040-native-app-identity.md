# ADR 0040: Native app identity

- **Status:** accepted
- **Date:** 2026-10-09
- **Ticket:** TULA-18 (phase 2, step 2.8)

## Context

Phase 2 brings native SDKs, and three of the things they need rest on one fact the server
does not have yet: which apps are the operator's. iOS and Android both answer "does this app
belong to this website" by fetching a file from the website (Apple's
`apple-app-site-association`, Android's `assetlinks.json`), and both name an app by something
only its publisher controls: an Apple team and a bundle ID, an Android package name and the
SHA-256 fingerprints of the certificates it is signed with.

This ADR records where that list lives, what the two files hold now, where they are served,
and what a change to the list is taken to be. The features built on it are other steps:
passkeys in native apps (TULA-31), app-link and custom-scheme redirects (TULA-32), native
Google sign-in (TULA-33), and a check of the operator's domain in `tula doctor` (TULA-35).
Nothing here builds them; the decisions below are made so that they can be added.

## Decision

### A native app is a row, not a setting

The phase plan sketched it as "settings gain `apps`". It is a table instead
(`tula.native_apps`), with its own admin routes, for the reasons webhook endpoints and hooks
are:

- A list in the settings document is replaced whole on every save. Two administrators, or an
  administrator and `tula apply`, would overwrite each other's apps, and a config file that
  manages the settings would have to manage every app.
- The settings are cached per instance for up to 30 seconds and travel to every sign-in
  page's code path. The apps are read by two public routes and nothing else.
- Each change gets an audit entry and an event of its own, with a target id.

An app is **its platform and its identifier** (the bundle ID, or the package name):
`UNIQUE (environment_id, platform, identifier)`. Neither can be changed; an update changes an
iOS app's team or an Android app's set of fingerprints. The same name on the other platform
is another app, which is what the platforms think too.

One table for both platforms, with the identifier in one column and a check per platform
that the other platform's field is empty (`native_apps_ios_whole`,
`native_apps_android_whole`). A later platform is a new value of `platform`, a new check and
a new branch of the contract's union; a later attribute of an app (the paths an app takes, a
client ID for native Google sign-in) is a new column with a default. The API's view is a
union on `platform` (`IosApp`, `AndroidApp`), so a field never appears on the wrong one.

### Identifiers are validated in the contract, and again in the database

`@tula/contract` (`native-app.ts`) holds the patterns, shared by the API, the dashboard, the
config file and the CLI:

| Field | Rule | Why |
| --- | --- | --- |
| `teamId` | exactly ten of `A-Z0-9` | Apple's team ID. Lower case is refused, not folded: the file is compared by Apple, and a guess at their folding is not ours to make. |
| `bundleId` | two or more segments of `A-Za-z0-9-` joined by periods, at most 155 characters | No wildcard: `com.example.*` names every app under a prefix. Compared exactly. |
| `packageName` | two or more segments, each a letter then `A-Za-z0-9_`, at most 255 characters | Android's grammar for an application ID. |
| a fingerprint | 32 bytes as hex: `AA:BB:…` in either case, or 64 hex digits | The two spellings the tools print. Stored and served upper case with colons, which is what Google documents. |

Fingerprints are a set: stored sorted, each once, one to ten per app
(`MAX_CERT_FINGERPRINTS`). An environment has at most twenty apps (`MAX_NATIVE_APPS`): the
files are fetched by anyone, and their size is the list's.

The request schemas are strict. An app cannot bring a relation, a path, a section or any
other part of a file: what the files say beyond the identifiers is decided by the server,
below.

The table repeats the shapes as checks (`native_apps_identifier_shape`, the team's pattern,
`native_apps_fingerprints_shape`), a little looser on the identifier than the contract (one
pattern for both platforms). The files are public and built from these rows; a row that got
in by another path than the API must still be something that can be put in a JSON file
without thought. The runtime role may update only `team_id`, `sha256_cert_fingerprints` and
`updated_at`.

### Where the files are served

```
GET /v1/environments/:environmentId/.well-known/apple-app-site-association
GET /v1/environments/:environmentId/.well-known/assetlinks.json
```

Under the environment's own path, beside its JWKS, and nowhere else. The phase plan said
"served by the API at its own host". That cannot be done at the host's root: one API serves
many environments, and the only thing a request to `/.well-known/assetlinks.json` could
choose one by is its `Host` header. Tula resolves a tenant from a key or from an id in the
path, never from a header anyone can set, and this ADR does not start.

It would not help if it could. The platforms fetch the file from the domain the **app**
claims: the passkey relying-party ID, the domain of an associated-domains entitlement. That
is the operator's site, and seldom the host the API runs on. So the last step is always the
operator's: their domain answers the two well-known paths with the content of the
environment's files, by a proxy rule that passes the request on (never a redirect: neither
platform follows one) or by publishing a copy. `docs/native-apps.md` gives the rule for
nginx, Caddy and Next.js. Nothing in `@tula/nextjs` does it: its route handler forwards
`/v1/client/*` and nothing else, the SDK does not know the environment's id, and a
`rewrites()` entry of four lines does the job. A helper is a small later addition if it is
wanted.

The files are public by nature, so the routes take no key. They are rate limited per
address like the JWKS (a bucket of their own, `app_association`, 600 a minute, allowed when
the limiter cannot count: nothing guessable or costly is behind them). An environment that
does not exist is the JWKS's `404`, and its rows are not looked for. An id that is no UUID
is `422` before anything is read.

Answers are `application/json`, `Cache-Control: public, max-age=300`, with `nosniff` from
the API's global headers, no cookie, and never a redirect. Five minutes because the files
are fetched rarely and a removal should not be served from a proxy for long; the platforms'
own caches are much longer and not ours to shorten.

### What the files hold now

Built by two pure functions of the contract (`appleAppSiteAssociation`, `assetLinks`), from
the environment's rows and nothing else:

- **Apple:** `{ "webcredentials": { "apps": ["<team>.<bundle id>", …] } }`, sorted. With no
  iOS app: `{}`.
- **Android:** one statement per Android app, sorted by package name, with the relation
  `delegate_permission/common.get_login_creds` and the app's fingerprints. With no Android
  app: `[]`.

**Served now, and why.** Only the sections that say "this app may use this domain's
credentials". That is the smallest claim that makes an app's identity mean something, it is
what native passkeys (TULA-31) need, and it follows from registration alone: an operator who
says "this app is mine" has said it.

**Not served, and why.** `applinks` and `delegate_permission/common.handle_all_urls` hand an
app links of the domain. Which paths an app takes is a second decision the operator has not
been asked (all of them is rarely right for a site that has pages an app does not), and on
Android a verified `handle_all_urls` changes which app opens a link for every user of the
domain. TULA-32 adds them, with whatever the operator says about paths, as fields of an app
and entries of `ASSET_LINKS_RELATIONS`. Nothing about the stored shape has to change for
that. `appclips` and `activitycontinuation` have no user in the plan.

**Since TULA-32** ([ADR 0044](0044-app-link-and-custom-scheme-redirects.md)) an app may have
exact `appLinkPaths`, none by default. An iOS app with some gets an `applinks.details`
entry of exact `components`; an Android app with at least one gets `handle_all_urls`, which
covers every link of the domain because the file has no place for a path. A gained path is
a weakening. An app with none is served exactly as described above.

**An absent section, never an empty one.** `{}` and `[]` are well-formed and grant nothing.
`{ "webcredentials": { "apps": [] } }` would say the same in more words, and a parser that
treats an empty list as an error is not something to find out in production.

One consequence is stated because it arrives before the feature that wants it: on iOS, an
app named under `webcredentials` for a domain can already use that domain's saved passwords
and can be offered its passkeys by the system, once the operator publishes the file on the
domain and ships an app with the matching entitlement. Since TULA-31 Tula's passkey
ceremony accepts a registered app's response too
([ADR 0027, "Native apps"](0027-passkeys.md#native-apps-added-2026-10-09-tula-31)): an
Android app's by the origin its signing certificate gives, an iOS app's by the relying
party's own origin once any iOS app is registered **and the environment allows that
origin** (`urls.allowedOrigins`: the string is also a page's, and a response made on a page
the operator left off the list must not pass as an app's). So registering an app also widens which
passkey responses the environment accepts, and removing one, or a fingerprint, narrows it
at once. That is why registration is a weakening, below.

### What a change is taken to be

`nativeAppWeakenings(was, is)` in the contract, shared by the audit entry, the dashboard and
`tula apply`, as `settingsWeakenings` and `hookWeakenings` are:

| Change | Weakening |
| --- | --- |
| An app is registered | yes (`app`) |
| An iOS app's team changes | yes (`teamId`): the app the file names is another developer's |
| An Android app gains a fingerprint | yes (`sha256CertFingerprints`): whoever holds that key can sign the app |
| An Android app loses a fingerprint | no |
| An app is removed | no |

"Weakening" is the existing word for "a change someone should be asked about, recorded as
such"; here it means the set of binaries the platforms will believe grows. The alternative
considered was to treat registration as ordinary, since it grants nothing inside Tula today.
It was rejected: the grant is on the operator's domain and is real from the day the file is
published, a pipeline that runs `tula apply --yes` would otherwise add an attacker's package
name and fingerprint from a changed config file with no flag standing in the way, and the
cost of the stricter reading is one flag in CI on the day an app is added.

Removal is not a weakening and has no flag of its own (unlike a webhook endpoint's, which
destroys a delivery log): nothing is lost that registering the app again does not bring
back. It breaks whatever in the app relies on the file, after the platforms' caches lapse.
The dashboard's confirmation says so, and in a production environment asks for the
identifier to be typed.

### Tenancy and writes

- `native_apps` has `tenantColumns()` and `tenantConstraints()`: the composite foreign key
  and the fail-closed policy. Every query goes through `withTenant`. The public routes read
  with the environment id from the path, after `deps.environments.findById` has said the
  environment exists; nothing else of the request reaches the query.
- **The cap is counted and inserted under the environment's lock**
  (`deps.environmentLock`, scope `native_apps`), as a webhook endpoint's is. The unique
  index is what refuses a second copy of an app; the lock is what makes "twenty" true for
  registrations that arrive together. It is taken by an administrator's write only.
- **An update is a compare-and-set** on the team and the fingerprints the service read
  (`NativeAppStore.update`'s `expected`). The weakening recorded with a change is judged
  against one state of the app; a write over another state would record `weakened: false`
  for a change that added a fingerprint. A miss is `409` and the caller reads again.
- Every write takes an `Activity` and stores it in the same transaction.

### What is recorded

Three activity types, each with a schema and a fixture in the contract:
`native_app.created` (`platform`, `fingerprints`, `weakened`), `native_app.updated`
(`platform`, `changed`, `fingerprints`, `weakened`) and `native_app.deleted` (`platform`).
`fingerprints` is a count. `changed` is a list from the closed set `NATIVE_APP_FIELDS`.

No bundle ID, package name, team or fingerprint is in a payload. None of them is a secret
(all four are in a public file), and an event's `data` is still an allow-list of ids, enums,
booleans and numbers (ADR 0012): a payload goes to every subscribed endpoint, and a
free-form string field needs an argument that these do not have. The cost is that the audit
log cannot say which app was removed once it is gone, only its id and platform. That is the
cost a webhook endpoint's address already has.

### The config file and the CLI

`nativeApps: [{ platform, … }]` in `tula.config.ts`, with the semantics of `webhooks`:

- No key: not read, not touched, `--prune` included; the file's fingerprint is what it was.
- A list: an entry is matched by platform and identifier, compared exactly. Fingerprints are
  normalised when the file is loaded and compared as a set. An app the server has and the
  list leaves out is *unmanaged*, and removed only with `--prune`.
- The weakenings above are in `plan.weakened` as `nativeApps.<platform>/<identifier>` (with
  `.teamId` or `.sha256CertFingerprints` for a change), so `apply --yes` refuses them
  without `--allow-weaker` before any write.
- Writes come last, after the hooks: removals, changes that widen nothing, changes that
  widen, registrations. A run that stops half-way has widened as little as it could, and the
  cap is never met on the way to a state that fits. A plan that would end above the cap is a
  `planBlocker`.
- The apps are read again before the first write to one (`nativeAppSnapshot`), as hooks are.
  That narrows the window; the server's compare-and-set covers an update, and nothing covers
  a registration but the unique index.
- An app of a platform this version does not know is never touched.

### The dashboard

A "Native apps" screen under the environment: the list, a registration that is always asked
about first (the contract's rule, in the dashboard's words), an edit that is asked about
when it widens, a removal behind `ConfirmDialog`, and the two addresses as text to copy with
a sentence on where they have to be published. In a production environment the identifier
is typed for a registration, a widening and a removal. No secret is involved anywhere on the
screen.

### The MCP server

No tool. The server's read tools cover what an assistant is asked about while debugging a
sign-in (users, sessions, audit entries, settings, providers, the doctor); the list of
native apps is two public files away for anyone who has the environment's id. A read tool
is an entry in `TOOLS` and an id in `READ_OPERATIONS` when there is a use for it, most
likely with TULA-35.

### What `tula doctor` checks (added 2026-10-09, TULA-35)

Three checks of the diagnostics ([ADR 0031](0031-instance-admin-and-cli.md)) are about native
apps: `native_app_identities`, `native_app_files` and `native_app_passkeys`. The rows of that
record's table say what each can and cannot tell. The decisions behind them:

- **They are the deployment's, with counts over environments.** The diagnostics have no view
  of one environment (the route takes the instance token and names none), and none was added:
  the native apps are read inside the one bounded scan the other checks share, one `list` per
  environment and, for an environment that has an app, the one read of its settings the scan
  already shares. A check says "in 2 environments"; which ones is in the API's log, by the
  ids the server made. No identifier, team, fingerprint, relying-party id or environment id
  is in an answer.
- **"Well formed" is the contract's word, not a second rule.** `NativeApps.wellFormed`
  parses a stored row with the schemas a registration is validated with, and asks that an
  Android app's fingerprints are what `normalizeCertFingerprints` would store. A registration
  and the table's checks already hold a row to this, so a failure is a row from another
  version or written by hand. **It is not a check that the identifier is the right one**: the
  server has never seen the app, and the `ok` text says so. The ticket's "a wrong bundle id"
  is caught only where it is wrong in form.
- **The files are compared twice, and neither comparison leaves the server's own address.**
  In process: the public routes and the check call one function
  (`NativeApps.associationFiles`), and the check works out what the files should name from
  the rows, apart from that function. Over HTTP: the route is fetched at `PUBLIC_URL` for one
  environment per platform and its body compared with what was built. That shows that the
  address serves the file (a proxy that redirects, rewrites or answers with a page is found),
  for a sample; the route is the same code for every environment.
- **The operator's domain is never requested.** What a platform fetches is
  `https://<their domain>/.well-known/…`, which their site or proxy answers by passing the
  request on. Asking it from the server would be a request to an address an operator typed,
  which the server makes only through the outbound guard and only for webhooks and hooks, and
  the answer would say little: a server often cannot reach its own public name from inside
  its network, and what Apple's and Google's fetchers see is not what a container sees. So
  `ok` is worded for what was looked at ("these are the server's own copies"), and the docs
  give the two `curl` lines and the vendors' own tools for the rest.
- **What is a failure and what is a warning.** A stored app that is not well formed, a file
  that does not name the stored apps, and a file that `PUBLIC_URL` answers with a redirect,
  another status or something that is not JSON are `fail`: each is a thing a platform is
  given and refuses. A `401` or a `403` is `warn` (changed in review): the two routes take no
  key, so the answer is an access wall's or a firewall's in front of the API's own host, and
  what that does to the server's own request says nothing about the request a platform makes
  to the apps' domain. Every sentence about a fetch says where it asked ("PUBLIC_URL, the
  server's own address"), so that no answer there is read as the platforms'. A body that
  differs is `warn`: the route says `max-age=300`, and a cache
  in front of the API may rightly serve the file as it was five minutes ago. No answer is
  `warn`: nothing was seen to be wrong, and `public_url` fails for the same reason and says
  what to do. An environment over the cap is `warn`: its files are served.
- **The relying party is judged by its form only.** Where an environment has apps:
  `passkeys.rpId` must be a domain name and not `localhost` or a loopback name, because the
  file is fetched from `https://<rpId>/.well-known/…` by servers that reach neither. With
  passkeys on, a relying party that cannot be associated is `warn` and never `fail`: nothing
  that worked is broken.
- **An iOS app whose passkey requests the server refuses is `warn`** (added 2026-10-09,
  TULA-31). Passkeys on, a relying party a platform can associate, an iOS app registered,
  and `https://<rpId>` not among the environment's allowed origins: every passkey request
  of an iOS app is `request.origin_not_allowed` there
  ([ADR 0027](0027-passkeys.md#native-apps-added-2026-10-09-tula-31)), and nothing else
  tells the operator why. It is a finding of `native_app_passkeys`, not a check of its own,
  counted by environment and asked of the function that decides a request
  (`Passkeys.acceptedNativeOrigins`), so the check and the rule cannot disagree. Fixed
  text; no origin, relying-party id or identifier. Its fix says what allowing the origin
  also allows (a page at that address may use the client API). Where a relying party that
  cannot be associated is found as well, that finding leads and this one is a clause with
  its count ("In N more, iOS passkeys are refused."): the summary has 512 characters, and
  the fix gains one sentence for it; the next run says it in full.
- **Passkeys off is `ok`, and said** (changed in review; the first version warned). The
  association files serve saved-password autofill too (`webcredentials`,
  `get_login_creds`), so apps registered where passkeys are off is a state an operator may
  mean to be in, and a warning there made `tula doctor --strict` fail a deployment with
  nothing to put right. The check says in how many environments, and that the apps there use
  the files for saved passwords only: a reader who meant passkeys to be on sees it.
- **A loopback relying party is `ok` in the `local` tier, and said** (added in review).
  `localhost` or a name under `.localhost` is what a developer's machine has, and no
  platform associates an app with it anywhere. The tier is the configuration's
  (`ENVIRONMENT`), never `NODE_ENV`. In `dev`, `staging` and `prod` it stays the warning; a
  relying party that is not set, or is no domain name at all (an IP address, the loopback
  ones included), is the warning in every tier, because that is a setting left unfinished
  and not a developer's address.
- **No native app: `skipped`.** In every environment looked at, with a fixed sentence. Apps
  of one platform only: the other platform's file is not sampled and is no finding.

## Consequences

- The server can say which apps are an environment's, and serves the two files from that.
- An operator has one more thing to set up that Tula cannot do for them: their domain has to
  answer two paths. The dashboard and the docs say so. `tula doctor` checks the server's
  side of it and says that the domain's side was not looked at (below).
- Registering an app in CI needs `--allow-weaker` once.
- A migration adds one empty table with its own grants. No existing table is touched.

## What could not be verified

No device, simulator or vendor tool was used. Stated, and not proven:

- That Apple accepts a file with `webcredentials` alone, served as `application/json`
  (Hono may add `; charset=UTF-8`), and that Android accepts a statement whose only relation
  is `get_login_creds`. Google's passkey guidance shows it beside `handle_all_urls`; the
  Digital Asset Links format treats relations independently, and that is the reading taken.
- The 155 and 255 character limits and the character sets, against what App Store Connect
  and the Play Console enforce. A wrong rule here refuses a valid identifier (too strict)
  or stores one no store would issue (too loose); neither puts anything dangerous in a file.
- Whether Apple compares bundle IDs with or without case. They are stored and compared
  exactly, so two that differ only in case are two apps here.
- Both platforms' caching periods.

TULA-31 built the server's side of native passkeys and did not put a device in front of
these files either: the first two are still unproven, and so are the two origins a
platform writes into a passkey response
([ADR 0027](0027-passkeys.md#native-apps-added-2026-10-09-tula-31)). The native SDKs
are where a device first meets them.

## Alternatives considered

- **A field of the settings document.** Rejected under "A native app is a row".
- **Serving at the API's root by `Host`.** Rejected under "Where the files are served".
- **One default environment's files at the root.** A deployment with one production
  environment could have it; the second environment would then be the one that does not
  work, and nothing in a deployment is "the default". Rejected.
- **Serving `applinks` and `handle_all_urls` now**, to save TULA-32 a change. Rejected under
  "What the files hold now".
- **A separate table per platform.** Two stores, two sets of routes and two event families
  for one idea, and a third for the next platform. Rejected.
- **Putting the identifier in events**, since it is public. Rejected under "What is
  recorded".
