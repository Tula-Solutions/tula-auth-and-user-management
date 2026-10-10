# Device binding

A refresh token is a bearer credential: whoever holds a copy can use it. A session that is
**bound to a device key** cannot be refreshed with the token alone. Every refresh must also
carry a proof signed by a private key the client presented when the sign-in started. A
refresh token copied off the device, out of a backup or out of a log, is then of no use
without the device.

This page covers what a client sends, what the server answers, what an operator sees, and
what binding does and does not show. The decisions are in
[ADR 0043](adr/0043-device-binding.md).

**What this is for today.** The server, the contract, the conformance scenarios and the
headless TypeScript client (`@tula/core`) with a **software** key. The native SDKs that keep
the key in the Secure Enclave or StrongBox arrive with later steps of
[Phase 2](plans/phase-2.md). A software key held by the same process that holds the refresh
token adds little against whoever can read that process: see
[what binding proves](#what-binding-proves-and-what-it-does-not).

## Who can bind a session

| Client | Bound? |
| --- | --- |
| A client that is not a browser (`x-tula-client` other than `web`) with a `hybrid` session | Yes, when it sends a proof as it starts the sign-in. |
| The same client, sending no proof | No. The session behaves exactly as sessions always have. |
| A browser (`web`) | Never. A start that brings a proof is refused (`device.binding_not_supported`). |
| A `stateful` session (a cookie) | Never: it has no refresh. |
| A session that reaches the API through the Next.js route handler | Not in this version: the handler does not forward the proof, and a proof names the API's own address, not the app's. |

Binding is the client's choice and nothing switches it on per environment. There is no
setting that requires it yet.

A session is bound **when its sign-in starts, or never**. Nothing binds an existing session,
moves one to another key or takes a binding off; the database refuses the write. A client
that has lost its key signs in again.

## With `@tula/core`

Pass a key when the client is made. The client then proves it at every start and every
refresh, keeps the server's nonce, and repeats a request once when the server asks for a
fresh one.

```ts
import { createTulaClient, generateSoftwareDeviceKey } from '@tula/core'

const deviceKey = await generateSoftwareDeviceKey()
const tula = createTulaClient({
  publishableKey,
  baseUrl: 'https://auth.example.com', // the API's own public address: the proof names it
  client: 'ios',
  storage,
  deviceKey,
})
```

- A `deviceKey` is `{ publicJwk, sign(data) }`: a public P-256 key and a function that
  signs (ECDSA, SHA-256, the 64-byte `r` then `s` form) without handing the private half
  out. Back it with whatever your platform has. `generateSoftwareDeviceKey()` makes one
  with WebCrypto whose private half is not extractable; it lives in memory, so a client
  that wants its sessions to survive a restart must keep the key (IndexedDB stores a
  `CryptoKey` without exposing it) and pass the same one again.
- **The key must stay the same for as long as its sessions live.** A new key cannot refresh
  an old session.
- `baseUrl` must be the address the API knows itself by (`PUBLIC_URL`), not a proxy's under
  another name.
- A `web` client cannot be given a `deviceKey`: `createTulaClient` throws.
- A refresh that fails for its proof (`device.proof_invalid`, `device.nonce_required`) does
  **not** sign the client out. The tokens stay and the next refresh tries again. If the
  key's `sign` throws, the call fails with the client-side code `device.key_failed`; the
  error carries no `cause`, so log what your key store said inside your `sign`.
- The first refresh of a newly made client costs two requests (it has no nonce yet); after
  that, one.

## On the wire

For a client written without the SDK.

### The proof

One JWT per request, in the `DPoP` request header ([RFC 9449](https://www.rfc-editor.org/rfc/rfc9449)):

| Part | Value |
| --- | --- |
| header `typ` | `dpop+jwt` |
| header `alg` | `ES256`. Nothing else is accepted. |
| header `jwk` | The public key and nothing else: `kty: "EC"`, `crv: "P-256"`, `x`, `y`. A key with a `d`, a `kid` or any other member is refused. |
| `htm` | The request's method (`POST`). |
| `htu` | The API's public URL and the route's path, e.g. `https://auth.example.com/v1/client/sessions/refresh`, spelt as below. |
| `iat` | Now, in seconds. Within five minutes of the server's clock. |
| `jti` | A unique id, 16 to 128 characters of `A-Z a-z 0-9 - . _ ~` (a UUID, or 16 random bytes in base64url). A proof is accepted once. |
| `nonce` | The newest value of the `DPoP-Nonce` response header. |

Make a new proof for every request. The server compares `htu` with its own configured
address: it does not read `Host` or any forwarding header.

**`htu` has one spelling.** Build it by joining the API's public URL and the route's path,
and do not pass it through anything that rewrites it:

- `http` or `https`, `://`, the host, an optional `:port`, then the path. Printable ASCII
  only. A host may hold letters, digits, dots, hyphens and underscores, or be an IPv6
  address in brackets.
- The server ignores the case of the scheme and of the host, and a default port written
  out (`:443`, `:80`). The path is compared byte for byte.
- The server refuses an `htu` with a backslash, a `.` or `..` path segment, a percent
  sign, a query or a fragment (an empty `?` or `#` too), user info (`user@`), a space, a
  tab or a line break.

The server reads its own `PUBLIC_URL` with a URL parser and compares your `htu` with the
result as text. A client that has such a parser (as `@tula/core` does) passes the API's
URL through it once. A native SDK without one must write the address the same way itself:

- **The host as the server's `PUBLIC_URL` is written once lower-cased.** A host with
  letters outside ASCII in its `xn--` form. No dot added or removed at its end.
- **An IPv6 host compressed and in brackets**: `[::1]`, not `[0:0:0:0:0:0:0:1]`.
- **The port without leading zeros, and left out when it is the scheme's default** (443
  for `https`, 80 for `http`).
- **The path exactly as the route's**: the public URL's own path prefix, if it has one,
  with no slash at its end, then the route's path (`/v1/client/sessions/refresh`), with
  nothing added, encoded or removed.

Where a deployment's `PUBLIC_URL` cannot be written that way at all (its path holds a
space or a letter outside ASCII), device binding is unavailable on it: every start that
brings a proof answers `device.binding_not_supported`, and the server says so in its log
when it starts.

### Starting a sign-in

Send the proof on the request that starts the attempt: `POST /v1/client/sign-ups`,
`/sign-ins`, `/password-resets`, `/sign-ins/passkey` or `/sign-ins/oauth`. No later step
reads it.

1. The first start has no nonce. The answer is `400 device.nonce_required` with a nonce in
   `DPoP-Nonce`, and nothing was started.
2. Repeat the start with a new proof that carries the nonce. The attempt starts, and the
   answer carries the next nonce.
3. Complete the attempt as usual. The session it ends in is bound: its access token has
   `cnf: { "jkt": "<the key's RFC 7638 thumbprint>" }`, and the completing answer carries a
   nonce for the first refresh.

A start whose proof is not valid is refused (`401 device.proof_invalid`); it is never
started unbound.

### Refreshing

`POST /v1/client/sessions/refresh` with the refresh token as before **and** a proof. Every
successful answer has a `DPoP-Nonce` for the next one. A nonce is good for five to ten
minutes.

| Answer | Means | Do |
| --- | --- | --- |
| `200` | Rotated (or, inside the grace window, the same next token again). | Keep the new tokens and the nonce. |
| `400 device.nonce_required` | The proof was good but its nonce is missing or too old. Nothing changed. | Make a new proof with the `DPoP-Nonce` of this answer and send the same refresh token again. |
| `401 device.proof_invalid` | No proof, not a valid one for this request, one by another key, or one already used. **The session is not ended and the token was not used up.** | Fix the proof and send the same refresh token again. Do not sign the user out. |
| `429 rate_limited` | More than ten refused proofs for this session in a minute. | Wait for `Retry-After`. |
| `503 service.unavailable` | The server could not check whether the proof was used before. | Try again; the same token works. |
| `401 session.*` | The session is over, as for any session. | Sign in again. |

**Signing out needs no proof.** `POST /v1/client/sessions/sign-out` ends a bound session
with its refresh token alone, so that a client which has lost its key can still sign out.
It follows that someone holding a copied refresh token can sign the owner out; they cannot
refresh, and the token they copied dies with the session.

The grace window ([sessions](methods/sessions.md)) needs a proof too: a refresh token that
was just rotated gets the same next token again only with a proof by the session's key.

### Errors

| Code | Status | When |
| --- | --- | --- |
| `device.proof_invalid` | 401 | A start or a refresh whose proof is missing (refresh of a bound session), malformed, for another request, by another key, or used before. |
| `device.nonce_required` | 400 | A valid proof (at a refresh: by the session's key) without a current nonce. The answer has `DPoP-Nonce`. The nonce is a freshness value, not a secret: every client of the environment is given the same one. |
| `device.binding_not_supported` | 400 | A proof from a browser, or sent to a deployment whose `PUBLIC_URL` no proof can name (a space or a letter outside ASCII in its path; the server warns at boot). Nothing started. |

## What an operator sees

- **`session.created`** carries `deviceBound: true` for a bound session, in the audit log
  and in the event. Nothing of the key.
- **`session.refresh_proof_refused`**: a refresh of a bound session came without a valid
  proof. At most one entry a minute per session, with `reason` (`missing`, `invalid`,
  `wrong_key`, `replayed`) and `suppressedInPreviousMinute`, how many more refusals the
  minute before had (at least that many). The session was not ended. Subscribe a
  [webhook](webhooks.md) to it to learn of one as it happens: outside development, it means
  a refresh token is being used somewhere its key is not.
- **The owner is not emailed** about a refused proof in this version.
- The access token's `cnf.jkt`. The API itself asks for no proof with an access token; the
  claim is there for a backend of yours that wants to.

Nothing is stored of a device beyond the thumbprint on its session's row, and it goes when
the session's row goes. There is no list of devices.

## Redis

The ids of used proofs are remembered in Redis for up to ten minutes, so that a proof one
instance accepted is refused by all. When Redis cannot be reached, a bound session's refresh
is answered `503` (the session is not ended) while an unbound session's refresh keeps
working. Without Redis the ids are remembered per process, which is right for one instance
only; `tula doctor`'s `redis` check says so.

## What binding proves, and what it does not

It shows that whoever refreshed the session could, at that moment, make the key that
started the sign-in sign a value the server had just chosen. With a hardware key that
cannot be exported, that is the same device.

It does not show:

- **what kind of key it is.** The server sees a public key and cannot tell hardware from a
  key in a file. There is no attestation.
- **who holds the device.** Malware on the device, or someone with the unlocked phone, can
  ask the key to sign.
- **anything about access tokens.** They are bearer tokens for their lifetime (60 seconds
  by default).
- **that the sign-in was the user's.** Someone who signs in with a stolen password binds
  the session to their own key. Binding protects a session, not an account.

**A device does not outlive its session.** When the session ends, the binding ends with it.
The key earns nothing at the next sign-in: no skipped factor, no "trusted device".

## Troubleshooting

- **Every start answers `device.nonce_required`.** The repeat must carry the nonce from the
  answer's `DPoP-Nonce` header and be a new proof. From a browser-like runtime, the header
  is readable only because the API exposes it through CORS; a proxy that strips response
  headers breaks this.
- **`device.proof_invalid` on a proof that looks right.** Most often `htu`: it must be
  `PUBLIC_URL` plus the path exactly, not the address of a proxy or a load balancer under
  another name, in the one spelling the table above describes (no query, no percent sign,
  no `..`). Then the clock (`iat` within five minutes), then a
  `jwk` with extra members. The server's log line names which check failed with one fixed
  word (`address`, `issued_at`, `key`, …); the answer never does.
- **`device.proof_invalid` after an app restart.** The key was not kept, and a new one was
  made. The session cannot be refreshed; sign in again, and persist the key.
