# @tula-tech/contract

The public contract of [Tula Auth](../../README.md): the Zod schemas of every request and
response, the flow protocol (the steps a server answers a sign-up, a sign-in or a reset with),
the error codes, the token claims, the password policy, and the OpenAPI document they are
published as. The API validates with it and every Tula SDK is generated from it or tested
against it, so it is the one place the protocol is written down.

```sh
bun add @tula-tech/contract@latest    # or: npm install @tula-tech/contract@latest
```

> **Early release (0.x).** The protocol may change from one release to the next, and every `@tula-tech/*` package of a release shares one version, so install them at
> the same one. Everything else is in the
> [repository](https://github.com/Tula-Solutions/tula-auth-and-user-management#readme).

Most applications never import it: `@tula-tech/react`, `@tula-tech/nextjs` and `@tula-tech/core` are what an
app is built on, and they bring it. Import it yourself to check a payload against the
protocol, or for a constant an SDK does not re-export:

```ts
import { ERROR_CODES } from '@tula-tech/contract/error-codes'
import { FlowStepSchema } from '@tula-tech/contract'

const step = FlowStepSchema.parse(await response.json())
```

## Entry points

| Import | What |
| --- | --- |
| `@tula-tech/contract` | Everything, the Zod schemas included. It depends on Zod 4. |
| `@tula-tech/contract/error-codes`, `/event-types`, `/headers`, `/issuer`, `/password-rules`, `/redirect-url`, `/theme`, `/webhook-signature`, `/custom-claims`, `/device-binding` | The constants and pure functions an SDK needs at run time. None of them imports Zod, so none pulls it into an application's bundle. |
| `@tula-tech/contract/openapi.json` | The OpenAPI document of the API this version describes. |

The reference of every export is [docs/reference/contract.md](../../docs/reference/contract.md).
Under a strict Content-Security-Policy (no `'unsafe-eval'`), see
[docs/releasing.md](../../docs/releasing.md#tula-techcontract-under-a-strict-content-security-policy).

## What it holds

| Area | What is in it |
| --- | --- |
| Flow protocol | `FlowStepSchema` and the schemas of the steps a server answers a sign-up, a sign-in or a reset with (`needs_password`, `needs_first_factor`, `needs_email_verification`, `needs_new_password`, `needs_second_factor`, `needs_factor_enrolment`, `complete`). The API never says which screen to draw; a client reads the step. |
| Errors | `ERROR_CODES`, `ERROR_DEFINITIONS` and `errorDefinition(code)`: every stable, dot-namespaced code (`password.too_short`) with its status. The envelope an error is answered with is a schema too. |
| Passwords | `evaluatePassword(policy, password, userInfo)` and the policy presets: the same rules the server applies, so a form can show them before a request is made. |
| Sessions and tokens | The session profile, the token claims, `environmentIssuer(apiUrl, environmentId)` and `jwksUrl(issuer)`, which tell a verifier where an environment's keys are published. |
| Settings | The schema of an environment's settings, OAuth providers, hooks, native apps, JWT templates, email and SMS templates and organization roles. `@tula-tech/config` validates a config file with it. |
| Events | `ACTIVITY_TYPES` and the webhook signature constants (the `webhook-id`, `webhook-timestamp` and `webhook-signature` headers, `WEBHOOK_TOLERANCE_SECONDS`), for a receiver that checks a delivery. |
| Headers | `PUBLISHABLE_KEY_HEADER` (`x-tula-publishable-key`), `CLIENT_HEADER` (`x-tula-client`) and the attempt header a flow call carries. |
| Redirect URLs | `isRedirectUrl`, `redirectUrlKind` and the rules for a custom-scheme redirect, shared by the server and the SDKs. |
| Theme | The default theme tokens the React SDK's stylesheet and the native SDKs are generated from (`@tula-tech/contract/theme`). |

## Examples

Check a password against a policy before a form is submitted:

```ts
import { PASSWORD_POLICY_PRESETS } from '@tula-tech/contract'
import { evaluatePassword } from '@tula-tech/contract/password-rules'

const { ok, checks } = evaluatePassword(PASSWORD_POLICY_PRESETS.recommended, 'correct horse')
if (!ok) {
  for (const check of checks.filter((c) => !c.passed)) {
    console.log(check.rule)
  }
}
```

Find where an environment publishes its signing keys, to verify an access token offline:

```ts
import { environmentIssuer, jwksUrl } from '@tula-tech/contract/issuer'

const issuer = environmentIssuer('https://auth.example.com', environmentId)
const keys = jwksUrl(issuer) // <issuer>/.well-known/jwks.json
```

Look up what an error code means without importing Zod:

```ts
import { ERROR_CODES, errorDefinition } from '@tula-tech/contract/error-codes'

if ((ERROR_CODES as readonly string[]).includes(body.code)) {
  const { status } = errorDefinition(body.code)
}
```

## Using the OpenAPI document

`@tula-tech/contract/openapi.json` is the document the API publishes at `/v1/openapi.json`,
committed with every release. It is what `@tula-tech/core` and `@tula-tech/admin` generate
their types from, so a generator of your own (another language, a test double) can start from
the same file:

```ts
import openapi from '@tula-tech/contract/openapi.json' with { type: 'json' }

console.log(Object.keys(openapi.paths).length)
```

## Compatibility

- **ESM only**, with type declarations. The package has no side effects, so a bundler can drop
  what you do not import.
- It runs in browsers, Node, Bun and edge runtimes: it uses no Node-only API.
- The root entry point depends on **Zod 4**. The subpath entry points listed above import no
  Zod, so a browser bundle that needs only a constant or a pure function does not carry it.
- Zod's JIT code generation uses `new Function`. Where a strict Content-Security-Policy
  forbids `'unsafe-eval'`, follow
  [the note in docs/releasing.md](../../docs/releasing.md#tula-techcontract-under-a-strict-content-security-policy).

## Stability and versions

- Every `@tula-tech/*` package of one release shares a version. Install this package at the
  same version as the SDK that uses it (`@tula-tech/core`, `@tula-tech/react`,
  `@tula-tech/nextjs`), or let that SDK bring it.
- A change to a route, a response or an error code is a change to this package, and the
  OpenAPI document in it is regenerated with the API. While the version is `0.x`, read the
  [changelog](https://github.com/Tula-Solutions/tula-auth-and-user-management/releases)
  before you upgrade.
- Match on an error's `code`, not on its `detail` sentence, which is for people.

## Security notes

- The schemas describe what a server and a client may send; they do not authenticate anything.
  Validating a payload with them is not a substitute for verifying a token or a webhook
  signature.
- Nothing in this package holds a secret. Secret keys (`tula_sk_…`) belong to the server
  side only and are the concern of `@tula-tech/admin`.

## Related packages

| Package | What |
| --- | --- |
| [`@tula-tech/core`](../core/README.md) | The headless client: flows, the session, single-flight refresh. |
| [`@tula-tech/react`](../react/README.md) | Provider, hooks and prebuilt components. |
| [`@tula-tech/nextjs`](../nextjs/README.md) | The Next.js App Router SDK. |
| [`@tula-tech/admin`](../admin/README.md) | The typed client for `/v1/admin/*`. Server-side only. |
| [`@tula-tech/config`](../config/README.md) | `defineConfig()` for `tula.config.ts`. |

The flow protocol is explained in [ADR 0019](../../docs/adr/0019-flow-engine-v2.md); the decisions
behind the rest are indexed in the [ADR README](../../docs/adr/README.md). Licensed under Apache-2.0.
