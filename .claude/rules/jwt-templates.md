---
paths:
  - "apps/api/src/modules/session/custom-claims*"
  - "apps/api/src/modules/session/**"
  - "packages/contract/src/custom-claims*"
  - "packages/contract/src/jwt-template*"
---

# JWT templates and custom claims

Moved here from `AGENTS.md`, word for word, and canonical for this area: `AGENTS.md` lists
this file under "Area rules" and does not repeat it. A section named in a sentence as
"above" or "below" is found through that list.

## JWT templates and custom claims (`modules/session/custom-claims.ts`, see ADR 0036)

A **JWT template** is a named set of **custom claims** in an environment's settings
(`sessions.jwtTemplates`); a session profile names the one its sessions use (`jwtTemplate`).

- **Custom claims live under the one namespace claim `ext`** (`CUSTOM_CLAIMS_CLAIM` in
  `@tula-tech/contract/custom-claims`, a Zod-free entry point). Never put a template's claim at the
  top level of a token, and never add a second namespace.
- **A claim Tula sets is reserved, inside `ext` too** (`RESERVED_CLAIM_NAMES`). A new
  top-level claim of the access token is added to that list in the same change: the test "the
  claims a server sets are all reserved" signs a real token and fails otherwise. `cnf` stays
  reserved for device binding.
- **A claim's source is a closed list of things the server knows** (`JWT_TEMPLATE_SOURCES`:
  the user's normalised address, whether it is verified, two times, the client kind) **or an
  operator's constant**. Never a value from a request (a header, a body, the IP address, the
  user agent), never a name or other text a user chose besides their own address, never a
  secret, and no expression, concatenation or nesting. A new source is added to the list, to
  `SOURCE_MAX_BYTES` with a true upper bound of its JSON, and to the canary test ("nothing
  the request said").
- **The cap is `MAX_CUSTOM_CLAIMS_BYTES` (1,024), enforced twice.** At save a template is
  refused when its claims *could* exceed it (`jwtTemplateMaxBytes`, every source at its
  maximum). At build `CustomClaims.build` checks again and, over the cap, drops the **whole**
  namespace (of a template alone; beside a hook's stored claims, the template's part: see
  the `before_token` rule below) and logs the template's name and the byte count, never a
  value. Never truncate,
  never raise the cap for a feature: it is what keeps `tula_at` inside a browser's cookie
  limit (a test in `packages/nextjs/src/real-api.test.ts` measures it).
- **A template's claims are read at every issue and stored nowhere** (a hook's are stored on
  the session: "Hooks" above). `Sessions` builds them wherever it
  signs a token or answers for a stateful session, from the settings as configured now. A
  refresh uses the user row `rejectBanned` already loaded and **gains no read**; the other
  paths read the user only when `CustomClaims.needsUser(template)`. Keep the tests that count
  those reads.
- **No value means no key, and no claim means no `ext`.** Never `null`, never `{}`. A token
  of a profile without a template has exactly the claim set of before (a snapshot test).
- **The `before_token` hook's claims go through `CustomClaims.build`'s `extra`** (ADR 0035):
  the same namespace, key grammar, reserved names, scalar values and cap, and the hook's
  value wins a key the template also sets. **Over the cap at issue (a template saved, or an
  address grown, after the claims were stored) the hook's claims are issued and all of the
  template's are left out**, logged by environment, template name and byte counts: a
  template alone cannot exceed the cap, the two together can, and dropping the hook's
  claims would fail open for an application that reads a restriction as a present claim.
  Everything goes only when one source alone is over the cap. When the hook *answers*, not
  fitting beside the template is still its failure (`claims_too_large`). Never merge claims
  into a token by another path.
- **A reader treats a malformed `ext` as absent, whole** (`readCustomClaims`): not a plain
  object, a reserved or malformed key, a value that is not a scalar, over the cap.
  `@tula-tech/nextjs` sets `SessionClaims.ext` and `auth().customClaims` only from it, for a token
  and for the sealed `x-tula-auth` header alike.
- **A profile names a template that exists**: the session settings schema refuses a document
  whose profile names a missing template, which is also what refuses removing one in use.
  Reading is tolerant (`readStoredJwtTemplate`, `jwtTemplateOfProfile`): an unknown source is
  left out, an over-cap template and a dangling name mean no claims, never a failed read.
- **The audit entry and the `settings.updated` event name no template.** Every change under
  `sessions.jwtTemplates` is the one key `sessions.jwtTemplates`: a template's name is also a
  value in the document, a claim's key says what an application authorizes on, and a
  constant is the operator's value. The event-canary test holds it; never weaken that test.
- **Taking a claim away from a profile's sessions, or redefining one, is a weakening**
  (`settingsWeakenings`: `sessions.profiles.<name>.jwtTemplate`), shared by the audit entry,
  the dashboard's confirmation and `tula apply --yes`.

## What to test

The failure paths a change here is held to (moved from the checklist of `security.md`; the
rules themselves are above and are not repeated).

- **At save:** every reserved name and every malformed key refused, with the field's path;
  each cap one over (templates, claims, key length, constant length, bytes at the sources'
  maxima); a profile naming a missing template; removing a template in use.
- **At issue:** a token of a profile without a template has exactly the old claim set; a
  template with no value for a user adds no `ext`; nothing a request said (IP address, user
  agent) and no name reaches a claim (canary); a template changed between sign-in and
  refresh; another environment's template never applied; a stale settings cache on another
  instance; a stored document with an unknown source or a dangling name still signs in; over
  the cap at build logs no value; a stateful session's answer carries the same claims; a
  refresh reads the user once.
- **A reader:** a forged or malformed `ext` (not an object, an array, a reserved key, a
  nested value, over the cap) is absent, in a token and in the sealed header, with and
  without the middleware.
- **The record:** neither a template's name, a claim's key nor a constant appears in an audit
  entry or an event's payload.
