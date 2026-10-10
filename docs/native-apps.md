# Native apps

iOS and Android decide whether an app belongs to a website by fetching a file from that
website: Apple's `apple-app-site-association` and Android's `assetlinks.json`. An operator
tells Tula which apps are theirs, per environment, and Tula builds both files from that list.

This page covers registering an app, the two files and what is in them, how to get them
onto your own domain, which is where the platforms look, and how a provider sign-in gets
back into your app. The decisions are in [ADR 0040](adr/0040-native-app-identity.md) and
[ADR 0044](adr/0044-app-link-and-custom-scheme-redirects.md).

**What this is for today, and what it is not.** A registered app is named in the files so
that it may use the credentials saved for the domain (the `webcredentials` section, the
`get_login_creds` relation), and the API accepts a passkey made or used in it
([below](#passkeys-from-an-app)). An app you give [link paths](#link-paths) is also handed links
of your domain, which is how a [provider sign-in returns to it](#returning-to-your-app-after-a-provider-sign-in).
The native SDKs arrive with later steps of
[Phase 2](plans/phase-2.md). **Without link paths, neither file hands an app a link of your
domain.**

## Register an app

An environment has up to 20 native apps. An app is **its platform and its bundle ID or
package name**: there is one per pair, and neither can be changed afterwards.

| Platform | You give | Rules |
| --- | --- | --- |
| iOS | `teamId`, `bundleId` | The team is the ten upper-case letters and digits of your Apple team (the App ID prefix). The bundle ID is two or more segments of letters, digits and hyphens joined by periods, at most 155 characters, compared exactly (case included). No wildcard. |
| Android | `packageName`, `sha256CertFingerprints` | The package name is two or more segments joined by periods, each starting with a letter and holding letters, digits and underscores, at most 255 characters. One to ten SHA-256 fingerprints of the certificates the app is signed with. |

A fingerprint is accepted as `keytool` and the Play Console print it (`14:6D:E9:…`, in either
case) and as 64 hex digits with no colons (what `apksigner verify --print-certs` prints). It
is stored and served in upper case with colons, and a list of fingerprints is a set: its
order means nothing, and it is stored sorted. **The API refuses a list that names one
fingerprint twice** (`422`, "Name each fingerprint once"), also when the two differ only in
case or in their colons: a repeat in a request is more likely a pasted mistake than an
intention. The dashboard's form and `tula.config.ts` drop repeats themselves before
anything is sent. With Play App Signing the certificate that signs what users install
is Google's **app signing key**, not your upload key: use the fingerprint the Play Console
shows under "App signing key certificate".

With a secret key:

```sh
curl -X POST "$TULA_API_URL/v1/admin/native-apps" \
  -H "Authorization: Bearer $TULA_SECRET_KEY" -H 'Content-Type: application/json' \
  -d '{ "platform": "ios", "teamId": "A1B2C3D4E5", "bundleId": "app.northline.ios" }'
```

| Route | What it does |
| --- | --- |
| `GET /v1/admin/native-apps` | The environment's apps, oldest first. |
| `POST /v1/admin/native-apps` | Register one. `201` with the app. |
| `GET /v1/admin/native-apps/:id` | One app. |
| `PATCH /v1/admin/native-apps/:id` | An iOS app's `teamId`, an Android app's `sha256CertFingerprints` (the whole set, replacing the stored one), or either's `appLinkPaths` (the whole set; `[]` takes every link back). |
| `DELETE /v1/admin/native-apps/:id` | Remove it. `204`. |

| Refusal | Answer |
| --- | --- |
| An identifier that is not one, a key the body does not have (`relation`, `paths`), a field of the other platform on an update | `422 validation.failed`, with the field |
| A list of fingerprints that names one twice, in whatever spelling | `422 validation.failed` on `sha256CertFingerprints` ("Name each fingerprint once") |
| A link path that is not one exact path (a wildcard, a query, a trailing slash, `/` alone), a path twice, more than 10 | `422 validation.failed` on `appLinkPaths` |
| The environment already has that app | `409 resource.conflict` |
| The environment already has 20 apps | `409 resource.conflict` with `params.max` |
| The app changed between the server's read and its write | `409 resource.conflict`: read it again |
| No such app in this environment | `404 resource.not_found` |

The same can be done in the [dashboard](dashboard.md) ("Native apps") and in
[`tula.config.ts`](config.md#native-apps).

### Link paths

An app has no link path unless you give it one. `appLinkPaths` is a set of up to 10 **exact
paths** of your domain that the app opens: each starts with `/`, holds letters, digits and
`-`, `.`, `_`, `~` in segments joined by `/`, is at most 255 characters, and has no
wildcard, no query, no fragment and no trailing slash. `/` alone is refused.

```sh
curl -X PATCH "$TULA_API_URL/v1/admin/native-apps/$APP_ID" \
  -H "Authorization: Bearer $TULA_SECRET_KEY" -H 'Content-Type: application/json' \
  -d '{ "appLinkPaths": ["/oauth/callback"] }'
```

What that does differs by platform, and the difference matters:

- **iOS.** Apple's file hands the app exactly those paths (`applinks`, one `components`
  entry per path, no wildcard). Every other link of your domain stays the browser's.
- **Android.** Android's file has no place for a path. With one or more paths, the app gets
  the relation `handle_all_urls`, **which lets it claim every link of the domain the file
  is published on**. Which links it really opens is decided by the intent filters in the
  app's own manifest, not by this list. Give an Android app a path only when the app is
  yours to ship, and keep its manifest's filters as narrow as the paths you wrote here.

### What widens, and is asked about

Four changes widen who the platforms will believe is your app, or what it is handed, and
are treated like a weakened setting: the audit entry says `weakened: true`, the dashboard
asks first, and `tula apply --yes` needs `--allow-weaker`.

- **Registering an app.** The files name it from then on.
- **Another team for an iOS app.** The app the file names is another developer's.
- **A gained fingerprint.** Whoever holds that certificate's key can sign the app.
- **A gained link path.** The app opens links of your domain that the browser opened
  before; on Android, with the first path, any of them.

Removing an app, and taking a fingerprint or a link path away, widen nothing.

### What is recorded

`native_app.created`, `native_app.updated` and `native_app.deleted`, in the audit log and as
events a [webhook endpoint](webhooks.md) can subscribe to. They carry the app's id, its
platform, how many fingerprints and link paths it has, which fields changed and whether the
change widened anything. They never carry the bundle ID, the package name, the team, a
fingerprint or a path: an
event goes to every subscribed endpoint. So the audit log says that an Android app was
removed and by whom, and not which one; the id is in the entry for as long as you keep a
record of your own.

## The two files

For an environment, without a key:

```
GET /v1/environments/<environment id>/.well-known/apple-app-site-association
GET /v1/environments/<environment id>/.well-known/assetlinks.json
```

Both answer `200` with `Content-Type: application/json`, `Cache-Control: public, max-age=300`
and `X-Content-Type-Options: nosniff`, never a redirect and never a cookie. An environment
that does not exist is a `404`, as for its JWKS. They are rate limited per address (600 a
minute), like the JWKS.

With one iOS app and one Android app registered:

```json
{ "webcredentials": { "apps": ["A1B2C3D4E5.app.northline.ios"] } }
```

```json
[
  {
    "relation": ["delegate_permission/common.get_login_creds"],
    "target": {
      "namespace": "android_app",
      "package_name": "app.northline.android",
      "sha256_cert_fingerprints": ["14:6D:E9:83:…:44:E5"]
    }
  }
]
```

With no app of a platform, Apple's file is `{}` and Android's is `[]`: a file that names
nobody grants nothing, and a platform that fetches it gets a well-formed answer.

With the [link path](#link-paths) `/oauth/callback` on both apps:

```json
{
  "webcredentials": { "apps": ["A1B2C3D4E5.app.northline.ios"] },
  "applinks": {
    "details": [
      { "appIDs": ["A1B2C3D4E5.app.northline.ios"], "components": [{ "/": "/oauth/callback" }] }
    ]
  }
}
```

```json
[
  {
    "relation": [
      "delegate_permission/common.get_login_creds",
      "delegate_permission/common.handle_all_urls"
    ],
    "target": {
      "namespace": "android_app",
      "package_name": "app.northline.android",
      "sha256_cert_fingerprints": ["14:6D:E9:83:…:44:E5"]
    }
  }
]
```

Android's file names no path: it cannot. An app with no link path has no `applinks` entry
and no `handle_all_urls`, and with no such app at all Apple's file has no `applinks`
section.

**What is not in them.** No wildcard and no `?` in a component. No `appclips`, no
`activitycontinuation`. Nothing a request sends chooses what a file holds: the environment
is the one in the path, and the apps are that environment's rows.

**How current they are.** The server reads the list on every request, so its answer follows
a change at once; a cache in front of it may serve the old one for five minutes. That is
all this page can state as checked. The platforms keep their own copies, on schedules that
are theirs and that were not measured here: Apple documents that devices ask Apple's CDN,
which fetches your file and caches it; Android documents, for app links, that the file is
verified when an app is installed or updated, and whether the same holds for the
credentials relation served here (`get_login_creds`) was not checked. Do not plan on a
change, in either direction, being seen at once: assume a removed app keeps working for
some time, and how long is among [what could not be verified](#what-could-not-be-verified-here).

## Getting the files onto your domain

Apple and Android do not ask Tula. They fetch

```
https://<your domain>/.well-known/apple-app-site-association
https://<your domain>/.well-known/assetlinks.json
```

over https, and neither follows a redirect. `<your domain>` is the one your app claims: for
passkeys that is the relying-party ID (`passkeys.rpId`, usually your site's domain), in iOS
the domain of the app's `webcredentials:` associated-domains entitlement. That is rarely the
host the Tula API runs on, and one API serves many environments, so the API does not answer
`/.well-known/…` at its own root and never picks an environment from the `Host` header.

Have your domain answer the two paths with the content of the environment's files. Pass the
request on; do not redirect.

**nginx**, in the `server` block of your site:

```nginx
location = /.well-known/apple-app-site-association {
    proxy_pass https://auth.example.com/v1/environments/<environment id>/.well-known/apple-app-site-association;
    proxy_ssl_server_name on;
    proxy_set_header Host auth.example.com;
}
location = /.well-known/assetlinks.json {
    proxy_pass https://auth.example.com/v1/environments/<environment id>/.well-known/assetlinks.json;
    proxy_ssl_server_name on;
    proxy_set_header Host auth.example.com;
}
```

**Caddy:**

```
handle /.well-known/apple-app-site-association {
    rewrite * /v1/environments/<environment id>/.well-known/apple-app-site-association
    reverse_proxy https://auth.example.com {
        header_up Host auth.example.com
    }
}
handle /.well-known/assetlinks.json {
    rewrite * /v1/environments/<environment id>/.well-known/assetlinks.json
    reverse_proxy https://auth.example.com {
        header_up Host auth.example.com
    }
}
```

**Next.js** (`next.config.ts`): a rewrite to another origin is proxied by the Next.js
server, which is what is wanted here.

```ts
const tula = `${process.env.TULA_API_URL}/v1/environments/${process.env.TULA_ENVIRONMENT_ID}/.well-known`

export default {
  async rewrites() {
    return [
      { source: '/.well-known/apple-app-site-association', destination: `${tula}/apple-app-site-association` },
      { source: '/.well-known/assetlinks.json', destination: `${tula}/assetlinks.json` },
    ]
  },
}
```

`@tula/nextjs` has no helper for this yet: its route handler forwards `/v1/client/*` and
nothing else, on purpose, and the SDK does not know the environment's id.

**Or publish a copy.** Fetch the two files in your site's build and ship them as static
files. Nothing then depends on the API being reachable from your domain; the cost is that a
change in Tula reaches the platforms only with your next build.

Check what your domain serves:

```sh
curl -si https://northline.app/.well-known/apple-app-site-association | head -n 12
curl -si https://northline.app/.well-known/assetlinks.json | head -n 12
```

Look for `200`, `content-type: application/json` and no `location` header. Apple's file has
no file extension: a static host that guesses the type from one will serve it as
`application/octet-stream` unless told otherwise.

## Passkeys from an app

With [passkeys](methods/passkeys.md) switched on and the files on the relying party's
domain, a registered app can create a passkey and sign in with one. The app runs the
platform's own ceremony (Credential Manager on Android,
`ASAuthorizationPlatformPublicKeyCredentialProvider` on iOS) with the options the API
gives it, and sends the platform's answer back **unchanged**.

What a request from an app looks like:

- **No `Origin` header.** A request with one is judged as a page's, by that header, whatever
  else it says.
- **`x-tula-client: ios` or `android`**, on the call that starts a sign-in and on every
  signed-in passkey call. A sign-in keeps the kind it started with.
- Nothing in a body says which app it is. The platform writes that into the answer:

| Platform | What the answer carries | What the API accepts |
| --- | --- | --- |
| Android | `android:apk-key-hash:` and the SHA-256 fingerprint of the certificate the build is signed with (base64url, no padding) | The value for **each fingerprint of each registered Android app**. Compared as text, exactly. |
| iOS | `https://` and your `passkeys.rpId` | That value, **once at least one iOS app is registered and that origin is among `urls.allowedOrigins`**. Which app may use the domain is Apple's decision, from the file you publish. |

**For an iOS app's passkeys, add `https://<your relying party>` to the allowed origins**
(`urls.allowedOrigins` in the environment's settings; with `passkeys.rpId` `example.com`
that is `https://example.com`, exactly, with no path and no port). Without it every passkey
request from an iOS app is refused with `request.origin_not_allowed`, and
[`tula doctor`](#checking-with-tula-doctor) warns. Know what that also allows: the string an
iOS app presents is the origin of a page, so **a page at that address may then use the
client API from a browser**, passkeys included. The API cannot allow it for apps only; it
cannot tell an app's answer from that page's. If that address serves something you would
not let sign users in (a marketing site, user content), do not list it, and give iOS users
another way to sign in. An Android app needs no such entry: no page can present its origin.

The relying party is the environment's `passkeys.rpId`, for apps as for pages: a passkey
made in an app works on the web and the other way round.

What follows from that:

- **A debug build is signed with another certificate.** Register its fingerprint as well
  (in a development environment, not in production) or its sign-in is refused. The same
  goes for Play App Signing: the fingerprint that counts is the one of the key Google signs
  with, from the Play Console, not your upload key's.
- **An Android origin names a certificate.** Two of your apps signed with one certificate
  are the same to the API. Guard the signing key as the credential it is.
- **Removing an app, or a fingerprint, stops its passkey requests at once**, a ceremony
  under way included. The passkeys stay on their accounts: they belong to the domain, not
  to the app, and keep working from the web and from any other registered app.
- **The API cannot tell that a request really comes from your app.** It refuses what an
  honest phone reports as another app. The client kind is the caller's word, and somebody
  who holds a passkey's private key outside a phone can write any origin
  ([ADR 0027](adr/0027-passkeys.md#native-apps-added-2026-10-09-tula-31) has the argument).

| The answer | What it means |
| --- | --- |
| `request.origin_not_allowed` | The request had no `Origin` and no `x-tula-client` of `ios` or `android`; or the environment has no registered app of that platform; or, for `ios`, the relying party's own origin is not among the allowed origins; or it had an `Origin` that is not an allowed page's. Answered before a ceremony starts. |
| `auth.invalid_credentials` (a sign-in) | Refused, and the reason is not said: among them, a build whose certificate is not a registered fingerprint. |

The two differ on purpose. With no app of a platform (or, for iOS, the origin not allowed)
no answer could be accepted, so the API says so before it starts a ceremony, as it does for
a page it does not allow; with an app registered, whether an answer is that app's is known
only from the answer, and a refused one fails like every failed sign-in.
| `passkey.registration_failed` | The new passkey's answer did not verify: among the reasons, the same one. |
| `auth.method_disabled` | Passkeys are off, or `passkeys.rpId` is not set. |

**None of this has been run on a phone or an emulator.** The Android value is as Google
documents it; the iOS value is not in Apple's documentation at all and is what developers
report ([below](#what-could-not-be-verified-here)).

## Returning to your app after a provider sign-in

A sign-in with Google, Apple or another provider ends with the API's callback redirecting
the browser to a **redirect URL** your app named at the start, with a single-use ticket in
the fragment. For a native app that URL is one of two things. Both are listed in
`urls.allowedRedirectUrls` like a web page, and both are matched **exactly**: the URL your
app sends must be, character for character, an entry of the list.

Because an entry is compared character for character, it may hold only characters that can
be seen. An entry with a control character, a backslash, whitespace or a character that
draws nothing (a zero-width space, a soft hyphen, a variation selector and the like, which
usually arrive with a paste) is refused when the settings are saved. An entry saved by an
earlier version that holds one is left out when the settings are read and no longer
matches: list the URL again, typed out. A letter outside ASCII, a punycode host and a
percent-encoded octet such as `%20` are fine.

### Use an app link when you can

An app link (Android) or universal link (iOS) is an `https` URL of your domain, such as
`https://northline.app/oauth/callback`. **Prefer it**, for three reasons:

- **The platform decides who opens it, from your domain's file.** iOS and Android hand
  such a link to the app the domain's association file names (by team and bundle ID, or by
  package name and signing certificate), which is the purpose of that file. Tula builds
  that file and cannot check that your domain serves it, that your app claims the domain,
  or what a device then does. None of this has been tested on a device
  ([below](#what-could-not-be-verified-here)). A custom scheme is checked by nobody at
  all: any app on the device can declare `com.northline.app:` and be the one that is
  opened.
- **Every provider works with it.** A custom scheme is refused for Apple, LinkedIn and
  Facebook (below).
- **It fails into the browser.** Where the app is not installed, the link opens your site,
  which can say so. A custom scheme with no app is an error page.

Three things have to line up, and **Tula checks none of them against the others**: it does
not know which domain publishes the files.

1. The app has the path as a [link path](#link-paths) (`/oauth/callback`).
2. Your domain serves the two files ([below](#getting-the-files-onto-your-domain)), and the
   app claims the domain (the `applinks:` associated-domains entitlement on iOS, a verified
   intent filter on Android).
3. `https://<that domain>/oauth/callback` is in `urls.allowedRedirectUrls`.

If one is missing, the link opens in the browser instead of the app. Nothing is signed in
there: the page does not hold the binding.

### A custom scheme, when you cannot

A custom scheme is a redirect URL such as `com.northline.app:/oauth/callback`.

| Rule | Why |
| --- | --- |
| The scheme is lower case and has a full stop: the reverse of a domain you control | A bare `northline:` collides with other apps by accident |
| Not a scheme a browser or the system handles (`javascript`, `data`, `file`, `intent`, `mailto`, …) | They do something else than open your app |
| A path of plain segments, and nothing else: no query, no fragment, no `%`, no user name | What is listed must be exactly what arrives |
| Only for an attempt started by a native client (`x-tula-client: ios` or `android`) | A browser has a page to return to |
| Only for a provider that binds its code with PKCE: Google, GitHub, Microsoft, Discord, X | A scheme can be claimed by another app, and PKCE is what makes an intercepted code useless |
| Never for an emailed sign-in link | The link's token would go to whichever app claimed the scheme |

`com.northline.app:/oauth` and `com.northline.app://oauth` are both accepted and are two
different URLs: list the one your app sends.

A listed custom scheme that is asked for where it may not be used answers
`400 request.redirect_not_allowed` with a fixed `params.reason`: `provider_without_pkce`
(Apple, LinkedIn, Facebook), `client_not_native` or `not_a_provider_sign_in`. A URL that is
not listed answers the same code with no reason. Which providers send PKCE is a fixed list
in `@tula/contract/redirect-url`, not a setting.

**Listing a custom scheme is treated as a weakened setting**: the audit entry says
`weakened: true` and names the list (`urls.allowedRedirectUrls`), never the URL; the
dashboard asks first; `tula apply --yes` needs `--allow-weaker`.

### What protects the sign-in either way

The callback sets no cookie and returns no token. It redirects with a ticket that is used
once, lives 60 seconds, and **completes nothing without the binding** the start returned to
your app. An app that received your redirect by claiming your scheme holds a ticket and an
attempt id, and can do nothing with them. It can still make the sign-in fail, by being the
app that was opened: that is the cost of a custom scheme, and the reason to prefer an app
link.

Keep the binding in memory or the platform's secure storage for the length of the sign-in,
never in the redirect URL.

## Checking with `tula doctor`

[`tula doctor`](cli.md#tula-doctor) (and the dashboard's Diagnostics screen, which shows the
same checks) looks at the server's side of all this:

| Check | What it tells you | What it does not |
| --- | --- | --- |
| `native_app_identities` | Every registered app is well formed: the identifiers and the link paths have the shape a registration is held to, and an Android app has a fingerprint. | That a bundle ID, a team or a fingerprint is the one your app really has. Compare them with Xcode, the Play Console and `keytool` yourself. |
| `native_app_files` | The files the server builds name exactly your registered apps, with `applinks` and `handle_all_urls` exactly where an app has a link path, and the server's own address (`PUBLIC_URL`) answers with them: HTTP 200, `application/json`, no redirect. A `401` or a `403` there is a warning, not a failure: something in front of the API's own host answered. | Anything about **your** domain. The server never requests it. |
| `native_app_passkeys` | Where an environment has apps and passkeys are on, `passkeys.rpId` is a domain a platform can associate with an app (not `localhost`), and, where one of the apps is an iOS app, the relying party's own origin is among the allowed origins (a warning otherwise: the API refuses that app's passkey requests). Passkeys off is `ok`: it says so, and that the apps there use the files for saved passwords only. On a developer's machine (`ENVIRONMENT=local`) a `localhost` relying party is `ok` too, with a note. | That the domain answers the two `/.well-known/` paths. Whether you meant passkeys to be on. |

With no app registered the three are `skipped`. A count is all a check says ("1 of the 3
native apps"); the API's log names the rows by id.

So a green `tula doctor` means the server has it right, and the last step is still yours:
the two `curl` lines above against your own domain, and the vendors' tools below.

## What could not be verified here

The files were built from the two platforms' published formats and checked against the
API's own tests. No device and no vendor tool was involved, so the following is stated and
not proven:

- That Apple accepts the file as served (the `webcredentials` section alone, `apps` as
  `<team>.<bundle id>`, `application/json` possibly with a `charset` suffix) and that
  Android accepts `get_login_creds` as the only relation of a statement.
- Apple's limits on a bundle ID (the 155 characters, the allowed characters) and Android's
  on a package name (255 characters) as enforced here. The rules are a floor that keeps
  what is not an identifier out, not a copy of either store's validation.
- How long each platform caches, and when each fetches the file again (for Android, whether
  the install-time verification documented for app links is also what `get_login_creds`
  gets). Both are theirs to change.
- That Apple accepts `applinks.details` with exact-path `components` as served, and Android
  a statement with both relations.
- **That the platform hands the callback's redirect to your app.** The server answers `303`
  with the right `Location`. iOS opens a universal link on a tap and, for a sign-in, through
  `ASWebAuthenticationSession`'s `https` callback (iOS 17.4 and later); a redirect in an
  ordinary browser tab may stay in the browser. Android's Custom Tabs have rules of their
  own for a redirect with no user gesture. How your app opens the sign-in decides, and the
  native SDKs are where this gets proven.

- **Passkeys from an app.** No passkey ceremony was run on a device or an emulator; the
  Android origin string and the iOS origin are from the platforms' documentation, and for
  iOS not even that: Apple's pages do not say what origin its API writes, and
  `https://<rpId>` is what developers report. If a platform writes something else, every
  passkey request from its apps is refused (`auth.invalid_credentials`,
  `passkey.registration_failed`) and nothing wrong is accepted.

Apple's validation is `swcutil` on a Mac and the device's own logs; Google's is the Digital
Asset Links API (`https://digitalassetlinks.googleapis.com/v1/statements:list`). Run both
against your domain before relying on the files.

## Not built yet

- The native SDKs that run a passkey ceremony for you. The API's side is built
  ([above](#passkeys-from-an-app)); until the SDKs exist an app calls the platform and the
  API itself.
- The native SDKs' side of a sign-in that returns to an app, and linking a provider to a
  signed-in account from a native app (that start is a browser's, and is refused a custom
  scheme).
- A loopback redirect (`http://127.0.0.1:<port>`) for a desktop app.
- A check of **your domain's** files in `tula doctor`: it checks the server's own copies
  ([above](#checking-with-tula-doctor)) and never requests an address of yours.
- A tool in the [MCP server](mcp.md): it has none for native apps.
