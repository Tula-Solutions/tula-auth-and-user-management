# @tula/admin

A typed client for the admin API of [Tula Auth](../../README.md) (`/v1/admin/*`): settings,
OAuth providers, users, sessions, API keys, signing keys, webhook endpoints and the audit log;
and `verifyWebhook`, for the server that receives Tula's webhooks. Its types are
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
  `client.invalid_param`, and `webhook.*` from `verifyWebhook`);
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

## Receiving webhooks

`verifyWebhook(body, headers, secret)` checks a delivery Tula made to your endpoint and
returns its event, typed. It needs no client and no secret key: only the endpoint's signing
secret (`whsec_…`), which the registration returned once.

<!-- snippet: examples/docs-snippets/admin.ts#webhook-verify -->
```ts
// The route your endpoint's address leads to, on any server that gives you a `Request`.
export async function receiveWebhook(request: Request): Promise<Response> {
  let event: TulaWebhookEvent
  try {
    // The body exactly as it arrived: the signature is over these bytes.
    event = await verifyWebhook(await request.text(), request.headers, webhookSecret)
  } catch (error) {
    // Not from Tula, changed on the way, or older than five minutes.
    return new Response(null, { status: isTulaAdminError(error) ? 400 : 500 })
  }
  // A test event an administrator sent: an example, nothing in it happened.
  // And delivery is at least once: the same event id can arrive again.
  if (event.test || (await alreadyHandled(event.id))) {
    return new Response(null, { status: 204 })
  }
  switch (event.type) {
    case 'user.created':
      await provisionWorkspace(event.target.id)
      break
    case 'session.reuse_detected':
      await alertSecurity(event.data.userId)
      break
    default:
    // A type this code does not handle, or one a later server added: nothing to do.
  }
  // Answer quickly, with a 2xx and a small body. Anything else is a failed request, which
  // the server retries.
  return new Response(null, { status: 204 })
}
```
<!-- /snippet -->

- **The raw body.** Pass the text or bytes as they arrived, never an object your framework
  parsed: the signature is over the bytes.
- **What it refuses**, each with its own `code` on a `TulaAdminError`: a secret that is not
  one (`webhook.invalid_secret`); a missing or malformed header, or a `webhook-id` or
  `webhook-timestamp` sent twice (`webhook.invalid_headers`; a `webhook-signature` sent twice
  is read as one list, as the Standard Webhooks reference library reads it); a timestamp more than five minutes old or ahead
  (`webhook.timestamp_out_of_tolerance`); no matching signature
  (`webhook.invalid_signature`, compared in constant time; any one of several signatures in
  the header is enough); a correctly signed body that is not the event the delivery names
  (`webhook.invalid_payload`). No error contains the secret, a signature or the body.
- **At least once.** The same event can arrive twice, with the same `id`: keep the ids you
  have handled.
- **A later server may send a type this version does not list.** It is returned, not
  refused: handle the types you know and ignore the rest.

The scheme is [Standard Webhooks](https://www.standardwebhooks.com/), so a backend in another
language can use any library for it. More in [docs/webhooks.md](../../docs/webhooks.md).

After the API changes: `bun run contract:generate`, then `bun run admin:generate`.
