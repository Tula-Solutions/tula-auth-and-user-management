# @tula/admin

A typed client for the admin API of [Tula Auth](../../README.md) (`/v1/admin/*`): settings,
OAuth providers, users, sessions, API keys, signing keys and the audit log. Its types are
generated from the OpenAPI contract, so it cannot drift from the API it calls. It is what the
`tula` CLI talks through, and what the dashboard and the MCP server will.

> Not published yet. Inside this repository, depend on it with `"@tula/admin": "workspace:*"`.

**Server-side only.** It holds a secret key, which can do anything in its environment. The
client refuses a publishable key, refuses to be created where `window` and `document` exist,
and the package's `browser` export condition resolves to a module that throws, so a bundle for
a web page fails instead of shipping the key.

```ts
import { createAdminClient, ifMatch, isTulaAdminError } from '@tula/admin'

const admin = createAdminClient({
  baseUrl: 'https://auth.example.com',
  secretKey: process.env.TULA_SECRET_KEY ?? '',
})

const { data } = await admin.call('getEnvironmentSettings')
try {
  await admin.call('replaceEnvironmentSettings', {
    headers: { 'If-Match': ifMatch(data.revision) },
    body: { ...data.settings, mfa: { policy: 'required' } },
  })
} catch (error) {
  if (isTulaAdminError(error) && error.code === 'precondition.failed') {
    // Someone else changed the settings since they were read: read them again.
  }
}
```

- **One function.** `admin.call(operationId, input)`: the operation ids are the OpenAPI
  document's (`listUsers`, `updateOAuthProvider`, …), and `input` is typed per operation:
  `params`, `query`, `headers` and `body`, each required exactly when the operation needs it.
  The answer is `{ data, status, etag }`.
- **One error.** Every failure throws `TulaAdminError`: `code` is a contract code
  (`validation.failed`, `precondition.failed`, `rate_limited`, …) or one of the client's own
  (`network.failed`, `network.timeout`, `network.aborted`, `response.invalid`,
  `client.invalid_key`, `client.publishable_key`, `client.invalid_url`, `client.browser`,
  `client.invalid_param`);
  `errors` lists each refused field with its path; `retryAfterMs` carries `Retry-After`. The
  client never retries.
- **The key stays put.** It lives in a closure: it is not a property of the client and is in
  no error, log line or `JSON.stringify`. It is sent to `baseUrl` only; redirects are not
  followed.
- **https, unless it is this machine.** A plain `http:` `baseUrl` is refused
  (`client.invalid_url`, nothing sent) except for `localhost`, `*.localhost`, `127.0.0.1` and
  `[::1]`: over http the key crosses the network in clear text. `allowInsecureHttp: true`
  lifts that for a private network you trust.
- **A path parameter is one path segment.** Empty, `.`, `..`, or a value with a slash, a
  backslash or a control character is refused before any request (`client.invalid_param`,
  naming the parameter, not its value): `..` would otherwise be resolved into another route.
- **No dependencies at run time** beyond the contract's Zod-free entry points; web platform
  APIs only (Node, Bun, Deno, edge workers).

After the API changes: `bun run contract:generate`, then `bun run admin:generate`.
