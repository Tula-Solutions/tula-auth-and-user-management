# JWT templates and custom claims

A **JWT template** is a named set of **custom claims** an environment adds to its sessions.
A [session profile](methods/sessions.md) names the template its sessions use. The claims
arrive under one claim of the access token, `ext`, so that your backend can decide from the
token alone: no extra request for "what plan is this user on" or "which address is this".

The reasoning, and what was left out on purpose, is in
[ADR 0036](adr/0036-jwt-templates.md).

## Define a template

A template lives in the environment's settings, under `sessions.jwtTemplates`, and a profile
chooses it with `jwtTemplate`. An environment with no template issues exactly the tokens it
always did.

| Where | How |
| --- | --- |
| Dashboard | **Session profiles**: the **JWT templates** section to add a template and its claims, and **JWT template** on a profile's card to choose one. |
| `tula.config.ts` | `sessions.jwtTemplates` and `sessions.profiles.<name>.jwtTemplate` ([settings as code](config.md)). |
| Admin API | `PUT /v1/admin/settings`. |

<!-- snippet: examples/docs-snippets/admin.ts#settings-jwt-template -->
```ts
const { data } = await admin.call('getEnvironmentSettings')
await admin.call('replaceEnvironmentSettings', {
  headers: { 'If-Match': ifMatch(data.revision) },
  body: {
    ...data.settings,
    sessions: {
      ...data.settings.sessions,
      jwtTemplates: {
        ...data.settings.sessions?.jwtTemplates,
        app: {
          claims: {
            email: { from: 'user.email' },
            email_verified: { from: 'user.email_verified' },
            plan: { value: 'team' },
          },
        },
      },
      profiles: {
        ...data.settings.sessions?.profiles,
        web: { ...data.settings.sessions?.profiles?.web, jwtTemplate: 'app' },
      },
    },
  },
})
```
<!-- /snippet -->

In `tula.config.ts` it is the same document:

```ts
sessions: {
  jwtTemplates: {
    app: {
      claims: {
        email: { from: 'user.email' },
        email_verified: { from: 'user.email_verified' },
        plan: { value: 'team' },
      },
    },
  },
  profiles: {
    web: { jwtTemplate: 'app' },
  },
},
```

A session of the `web` profile then carries:

```json
{
  "iss": "https://auth.example.com/v1/environments/0190…",
  "sub": "0190…",
  "sid": "0190…",
  "sp": "web",
  "ext": {
    "email": "ada@example.com",
    "email_verified": true,
    "plan": "team"
  }
}
```

## Where a claim's value comes from

A claim has **exactly one** source. There is no expression, no concatenation and no nesting.

| Source | Value |
| --- | --- |
| `{ from: 'user.email' }` | The user's address, in the form Tula matches addresses by (trimmed, ASCII letters lowercased). A string. |
| `{ from: 'user.email_verified' }` | Whether that address has been proven. A boolean. Left out, like `user.email`, for a user who has no address (an account made by signing in with X or Facebook); `false` means an address that is there and not proven. |
| `{ from: 'user.created_at' }` | When the account was created, in seconds since the epoch. A number. |
| `{ from: 'session.client' }` | The kind of client the session was started from: `web`, `ios`, `android` or `server`. |
| `{ from: 'session.created_at' }` | When the session was signed in to, in seconds since the epoch. A step-up does not move it (`auth_time` is the claim that moves). |
| `{ value: … }` | A constant: a string of up to 256 characters, a number or a boolean. Every session of the profile gets it. |

The list is closed. Everything in it is something the **server** knows; nothing a request said
about itself can become a claim. Not available, on purpose: the user's id (it is already
`sub`), the user's names (text the user typed, which would then sit in a signed token your
backend trusts), anything secret, and the session's IP address and user agent (personal data
that a request claimed when the session began, and stale by the next one).

