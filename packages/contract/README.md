# @tula-tech/contract

The public contract of [Tula Auth](../../README.md): the Zod schemas of every request and
response, the flow protocol (the steps a server answers a sign-up, a sign-in or a reset with),
the error codes, the token claims, the password policy, and the OpenAPI document they are
published as. The API validates with it and every Tula SDK is generated from it or tested
against it, so it is the one place the protocol is written down.

```sh
bun add @tula-tech/contract@latest    # or: npm install @tula-tech/contract@latest
```

> **Early release (0.x).** the protocol may change from one release to the next, and every `@tula-tech/*` package of a release shares one version, so install them at
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
