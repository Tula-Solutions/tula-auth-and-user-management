# ADR 0018 — Per-environment settings

- Status: accepted
- Date: 2026-10-03

## Context

Until now everything about how sign-in behaves was configured for the whole deployment, through
environment variables: one password policy (`PASSWORD_POLICY`), one list of browser origins
(`CORS_ORIGINS`), and emails that named no app at all. A deployment serves many environments
(tenants), and those settings belong to the tenant: a production environment wants a stricter
policy than its development twin, two customers' apps live on different origins, and an email
that does not say which product it is from reads as phishing.

Every step that follows needs a place to put its own switches (enabled sign-in methods in 1.3
and 1.7–1.10, redirect URLs in 1.7 and 1.9, session profiles in 1.11), and config-as-code
(1.13) and the dashboard (1.15) need one document to read and write.

## Decision

### One document per environment

`EnvironmentSettings` (`packages/contract/src/environment-settings.ts`) is a single JSON
document with a format `version` (1) and five sections:

| Section | Holds |
| --- | --- |
| `app` | `name` (1–64 characters, no control characters or line breaks; default `Tula`) and `supportEmail` (an address or `null`). |
| `password` | The existing `PasswordPolicy`, unchanged. |
| `signIn.methods` | One `{ enabled }` switch per first factor. Only `password` exists; at least one must stay enabled. |
| `urls` | `allowedOrigins` (at most 50) and `allowedRedirectUrls` (at most 100). |
| `audit` | `retentionDays`: 1–3650, or `null` to keep entries for ever (the default). |

Every field has a default, so `{}` is a valid document. Because of that, **an unknown key is
refused**, not ignored: a misspelt `pasword` section would otherwise save successfully and
silently reset the policy to its default. Documents read back from storage are parsed
leniently instead (`parseStoredEnvironmentSettings`): unknown keys are dropped and missing
fields take today's defaults, so a document written by a newer server does not make an
environment unreadable after a rollback.

Origins are exact: scheme, lowercase host and an optional non-default port, as a browser sends
them. No path, no wildcard, and `http://` only for `localhost`, `127.0.0.1` and `[::1]`.
Redirect URLs follow the same scheme rule and may not carry credentials or a fragment. Custom
schemes for native apps are not accepted yet; loosening that later is not a breaking change.

Two settings are **stored and validated but not yet acted on**: `urls.allowedRedirectUrls`
(nothing redirects until magic links and OAuth) and `audit.retentionDays` (the retention job
of ADR 0017 still keeps every audit entry).

The row lives in `tula.environment_settings`: a tenant table like any other (tenant columns,
the composite foreign key, a forced row-level-security policy), with the document in `jsonb`,
a `revision` integer, and a unique key on `environment_id`. The runtime role may select,
insert and update it, never delete.

### The environment variables become defaults

An environment with no row is at **revision 0**, and its settings are the contract's defaults
with the deployment's `PASSWORD_POLICY` and `CORS_ORIGINS`. Once an environment saves a
document, that document is the whole truth for it and the variables no longer apply. They are
defaults, never overrides, so an operator cannot be surprised by a variable silently winning
over what the API returns.

`CORS_ORIGINS` is not re-validated at boot (that would stop existing deployments from
starting), so a default list can contain an entry the settings API refuses, such as a plain
`http` origin on a LAN. It keeps working as a default and has to be corrected when the
environment first saves its settings.

### Admin API: whole-document replace, guarded by the revision

- `GET /v1/admin/settings` returns `{ revision, settings }` with `ETag: "<revision>"`.
- `PUT /v1/admin/settings` replaces the whole document. It must carry `If-Match: "<revision>"`.
  A missing header is `precondition.required` (428); a revision that is no longer current is
  `precondition.failed` (412) with the current revision in `params.revision`. `*` and weak
  validators are refused: both would let a write through without saying what it replaces.

The replace is a compare-and-set in the store (`replace(environmentId, expectedRevision, …)`):
an insert that loses to the unique key for revision 0, a guarded `UPDATE … WHERE revision = n`
afterwards. Of two writers that read the same revision exactly one succeeds. A document equal
to the current one changes nothing: no new revision and no audit entry.

Whole-document replace was chosen over a patch because the two clients that will write
settings (config-as-code and the dashboard) both hold the whole document, and because a patch
format needs its own rules for "unset" that a replace does not.

Every change is recorded as `environment.settings_updated`, in the same transaction, with the
new `revision` and `changed`: the dotted keys that differ (`password.minLength`,
`urls.allowedOrigins`), lists compared whole. **Never the values**: an origin list or a support
address has no business in an audit log or in a webhook payload.

Three error codes are new: `precondition.required` (428), `precondition.failed` (412) and
`auth.method_disabled` (403).

### Client API

`GET /v1/client/config` (publishable key) returns what a sign-in screen needs: `app.name`,
`app.supportEmail`, the names of the enabled sign-in methods, and the password policy. The
support address is included because a sign-in screen links to it and every email already
shows it. The allow-lists and the audit settings are not returned. The method list is an
array of strings, not an enum, so an older client ignores methods it does not know.

It is cacheable for 60 seconds per key (`Cache-Control: private, max-age=60`). The server
enforces the settings whatever a client has cached. `GET /v1/client/password-policy` stays,
answering from the same document.

### Reads are cached; staleness is bounded