**A `user.*` source on a stateful profile costs a database read on every request.** A
stateful session is checked against the database on each authenticated request, and with a
`user.*` source in its template that check also reads the user, every time: one more read
per request, for as long as the profile uses the template. The `session.*` sources and
constants cost nothing, on either session type. On a hybrid profile a `user.*` source costs
one read at sign-in and at a step-up, and none at a refresh
([What it costs](#what-it-costs)).

A constant says what **you** typed: `plan: { value: 'team' }` gives every session of that
profile `"plan": "team"`. It is useful to tell profiles apart (`{ value: 'back-office' }` on
the profile your staff tool asks for); it is not a per-user role. Per-user claims need a
source that knows the user: a [`before_token` hook](hooks.md), which asks your backend for
them ([Claims from a hook](#claims-from-a-hook)). Organizations and roles are later work.

## Rules

- **One namespace.** Every custom claim is inside `ext`. Nothing a template says can appear
  at the top level of the token.
- **Reserved names.** A claim key is never `iss`, `sub`, `aud`, `exp`, `nbf`, `iat`, `jti`,
  `sid`, `pid`, `eid`, `v`, `auth_time`, `amr`, `sp`, `cnf` or `ext`: the names Tula sets
  itself or keeps for later (`cnf` is for device-bound tokens). They are refused inside `ext`
  too, so that code which flattens the claims cannot be confused.
- **Keys** are ASCII letters, digits and `_`, not starting with a digit, at most 32 characters.
- **Caps.** At most 10 templates in an environment and 16 claims in a template. The claims of
  one template may take at most **1,024 bytes** as JSON. That is checked when the settings are
  saved, against the largest value each source can have (an address counts as 642 bytes), so a
  template that is accepted fits for every user. A template that could exceed the cap is
  refused with `validation.failed` on `sessions.jwtTemplates.<name>.claims`.
- **A profile names a template that exists.** Saving a profile that names a missing template,
  or removing a template a profile still names, is refused with `validation.failed` on
  `sessions.profiles.<name>.jwtTemplate`. Unset it on the profile first.
- **No value, no key.** A source that has nothing for a user leaves its key out; it is never
  `null`. A template with no claims adds no `ext` at all. Read a missing claim as "no".

## Claims from a hook

A [`before_token` hook](hooks.md) adds claims your backend answers with: a plan, a role, a
tenant id. They go inside the same `ext`, next to the template's, under the same rules for
keys and values and **inside the same 1,024 bytes**: the cap is on the two together.

- **Where both set a key, the hook's value wins.** A template is the profile's default for
  everybody; the hook's answer is about this user. So a constant is a good default
  (`plan: { value: 'free' }`) that the hook raises.
- **They are not read at every issue.** The template's claims are; the hook's are asked for
  when the session is created and when its user proves a factor again, stored on the
  session, and issued from there. A refresh does not call your backend. A change in your
  data reaches a session at its next sign-in or step-up, or when you end its sessions.
- **Claims that do not fit are a failed call**, not a cut one: if the hook's claims and the
  template's together are over the cap when the hook answers, the hook's `failureMode`
  decides (by default the sign-in is refused, and the hook shows
  `lastFailureReason: "claims_too_large"`).
- **If the two stop fitting later, the hook's claims stay and the template's go.** That
  happens when you save a larger template, or a user's address grows, after the hook
  answered for a session. That session's tokens are then issued with the hook's claims and
  **none** of the template's (all of them, not only the ones that did not fit), and a
  warning is logged with the template's name and the sizes, until the template shrinks or
  the session signs in again. The hook's claims are kept because they are about this user
  and may be a restriction your application reads as a present claim. Leave room: a
  template near the cap leaves none for a hook, and do not let an application depend on a
  template's claim being there when a hook is registered.
- A profile needs no template for a hook's claims to be issued.

## When a change takes effect

The claims are read from the user and the session **every time a token is issued**; nothing
is copied into the session. So:

- A session that began before the template was saved carries its claims from its **next
  refresh** (within one access-token lifetime, a minute by default). The same goes for a
  changed or removed template and for a user whose address was verified meanwhile.
- A token already issued keeps what it says until it expires. Do not put something in a claim
  that must be withdrawn faster than `accessTokenTtl`.
- With several API instances, another instance learns of a settings change within 5 seconds
  with Redis and 30 without ([self-host.md](self-host.md#running-it-for-real)); until then it
  issues the claims of the previous template. Add the access token's lifetime to get the
  longest a session can carry the old claims.
- A **stateful** session has no token. The same claims are in what
  `POST /v1/admin/sessions/verify` answers (`claims.ext`), read on every request: a change
  there is immediate on the instance that has it.

## Reading the claims

Verify the access token as you already do (issuer, audience, expiry, the environment's JWKS)
and read `ext`. With `@tula/nextjs`, `auth()` returns them for both session types:

```ts
import { auth } from '@tula/nextjs/server'

export default async function Page() {
  const { isSignedIn, customClaims } = await auth()
  if (!isSignedIn || customClaims.plan !== 'team') {
    return <p>Not on the team plan.</p>
  }
  return <TeamDashboard />
}
```

- `customClaims` is a read-only record whose values are `unknown`: check a value before you
  use it (`customClaims.plan === 'team'`, `typeof customClaims.seats === 'number'`).
- Signed in with no template, it is an empty object. Signed out, it is `null`.
- An `ext` that is not what Tula issues (not an object, a reserved or malformed key, a nested
  value, more than the cap) is treated as absent, whole. `@tula/contract/custom-claims`
  exports the same check, `readCustomClaims(claims)`, with no dependency, for your own
  verifier.

The browser SDKs (`@tula/core`, `@tula/react`) do not expose the claims: a token is for your
backend, and a claim read in the browser decides nothing.

## What it costs

- **Token size.** An access token without a template is about 720 characters. The claims add
  their JSON, base64url-encoded (4 characters for 3 bytes). A template at the cap makes the
  token about 2,080 characters, which with `@tula/nextjs` is a `tula_at` cookie of about 2,100
  bytes: inside the 4,096 a browser stores, with about 2,000 to spare. The cap is what keeps
  it there; it is not configurable.
- **Database reads.** Only a template with a `user.*` source costs any; `session.*` sources
  and constants cost none.

  | When | Extra reads with a `user.*` source |
  | --- | --- |
  | A refresh (hybrid) | None: it reads the user already. |
  | A sign-in or a step-up | One. |
  | **Every authenticated request of a stateful session** | **One, each time.** A stateful profile already reads the session per request; this makes it two. |

## Not built

- Claims from organizations, roles or user metadata: none of those exist yet.
- Custom claims in the browser SDKs, and a second token (an "API token" with another audience
  or lifetime). A template shapes the session's own access token and nothing else.
