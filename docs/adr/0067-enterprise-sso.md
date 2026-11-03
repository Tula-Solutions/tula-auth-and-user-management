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

## Attribute mapping and groups mapped to roles (TULA-144)

- **Attributes.** A connection's `attributeMapping` names the attribute (SAML) or claim (OIDC) that
  carries the email, first name, last name and groups. Left out, the preset of its `idp` (`okta`,
  `entra`, `google_workspace`, `jumpcloud`, `onelogin`, `ping`, `generic`) applies, per protocol
  (`SSO_ATTRIBUTE_DEFAULTS` in the contract); one named field replaces that field's names only.
- **Groups to roles are held per organization**, not per connection (`organization_group_roles`), so
  that SCIM Groups (TULA-150) read the same mapping. The admin routes are
  `GET|PUT /v1/admin/sso-connections/:id/group-roles`; a save replaces the whole list, refuses a role
  that does not exist (`organization.role_unknown`) and a group named twice.
- **Precedence: the saved order.** A user in several mapped groups gets the role of the first mapped
  group, in the order the list was saved, that is among their groups. A user in none of the mapped
  groups gets the connection's `defaultRole`. An organization with no mapping at all leaves a member's
  role alone (the default role is given only when the membership is created).
- **The role is set at every sign-in**, through the organization service (`changeMemberRole`), so the
  last-manager rule holds: a demotion of the only manager is refused, the sign-in still succeeds with
  the old role, and a warning with the fixed reason (`organization.last_manager`) is logged.
- **A group name is directory data.** It lives in the attempt state until the ticket is exchanged and
  in the mapping table; it is never in an audit entry, an event payload or a log line. Saving the
  mapping is the existing `sso_connection.updated` event with `changed: ['groupRoles']`, which says
  that it changed and not what it holds. At most 200 values of 256 characters are read from a profile.

## SCIM (TULA-143)

An organization's directory provisions users through `/v1/scim/v2`, behind a SCIM token
(`tula_scim_<environment>_…`, stored as a SHA-256 hash, shown once). The token is accepted by
that middleware and refused by `secretKey()` and `agentKey()`. The routes have no OpenAPI
description on purpose: no SDK or dashboard is generated from them. They answer RFC 7644 error
documents. Ownership is a column, `users.managed_by_directory_id`: only a user the directory
created, and who has no other membership, is banned or deleted by it; anyone else only loses
the membership. Membership changes go through the Organizations service, so the last-manager
rule of ADR 0065 holds and answers 409. The actor of an audit entry is `directory`. Limits:
names and emails are not updated by SCIM, groups and bulk are not supported, and a create is not
one transaction. Usage is in [docs/scim.md](../scim.md).

## Amendments

- [ADR 0065](0065-organizations.md): an organization may own SSO connections (the tickets
  after this one add the tables).
- [ADR 0012](0012-events-and-audit-log.md): SSO activity types are added with their contract
  schemas, as any new type.
- [ADR 0019](0019-flow-engine-v2.md): an external sign-in completes through the flow engine's
  shared completion path (TULA-136).
- [ADR 0050](0050-native-type-generation.md): native types will be generated for the SSO
  operations once their routes exist.

## Enforced connections, the break-glass role and MFA trust (TULA-140)

- **Enforcement is by domain.** An active connection with `enforced: true` removes every
  other first factor for the addresses of its verified domains: the start offers only `sso`
  (the attempt's state keeps the full list so that a disabled strategy is still
  `flow.invalid_step`), and each other first factor's own route (password, emailed code and
  link, passkey, provider callback, texted code) refuses through `Sso.requireNotEnforced` with
  `auth.method_disabled`. An unknown address on an enforced domain gets the same answer as
  a known one. A texted code is judged by the holder's address, not by the phone number.
- **Break-glass.** `breakGlassRole` names an organization role. A member of the connection's
  organization holding that role may sign in with a **password**, and with nothing else.
  **The rule: an answer that depends on who the address belongs to must not differ between
  members and non-members.** So the password step never says `auth.method_disabled`: for an
  enforced domain it runs the same (dummy or real) verify and answers `auth.invalid_credentials`
  (`Sso.refuses`) for an unknown address, a non-member and a member with a wrong password
  alike; only a member with the right password signs in. Every other first factor refuses
  `auth.method_disabled` whoever asks, because break-glass does not cover it, so that answer
  is a fact about the domain. The check is at the route, not at the start, so the start never
  reveals membership either.
- **MFA trust.** With `trustIdpMfa: true` an SSO sign-in records `amr` `sso` and `mfa` and
  requires no further factor, also under `mfa.policy: required`. Off, it stops at
  `needs_second_factor` or `needs_factor_enrolment` like any first factor.
- **Weakenings.** Switching enforcement off, turning on `trustIdpMfa` and setting a
  break-glass role are weakenings (`weakens` in `modules/sso-connection/service.ts`): the
  connection-update audit entry says `weakened: true`. Connections are not in `tula apply`
  (only `settings.sso.enabled` is), so the classification lives on that entry; the
  dashboard screen arrives with TULA-146.