The policy is read on every password assessment and the allow-list on every browser request,
so `cacheEnvironmentSettings` keeps each environment's document (including "nothing saved")
in process for 30 seconds. The mechanism is the one already used for signing keys, lifted into
`createVersionedCache`:

- The instance that writes drops its own entry before the write returns. **It sees its own
  write at once.**
- With Redis, a write replaces a marker (`tula:es:<environment id>`, and `tula:es:all` for the
  union of origins) and every instance compares its entry with the marker at most once every
  5 seconds. **Another instance applies a change within 5 seconds.**
- Without Redis, or while Redis is down, the bound is the 30-second lifetime. The marker makes
  instances converge sooner; nothing depends on it for correctness.

The admin API does not read through the cache: `GET /v1/admin/settings` and the read that
precedes a replace go to the database, so a revision read on any instance is the one a replace
on any instance is checked against, and the audit entry's `changed` is computed against what
is really stored.

### CORS is decided per request

A browser request is in two parts, and only the second says which environment it is for:

1. **The preflight** (`OPTIONS`) carries no API key, so the environment is unknown. It is
   allowed when the origin is on the deployment's list or is allowed by **any** environment.
   That union is read by visiting each environment inside one transaction (row-level security
   shows one environment at a time) and is cached like the documents. A preflight only decides
   whether the browser may send the real request.
2. **The request itself** runs, and its response gets `Access-Control-Allow-Origin` and
   `Access-Control-Allow-Credentials` only when the origin is allowed for the environment the
   publishable key resolved to: its `urls.allowedOrigins`, the API's own origin, or in the
   `local` tier any loopback origin. An origin allowed by environment A gets no CORS headers
   on environment B's responses, so its JavaScript cannot read them.

A response produced before a key was resolved (an invalid key, the per-IP limit, an unknown
path, the public routes) contains nothing of any tenant and follows the preflight rule, so a
browser app can show the error code. `/v1/admin/*` follows the deployment's `CORS_ORIGINS`
only, as before: secret keys do not belong in browsers, and the dashboard's origin is a
deployment matter. Origins are echoed on an exact match, never as `*`, and `Vary: Origin` is
set on every response.

Not sending CORS headers stops a page from *reading* a response; it does not stop the request
from running. So the refresh cookie gets a check of its own: `POST /v1/client/sessions/refresh`
and `/sign-out` honour the cookie only when the request has no `Origin` header or an origin
the environment allows. A page on another origin of the same site (which `SameSite=Lax` does
not stop) can then neither rotate a session's token, nor end the session, nor make the browser
drop the cookie. A refresh token sent in the body is unaffected: JavaScript had to hold it.

Considered and rejected: answering every preflight permissively (simpler, but then only the
cookie check stands between any site and a credentialed request), and a second table of
origins outside row-level security to make the union one query (another exception to the
tenancy rule for the sake of a cached read).

### Sign-in methods

`Settings.requireMethod(deps, tenant, method)` is the one place a method's switch is checked.
Starting a sign-up, a sign-in or a password reset calls it first, before the identifier is
looked at, and answers `auth.method_disabled` (403) when password sign-in is off. Since
`password` is the only method and one must stay enabled, the API cannot produce that state
yet; the check is there so that steps 1.7–1.10 add a method by adding a switch.

### One email layout

`modules/email` owns the layout (plain text and minimal HTML) and the copy of every message:
verification code, password-reset code, account-exists notice, no-account notice. Every email
names the app in the subject and the body and shows the support address when one is set. The
code still leads the subject (`482913 is your Acme verification code`), so it can be read from
a notification, and so the conformance runner can find it.

The app name is operator input that reaches a mail header and HTML. It is refused at the API
if it contains control characters or line breaks, cleaned again where it is used (a line break
in a subject is how a header is injected), and HTML-escaped like every other interpolated
value. There is no template editor; that is Phase 2.

## Consequences

- Two environments of one deployment can enforce different password policies and allow
  different origins; a conformance scenario (`12-environment-settings`) changes the policy
  through the admin API, shows sign-up enforcing it on both instances, and puts the original
  document back.
- A settings change is not instantaneous everywhere: up to 5 seconds on other instances with
  Redis, up to 30 without. A tightened password policy can therefore be missed by a sign-up
  that lands on another instance in that window. A removed origin can additionally keep
  passing preflights for the 10 minutes a browser caches one, but its real requests are
  refused per environment as soon as the instance has the new document.
- The union of allowed origins costs two statements per environment each time it is rebuilt
  (at most once per 30 seconds per instance, and after a change). That is fine for the tens or
  hundreds of environments a self-hosted deployment has; a deployment with many thousands
  would want the union kept in Redis instead.
- An environment that saved settings no longer follows `PASSWORD_POLICY` and `CORS_ORIGINS`.
  There is no API to delete the row and return to the defaults; saving the default document
  has the same effect on behaviour.
- The refresh cookie is now refused from origins the environment does not allow. A browser app
  whose origin was never listed, and which relied on the request merely being sent, has to be
  added to `urls.allowedOrigins` (or to `CORS_ORIGINS`, for environments that have saved no
  settings).
- Email subjects changed (they now name the app). Anything that matched the old subjects
  verbatim has to match the new ones; the leading six digits are unchanged.
- `signing key` caching now goes through the shared `createVersionedCache`; its behaviour and
  tests are unchanged.
