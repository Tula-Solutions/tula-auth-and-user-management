# ADR 0044: App-link and custom-scheme redirects

- **Status:** accepted
- **Date:** 2026-10-09
- **Ticket:** TULA-32 (phase 2, step 2.8)

## Context

A provider sign-in ends with the API's callback redirecting the browser to a redirect URL
the application chose, with a single-use ticket in the fragment
([ADR 0026](0026-oauth.md)). Until now that URL was a web page: `https`, or loopback `http`
in the `local` tier. A native app has no page. It is reached in one of two ways:

- an **app link** (Android) or **universal link** (iOS): an ordinary `https` URL of a
  domain that has said, in a file the platform fetches, that the app may open it
  ([ADR 0040](0040-native-app-identity.md));
- a **custom scheme** (`com.example.app:/oauth/callback`), which the app declares in its
  own manifest and which nothing verifies: any app on a device can declare any scheme.

ADR 0040 registered an environment's native apps and deliberately left `applinks` and
`handle_all_urls` out of the two files, as a decision of this step.

## Decision

### One rule, one place: an exact match

A redirect URL is allowed when it is, character for character, an entry of
`urls.allowedRedirectUrls`. Nothing is normalised on either side, for any kind of URL, and
`Settings.requireRedirectUrl` is still the only function that decides. There is no rule
"the URL belongs to a registered app": an app link is an `https` URL the operator lists,
exactly as a web page is.

That keeps the property the allow-list has always had (what the server redirects to is a
string an administrator typed) and means an app link needs no new matching code at all.
What is new for app links is in the files (below); what is new for custom schemes is what
may be listed and who may use it.

### What a redirect URL may be

`packages/contract/src/redirect-url.ts` (plain data and functions, no Zod, so the SDKs can
use it) names three kinds, and the settings schema accepts nothing else:

| Kind | Shape |
| --- | --- |
| `https` | starts with `https://`, parses as a URL, no user name, password or fragment |
| `loopback` | starts with `http://`, host `localhost`, `127.0.0.1` or `[::1]`; honoured in the `local` tier only |
| `custom_scheme` | `<scheme>:<path>`: a lower-case scheme **with at least one full stop** (RFC 8252's reverse-domain form), then one or more `/`-separated segments of unreserved characters |

A custom-scheme URL has no query, no fragment, no percent-encoding, no user name and no dot
segment. Both `com.example.app:/oauth` and `com.example.app://oauth/callback` are accepted,
because both are in use; they are different strings and each matches only itself.

**A web URL holds no character a header cannot carry or a reader cannot see.** An `https`
or loopback entry with a control character (U+0000 to U+001F, U+007F to U+009F), a
backslash (the URL parser reads it as a slash, so the entry would not be where the browser
goes) or a character the contract's `hasHiddenCharacter` refuses (text-direction controls,
private-use and unassigned characters, a lone surrogate) is refused at save. The rule is
one function, `hasForbiddenRedirectCharacter`, and it is asked three times: at save; by the
tolerant read, which drops such a stored entry and counts it with the other entries it
drops (the store logs the count, never the entry); and by `Settings.requireRedirectUrl` for
every URL it is about to honour, so a stored entry that got past both is refused when a
sign-in starts and not at the provider's callback. Should building the redirect still fail
at the callback, for whatever reason, the answer is the static error page and a log line
with the provider and the error's name: never a 500 after the state is spent.

