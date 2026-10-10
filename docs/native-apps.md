# Native apps

iOS and Android decide whether an app belongs to a website by fetching a file from that
website: Apple's `apple-app-site-association` and Android's `assetlinks.json`. An operator
tells Tula which apps are theirs, per environment, and Tula builds both files from that list.

This page covers registering an app, the two files and what is in them, and how to get them
onto your own domain, which is where the platforms look. The decisions are in
[ADR 0040](adr/0040-native-app-identity.md).

**What this is for today, and what it is not.** A registered app is named in the files so
that it may use the credentials saved for the domain (the `webcredentials` section, the
`get_login_creds` relation). Nothing else is built on it yet: the native SDKs, passkeys in a
native app, app links and universal links arrive with later steps of
[Phase 2](plans/phase-2.md). Neither file hands an app a link of your domain.

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
| `PATCH /v1/admin/native-apps/:id` | An iOS app's `teamId`, or an Android app's `sha256CertFingerprints` (the whole set, replacing the stored one). |
| `DELETE /v1/admin/native-apps/:id` | Remove it. `204`. |

| Refusal | Answer |
| --- | --- |
| An identifier that is not one, a key the body does not have (`relation`, `paths`), a field of the other platform on an update | `422 validation.failed`, with the field |
| A list of fingerprints that names one twice, in whatever spelling | `422 validation.failed` on `sha256CertFingerprints` ("Name each fingerprint once") |
| The environment already has that app | `409 resource.conflict` |
| The environment already has 20 apps | `409 resource.conflict` with `params.max` |
| The app changed between the server's read and its write | `409 resource.conflict`: read it again |
| No such app in this environment | `404 resource.not_found` |

The same can be done in the [dashboard](dashboard.md) ("Native apps") and in
[`tula.config.ts`](config.md#native-apps).

### What widens, and is asked about

Three changes widen who the platforms will believe is your app, and are treated like a
weakened setting: the audit entry says `weakened: true`, the dashboard asks first, and
`tula apply --yes` needs `--allow-weaker`.

- **Registering an app.** The files name it from then on.
- **Another team for an iOS app.** The app the file names is another developer's.
- **A gained fingerprint.** Whoever holds that certificate's key can sign the app.

Removing an app, and taking a fingerprint away, widen nothing.

### What is recorded

`native_app.created`, `native_app.updated` and `native_app.deleted`, in the audit log and as
events a [webhook endpoint](webhooks.md) can subscribe to. They carry the app's id, its
platform, how many fingerprints it has, which fields changed and whether the change widened
anything. They never carry the bundle ID, the package name, the team or a fingerprint: an
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

**What is not in them.** No `applinks` section and no `handle_all_urls` relation: either
would let an app open links of your domain, and which links an app takes is a decision of
its own, made when app-link redirects are built. No `appclips`, no `activitycontinuation`.
Nothing a request sends chooses what a file holds: the environment is the one in the path,
and the apps are that environment's rows.

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

## Checking with `tula doctor`

[`tula doctor`](cli.md#tula-doctor) (and the dashboard's Diagnostics screen, which shows the
same checks) looks at the server's side of all this:

| Check | What it tells you | What it does not |
| --- | --- | --- |
| `native_app_identities` | Every registered app is well formed: the identifiers have the shape a registration is held to, and an Android app has a fingerprint. | That a bundle ID, a team or a fingerprint is the one your app really has. Compare them with Xcode, the Play Console and `keytool` yourself. |
| `native_app_files` | The files the server builds name exactly your registered apps, and the server's own address (`PUBLIC_URL`) answers with them: HTTP 200, `application/json`, no redirect. A `401` or a `403` there is a warning, not a failure: something in front of the API's own host answered. | Anything about **your** domain. The server never requests it. |
| `native_app_passkeys` | Where an environment has apps and passkeys are on, `passkeys.rpId` is a domain a platform can associate with an app (not `localhost`). Passkeys off is `ok`: it says so, and that the apps there use the files for saved passwords only. On a developer's machine (`ENVIRONMENT=local`) a `localhost` relying party is `ok` too, with a note. | That the domain answers the two `/.well-known/` paths. Whether you meant passkeys to be on. |

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

Apple's validation is `swcutil` on a Mac and the device's own logs; Google's is the Digital
Asset Links API (`https://digitalassetlinks.googleapis.com/v1/statements:list`). Run both
against your domain before relying on the files.

## Not built yet

- Passkeys in a native app, and the origin an Android app signs with
  (`android:apk-key-hash:…`).
- App links and universal links (`applinks`, `handle_all_urls`), and redirecting back to an
  app after an OAuth sign-in.
- A check of **your domain's** files in `tula doctor`: it checks the server's own copies
  ([above](#checking-with-tula-doctor)) and never requests an address of yours.
- A tool in the [MCP server](mcp.md): it has none for native apps.
