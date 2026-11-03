# ADR 0067: Enterprise single sign-on

Status: accepted (Phase 4, [plan](../plans/phase-4.md)). This ADR covers the decisions of
TULA-135: the SAML library and the response verifier. Later tickets of the phase add their
own sections.

## Context

Phase 4 lets an organization ([ADR 0065](0065-organizations.md)) connect its identity
provider. OIDC reuses the OAuth machinery. SAML needs an XML signature check, the part of the
protocol with the longest history of bypasses (signature wrapping, comment injection in a
`NameID`, a key taken from the document itself).

## Decision

### Library: `xml-crypto` and `@xmldom/xmldom`, used directly

| Option | Verdict |
| --- | --- |
| `@node-saml/node-saml` | Maintained and complete, but it decides audience, time and `InResponseTo` itself with options that default loose, and it has had signature CVEs of its own (CVE-2025-54419, fixed in 5.1.0; quoted from memory, check before relying on it). Tula must own those decisions, so it would be wrapped and re-checked anyway. |
| `samlify` | Smaller maintenance, a signature-verification CVE in 2025 (CVE-2025-47949, from memory), and a template-based API that hides what was signed. Rejected. |
| `xml-crypto` + `@xmldom/xmldom` directly | Chosen. Both are pure JavaScript and run on Bun (tested here). The CVEs of `xml-crypto` (CVE-2024-32962, a key taken from `KeyInfo`, fixed in 6.0.0; CVE-2025-29774 and CVE-2025-29775, fixed in 6.0.1; from memory) are the very bugs the verifier's rules close, and it uses version 6.4.0. `@xmldom/xmldom` 0.9.x is past its parsing CVEs (CVE-2021-21366, CVE-2021-32796, CVE-2022-39353). |

The library does two things only: parse and check one signature. Every decision about what
was signed, for whom and for when is Tula's, in `apps/api/src/lib/saml-verifier.ts`, the one
place a SAML response is accepted.

### Verifier policy

- SP-initiated, POST binding, unencrypted assertions only. An unsolicited response (no
  request id) and IdP-initiated sign-in are refused (`unsolicited`).
- A DOCTYPE or entity is `forbidden_xml`; the response is size-capped before decoding.
- Exactly one `Assertion`, a direct child of the `Response`, carrying its own signature
  (`assertion_unsigned` when only the response is signed). The signature's reference must be
  `#<that assertion's ID>`; algorithms are an allow-list (RSA-SHA2 family, no SHA-1).
- The key is only ever one of the connection's configured certificates (any of them, so a
  rollover works); `KeyInfo` is never trusted (`certificate_not_configured`).
- The assertion is read **only from the canonical XML the signature covers**. A `NameID` is
  one plain text node in the document as sent too, because canonicalisation drops comments
  (`name_id_invalid`).
- Issuer, `Destination`, `Recipient`, audience, `InResponseTo` and status are compared by
  Tula, each with its own refusal code; times allow 2 minutes of skew
  (`SAML_CLOCK_SKEW_MS`) and read `deps.clock`.
- Replay uses the existing `ProofReplayGuard` port (memory and Redis), last, so that a forged
  response burns no assertion id; the guard fails closed.

### The mock signer

`adapters/oauth/mock-saml.ts` builds signed and deliberately wrong responses with published
throwaway test keys (`mock-saml-keys.ts`). It throws unless `OAUTH_MOCK_PROVIDER` is on
(which `env.ts` already limits to the `local` tier and a loopback `PUBLIC_URL`), and a test
fails if any file outside tests imports it.

### Replacing the library

Only `saml-verifier.ts` imports the two packages. A replacement keeps `verify`'s signature
and passes the same table of refusals.

## SAML connections (TULA-139)

- A SAML connection is a row of the same table with a `saml` JSON column (entity id, SSO URL, metadata
  URL, up to two certificates each with its own `notAfter`). Metadata is read, not trusted: a DTD or
  entity is refused, only signing keys are taken, and its own signature is **not** verified (the operator
  chose where it comes from; every response is still verified against the stored certificates). A
  metadata URL goes through `Outbound.request`.
- The ACS accepts only a response to an AuthnRequest this server made (the request id is held in the
  attempt's state); `RelayState` is the flow state. `verify` in `lib/saml-verifier.ts` is the only
  acceptor; its replay guard (`proofReplay`) is the shared port, so two instances share it.
- Every failure is one `sso.provider_error` to the browser and the fixed reason in the log.
- SP metadata is public per connection and built by `buildSpMetadata`; the SP entity id is its URL.

## Test sign-in and activation (TULA-145)

- A test round is a flow attempt of kind `sign_in` marked by `state.ssoTest`, with a secret nobody
  holds; it needed no new flow kind. The callback stops before `finish()`: no session, user, identity
  or membership is created, and no assertion or token is kept in the result.
- This is the one place a refusal reason is shown. Each verifier failure maps to a contract reason
  code (`SSO_TEST_REASONS`) and a sentence for the person setting the connection up; a real sign-in
  still says only `sso.provider_error`.
- The connection stores `testedFingerprint`, a SHA-256 of the settings a sign-in depends on. `tested`
  is true only while it matches, so any such change needs a new test. Activation without it is
  `sso.test_required` (409).
- A SAML SSO URL and an OIDC authorization endpoint are https, `http` only in the `local` tier
  (`sso.url_not_https` on save; `discovery_failed` when discovery names one).

## Amendments

- [ADR 0065](0065-organizations.md): an organization may own SSO connections (the tickets
  after this one add the tables).
- [ADR 0012](0012-events-and-audit-log.md): SSO activity types are added with their contract
  schemas, as any new type.
- [ADR 0019](0019-flow-engine-v2.md): an external sign-in completes through the flow engine's
  shared completion path (TULA-136).
- [ADR 0050](0050-native-type-generation.md): native types will be generated for the SSO
  operations once their routes exist.
