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
| `{ from: 'user.email_verified' }` | Whether that address has been proven. A boolean. |
| `{ from: 'user.created_at' }` | When the account was created, in seconds since the epoch. A number. |
| `{ from: 'session.client' }` | The kind of client the session was started from: `web`, `ios`, `android` or `server`. |
| `{ from: 'session.created_at' }` | When the session was signed in to, in seconds since the epoch. A step-up does not move it (`auth_time` is the claim that moves). |
| `{ value: … }` | A constant: a string of up to 256 characters, a number or a boolean. Every session of the profile gets it. |

The list is closed. Everything in it is something the **server** knows; nothing a request said
about itself can become a claim. Not available, on purpose: the user's id (it is already
`sub`), the user's names (text the user typed, which would then sit in a signed token your
backend trusts), anything secret, and the session's IP address and user agent (personal data
that a request claimed when the session began, and stale by the next one).

A constant says what **you** typed: `plan: { value: 'team' }` gives every session of that
profile `"plan": "team"`. It is useful to tell profiles apart (`{ value: 'back-office' }` on
the profile your staff tool asks for); it is not a per-user role. Per-user claims need a
source that knows the user: organizations and roles, and a hook that adds claims, are later
work.

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
- **Database reads.** A refresh reads the user already, and gains no read. A sign-in, a
  step-up and a stateful session's request read the user once more **only** when the template
  has a `user.*` source.

## Not built

- A hook that adds claims (they will arrive under `ext` and inside the same 1,024 bytes).
- Claims from organizations, roles or user metadata: none of those exist yet.
- Custom claims in the browser SDKs, and a second token (an "API token" with another audience
  or lifetime). A template shapes the session's own access token and nothing else.
