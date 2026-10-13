---
paths:
  - "apps/api/src/modules/audit/**"
  - "apps/api/src/ports/**"
  - "apps/api/src/adapters/**"
  - "apps/api/src/lib/event-payload*"
  - "apps/api/src/event-canary.test.ts"
  - "packages/contract/src/event*"
---

# Events and the audit log

Moved here from `AGENTS.md`, word for word, and canonical for this area: `AGENTS.md` lists
this file under "Area rules" and does not repeat it. A section named in a sentence as
"above" or "below" is found through that list.

## Security rules (non-negotiable)

- **An event's payload is a public contract and an allow-list** (ADR 0012). Every activity
  type has, in `@tula-tech/contract`, a name and a target type (`event-types.ts`, Zod-free), a
  `data` schema (`EVENT_DATA_SCHEMAS` in `events.ts`) and an example (`EVENT_FIXTURES`); a
  type missing one of the three does not compile and fails the contract's tests. **A new
  activity type is those three things, added together.** `Audit.entry` checks each call
  site's `target` and `data` against them at compile time: a detail the contract has no
  field for is added to the schema first, as a decision, never passed along. A `data` field
  is an id the server made, a value from a closed set (an enum, not a string), a boolean or a
  number; never an email address, a name, an IP address, a user agent, a token, a code, a
  hash or key material, and never a free-form string. The two string fields that are not ids
  (`changed` and `managedBy` of `environment.settings_updated`) are **bounded names, not
  secret-proof**: a token-shaped string fits either pattern. What keeps a secret out of them
  is that each has one producer, `Settings.changedKeys` and the validated `x-tula-managed-by`
  header; a new string field needs that argument, not only a pattern. The union of all
  events is `TulaEvent` / `TulaEventSchema` (never `Event`, which is the DOM's). Within
  `EVENT_SCHEMA_VERSION` a payload only grows (a new type, an optional field, an enum
  value); anything else is a new version. `events.payload` is built only by `eventPayload`
  (`~/lib/event-payload`), in both adapters: it keeps what the schema names and accepts,
  field by field, drops the rest, logs by name what it dropped, what is required and
  missing and what breaks a rule that spans fields, and never throws (an `occurredAt` that
  is not a time becomes the time now). The
  audit entry's `metadata` is not narrowed by it.
  `apps/api/src/event-canary.test.ts` runs every conformance scenario with the wire tapped
  (every request header, whatever its name) and fails if anything a request carried, a
  response handed out as a secret or an email held is found in a payload; a client-supplied
  value that is meant to be in one is an entry of that test's `MAY_APPEAR`, with the one
  field it may be in. `conformance.test.ts` holds every recorded payload to its schema. After changing a schema run `bun run contract:generate` (the schemas are
  components of the OpenAPI document, added in `createApp` because no route refers to them)
  and `bun run dashboard:generate`.
- **The activity is a required parameter, in the ports and in both adapters** (`Recorded` in
  `~/ports/activity-log`): a call that leaves it out does not compile. Never make one
  optional, give one a default or accept `undefined`. A write that is never recorded is a
  method of its own that takes none (`upgradePasswordHash`, the signing-key store's
  `insert`), added together with a line in ADR 0012. `Audit.none('fixture')` is the explicit
  "not recorded" for seed data in tests and in `e2e/server.ts`; its reasons are a closed
  list. Its value is branded with a symbol `ports/activity-log.ts` does not export: never
  export that key, never build the value anywhere but `unrecordedFor`, never call that from
  anywhere but `Audit.none`, and tell the value apart only with `isUnrecorded`.
  `ports/activity-log.test.ts` fails if a server file reaches either function by any import
  form (keep its bypass fixtures, and add one for a new form). That file also holds the
  `@ts-expect-error` line of every such method: a new one gets a line there.
