---
'@tula/contract': minor
'@tula/core': minor
'@tula/admin': minor
---

Device binding on refresh ([docs/device-binding.md](../docs/device-binding.md), ADR 0043): a
session of a client that is not a browser can be bound, when its sign-in starts, to a key
the client holds. Every refresh of such a session then needs a DPoP proof (RFC 9449) signed
by that key. A refresh without one is refused and changes nothing: the session is not ended
and no token is rotated. A session that is not bound behaves as before.

- `@tula/contract`: a new Zod-free entry point, `@tula/contract/device-binding`
  (`DPOP_HEADER`, `DPOP_NONCE_HEADER`, `DPOP_PROOF_TYPE`, `DPOP_ALGORITHMS`,
  `MAX_DPOP_PROOF_LENGTH`, `DeviceKey`, `DevicePublicJwk`, `createDpopProof`,
  `jwkThumbprint`, `isDevicePublicJwk`, `isKeyThumbprint`, `generateSoftwareDeviceKey`);
  the error codes `device.proof_invalid` (401), `device.nonce_required` (400) and
  `device.binding_not_supported` (400); the optional `cnf: { jkt }` on
  `AccessTokenClaimsSchema`; the event type `session.refresh_proof_refused`; and the
  optional `deviceBound` on `session.created`.
- `@tula/core`: `createTulaClient({ deviceKey })` binds the client's sessions. The client
  sends a proof when it starts a sign-up, a sign-in or a reset and at every refresh, keeps
  the server's nonce and repeats a request once when asked for a fresh one, inside the same
  deadline. A refresh refused for its proof does not sign the client out. `DeviceKey`,
  `DevicePublicJwk` and `generateSoftwareDeviceKey` are exported; a key whose `sign` throws
  is the client-side code `device.key_failed`. A `web` client cannot be given a key.
- `@tula/admin`: the generated types carry the new event type, `deviceBound` and `cnf`.