**Schemes that are never a custom scheme** are a list (`REDIRECT_SCHEMES_NEVER_CUSTOM`):
what a browser or an operating system handles itself (`javascript`, `data`, `file`, `blob`,
`about`, `intent`, `mailto`, `tel`, `sms`, …) and the web's own, and, since the schemes of
some platforms are written with full stops, three families refused by prefix
(`REDIRECT_SCHEME_FAMILIES_NEVER_CUSTOM`): `microsoft.windows.` (Windows' built-in apps:
`microsoft.windows.camera`, `microsoft.windows.photos.crop`, …), `x-apple.`
(`x-apple.systempreferences`) and `com.apple.` (Apple's own bundle-id space).

**The list is best effort and is not what makes a custom scheme safe.** The entries without
a full stop are also refused by the reverse-domain rule; the dotted ones are refused by the
list alone, and a dotted scheme an operating system handles that nobody put on the list
passes the grammar (`microsoft.someapp.thing:/x` does). Two things bound that, and neither
is the list: every entry of `urls.allowedRedirectUrls` is written by the operator by hand
(no request, wildcard or pattern adds one, and a custom-scheme entry is asked about as a
weakening), and a redirect carries only a ticket that is useless without the binding. The
three families were written from the platforms' published lists of reserved schemes as
remembered; the pages were not re-read while this was written (a fetch of Microsoft's
"reserved URI scheme names" page returned another page), so the names are stated, not
verified.

One existing behaviour changed with this: a web redirect URL must now literally start with
`https://` or `http://`. `HTTPS://host/…` and `https:/host/…`, which the URL parser used to
repair, are refused when the settings are saved. Since matching is exact, such an entry
could only ever have matched a request spelled the same way.

### A custom scheme needs PKCE, a native client and a provider sign-in

`customSchemeRedirectRefusal(url, { client, provider })` answers one of three fixed words,
or nothing:

| Word | When |
| --- | --- |
| `provider_without_pkce` | the provider does not bind its code with PKCE |
| `client_not_native` | the attempt's client kind is `web` or `server` |
| `not_a_provider_sign_in` | the URL was asked for by something else (an emailed link) |

`Settings.requireRedirectUrl` takes what the URL is for (`RedirectUse`) and, for a URL that
**is listed**, refuses with `request.redirect_not_allowed` and the word in `params.reason`.
An unlisted URL is refused with no reason: nothing is said about what it would have been.
The provider's rule is reported before the client's.

**Why PKCE.** A custom scheme is claimed, not owned. With PKCE the code a provider sends
back is useless without the verifier the server holds on the attempt, so an app that
intercepts a redirect on the provider's side gains nothing. Tula's own last hop does not
carry a provider code at all: it carries the ticket, which is honoured only with the
binding (below). The refusal is still made, because the rule that makes a custom scheme
acceptable in RFC 8252 is "with PKCE", and a provider that documents none is one whose
codes are bound by less.

**Which providers.** Two closed lists in the same contract module:
`OAUTH_PROVIDERS_WITH_PKCE` (Google, GitHub, Microsoft, Discord, X) and
`OAUTH_PROVIDERS_WITHOUT_PKCE` (Apple, LinkedIn, Facebook), read through `bindsCodeWithPkce`.
A test fails for a provider of `OAUTH_PROVIDERS` that is in neither or in both, and another
builds every real adapter's authorization URL and fails when the lists disagree with whether
it carries a `code_challenge`. It is not a setting and not a stored value.

**The client kind is the client's own claim.** It is the `x-tula-client` header of the
start, which anything that holds a publishable key can set to `ios`. So
`client_not_native` is a policy check for honest clients (a browser SDK that is handed a
custom scheme by mistake is told so) and **not a boundary**: nothing rests on it. What
protects the ticket is the binding (returned once to whoever started the attempt, required
at the exchange) and, on the provider's side, PKCE. A caller that lies about its kind gets
a redirect to a URL the operator listed, carrying a ticket only that caller can use.

**What the reason tells a caller.** `params.reason` is kept on the refusal of a listed
custom scheme, so a caller with only a publishable key can tell a listed custom-scheme URL
from an unlisted one (a reason, or none). That is accepted: the list is not a secret
(every entry appears in the `Location` of a redirect to anyone who signs in through it),
the start reads no user and takes no identifier, so nothing about a person is involved,
and the word is what lets an integrator see which of the rules stopped them. A test pins
the difference and that the params hold the one key.

**Where.** At the start, before the attempt is made and before the environment's ceiling is
counted, and again at the provider's callback, against the attempt's own client and
provider (an attempt stored before a deployment that changed a list must not finish on the
old rule). The answer does not depend on who signs in.

**Linking a provider to a signed-in account** (`POST /v1/client/me/identities/oauth`)
always makes a `web` attempt, so it is refused a custom scheme (`client_not_native`).
Linking from a native app is left for the native SDKs.

**An emailed sign-in link** is never sent to a custom scheme (`not_a_provider_sign_in`):
the link's token would be handed to whichever app claimed the scheme, and the link binding
lives in a browser's storage, which a native app does not share.

### The ticket and the binding are unchanged

The callback answers a custom scheme and an app link exactly as it answers a page: `303`
with `Location: <redirect URL>#tula_ticket=…&tula_attempt=…`, an empty body, no cookie,
`Cache-Control: no-store`, `Referrer-Policy: no-referrer`. The ticket is single use, lives
60 seconds and completes nothing without the binding the start returned to the app that
asked. That is what makes a hijacked scheme harmless: the app that receives the redirect
has a ticket and an attempt id, and neither is a credential.

### Listing a custom scheme is a weakening

`settingsWeakenings` reports `urls.allowedRedirectUrls` when a change adds a custom-scheme
entry that was not listed. The audit entry says `weakened: true`, the dashboard asks first
and `tula apply --yes` needs `--allow-weaker`. The path is the list's name, never the URL:
a redirect URL is the operator's value, and the audit entry and the event already record a
settings change by key only. Adding an `https` entry is not a weakening, as before.

### App links: exact paths on a registered app

A native app gains `appLinkPaths`: up to ten exact paths (`MAX_APP_LINK_PATHS`), each
starting with `/`, of unreserved characters, at most 255 long, with no wildcard, query,
fragment, dot segment or trailing slash. A set, stored sorted; none by default. It is a
column of `native_apps` (migration `0031`), which the runtime role may update.

- **Apple's file** gains `applinks.details`: one entry per iOS app that has a path, with
  `appIDs: ["<team>.<bundle id>"]` and one `components` entry `{ "/": "<path>" }` per path.
  No `*`, no `?`, so an app is handed those paths and nothing else.
- **Android's file** has no place for a path. An Android app with at least one path gets
  the relation `delegate_permission/common.handle_all_urls` beside `get_login_creds`.
  **That relation covers every link of the domain the file is published on**; which of
  them the app actually opens is decided by the intent filters in the app's own manifest.
  The paths stored for an Android app are therefore the switch and a statement of intent,
  not something the file enforces. This is said in the docs, the dashboard and the API
  reference in those words.

An app with no path is in the files exactly as before.

**A gained path is a weakening** (`nativeAppWeakenings` answers `appLinkPaths`), and a
registration with paths is `['app', 'appLinkPaths']`. A path taken away is not. Events and
audit entries carry the number of paths and the field's name, never a path.

**The server does not connect a redirect URL to an app.** It does not check that a listed
`https` URL's host is the domain the files are published on, that its path is one of an
app's `appLinkPaths`, or that any app is registered. It cannot: it does not know which
domain proxies the files (ADR 0040), and a check that guessed would refuse correct setups.
Lining up the three things (the redirect URL in the allow-list, the path on the app, the
files on that URL's host) is the operator's, and `docs/native-apps.md` lists them. A
mismatch fails safe: the link opens in the browser instead of the app, where a page that
does not hold the binding completes nothing.

### Client kind

A custom scheme is for `ios` and `android` attempts. An `https` URL, app link or not, is
allowed for every kind: the server cannot tell an app link from a page and does not need
to.

### Config, CLI, dashboard, MCP

- `@tula/config`: `appLinkPaths` on a `nativeApps` entry, validated by the contract's
  function, normalised as a set. Left out, the key stays absent, so a file that does not
  use it hashes as before; `[]` is written and hashes differently, because it says
  something else (below).
- `tula diff` / `apply`: **`appLinkPaths` left out of an entry is unmanaged.** The server's
  paths are kept, no operation is planned and nothing is weakened; written, also as `[]`,
  the list is the app's whole set and what it leaves out is removed (not a weakening). This
  departs, for this one field, from "an entry is the whole app" (and from a hook, whose
  `failureMode` left out is the default and managed), on purpose. Taking a path away is no
  weakening, so no flag would stand between a file written before the field existed and
  the removal of every path somebody gave an app in the dashboard, which breaks the
  sign-ins that return by one. And the argument for a hook does not carry over: a hook
  left at `allow` by a file that says nothing is a check nobody has, while a kept path is
  no check missing. It is a grant somebody made, though, so `tula diff` says it: one
  informational line under such an app, `N link paths on the server, not managed by the
  file`, a count and no path (`unmanagedLinkPaths` in the JSON plan). A gained path is
  `nativeApps.<platform>/<identifier>.appLinkPaths` in `plan.weakened`. A server that
  predates the field is read as having none. A custom-scheme redirect URL added by the file
  is the settings weakening above.
- Dashboard: the native app forms and cards have the paths, the question before a gained
  path names what it hands over (for Android: every link of the domain), and saving a
  custom-scheme redirect URL is asked about first.
- `@tula/mcp` has no native-app tool and its settings projection already returns the
  redirect URLs as strings; nothing changed there.

### Loopback redirects for native apps

Out of scope. RFC 8252's third option (`http://127.0.0.1:<port>`) is for desktop apps; the
`local` tier's loopback rule is a development convenience and stays that.

## Consequences

- An operator can return a provider sign-in to their app, by either route, without any new
  kind of allow-list.
- Apple's file can now hold `applinks` and Android's `handle_all_urls`. Anything that
  inspects the files (`tula doctor`'s native-app checks, TULA-35) must expect them.
- Three providers cannot be used with a custom scheme. Their users are sent to an app link.
- `request.redirect_not_allowed` gained an optional `params.reason`.
- The conformance format gained `expectRedirectTo` on the `oauth` step; four scenarios (81
  to 84).

## Accepted risks

- **Android's relation is wider than the paths.** Stated above. The alternative, not
  serving `handle_all_urls`, means no Android app link at all.
- **A custom scheme can be claimed by another app.** Bounded by the binding (the ticket is
  useless without it) and by PKCE on the provider's side. A hostile app can still make the
  sign-in fail by receiving the redirect instead of the real app; that is why the docs
  recommend app links.
- **Nothing ties a redirect URL to a registered app.** Stated above; fails safe.

## What could not be verified

No device, simulator or vendor tool was used. Stated, and not proven:

- That Apple accepts `applinks.details` with `components` of exact paths as served, and
  that Android accepts a statement with both relations.
- **That a `303` to an app link opens the app.** iOS opens a universal link on a user's
  tap and, for a sign-in, through `ASWebAuthenticationSession`'s `https` callback (iOS
  17.4 and later); a redirect inside an ordinary browser tab may stay in the browser.
  Android's Custom Tabs have similar rules for redirects without a user gesture. The server
  sends the right `Location`; whether the platform hands it to the app depends on how the
  app opened the sign-in. The native SDKs (TULA-33, TULA-34) are where this is proven.
- That a `303` to a custom scheme is followed from every in-app browser.

## Alternatives considered

- **A redirect is allowed when it matches a registered app's domain and path.** A second
  rule beside the allow-list, and one that needs the server to know the app's domain.
  Rejected under "One rule, one place".
- **A separate list for custom schemes.** Two lists with one job, and two places to look
  when a redirect is refused. Rejected: the kind of an entry is read from the entry.
- **Wildcard paths for app links.** `/*` on iOS is what `handle_all_urls` is on Android,
  and "all of them is rarely right" (ADR 0040). Exact paths are enough for a callback.
- **Allowing a custom scheme for Apple, LinkedIn and Facebook because the ticket is bound
  anyway.** The binding protects Tula's hop, not the provider's. Rejected.
- **A scheme without a full stop** (`myapp:`). Collides with other apps by accident, which
  the reverse-domain form exists to prevent. Rejected, as RFC 8252 recommends.
- **Refusing an unlisted custom scheme with a reason.** It would tell an unauthenticated
  caller how the URL was read before saying it is not allowed. Rejected.
