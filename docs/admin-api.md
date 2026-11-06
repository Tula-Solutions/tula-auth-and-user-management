# Calling the admin API

The admin API (`/v1/admin/*`) is how your server manages an environment: its users,
sessions, settings, OAuth providers, webhooks and audit log. Every guide shows its calls in
cURL, TypeScript and Python, and all of them start from the setup on this page.

## The secret key

Each environment has its own secret keys (`tula_sk_<env>_…`). Create one in the dashboard
under **API keys**; on a local stack, `tula dev` writes one to `.env.local`. Send it as a
bearer token:

```http
Authorization: Bearer tula_sk_…
```

A secret key can do anything in its environment. Keep it on your server: never in a browser,
a mobile app or a repository. A publishable key (`tula_pk_…`) is the one for apps, and the
admin API refuses it.

## Your first call

The samples read the server's address and the key from two environment variables:

```sh
export TULA_API_URL=https://auth.example.com
export TULA_SECRET_KEY=tula_sk_…
```

<!-- tabs -->
```sh
curl "$TULA_API_URL/v1/admin/users?size=10" \
  -H "Authorization: Bearer $TULA_SECRET_KEY"
```

<!-- snippet: examples/docs-snippets/admin-api.ts#first-call -->
```ts
import { createAdminClient } from '@tula-tech/admin'

// Server-side only: the secret key can do anything in its environment.
const admin = createAdminClient({
  baseUrl: process.env.TULA_API_URL ?? 'https://auth.example.com',
  secretKey: process.env.TULA_SECRET_KEY ?? '',
})

const { data: users } = await admin.call('listUsers', { query: { size: 10 } })
```
<!-- /snippet -->

<!-- snippet: examples/docs-snippets/python/admin_api.py#first-call -->
```python
import json
import os
import urllib.request

API_URL = os.environ["TULA_API_URL"]
SECRET_KEY = os.environ["TULA_SECRET_KEY"]  # server-side only

request = urllib.request.Request(
    f"{API_URL}/v1/admin/users?size=10",
    headers={"Authorization": f"Bearer {SECRET_KEY}"},
)
with urllib.request.urlopen(request) as response:
    users = json.load(response)
```
<!-- /snippet -->
<!-- /tabs -->

The TypeScript client is [`@tula-tech/admin`](reference/admin.md) (`bun add @tula-tech/admin@latest`):
every call is typed against the API, by its operation's name. The Python samples use only
the standard library, so they run anywhere Python 3 does.

## Errors

A refused call answers with an HTTP status and one JSON shape:

```json
{ "status": 422, "code": "password.too_short", "detail": "Password is too short." }
```

`code` is stable: branch on it, never on `detail`, which is for people. A field-level
refusal adds `errors`, one entry per field. The **Error codes** page, under
**Reference**, lists them all. In TypeScript, `isTulaAdminError(error)` narrows a caught error to this shape.

## Rate limits

A call over its limit is refused with `429` and `rate_limited`, and the `Retry-After` header
says how many seconds to wait. Retry after that, not before.
