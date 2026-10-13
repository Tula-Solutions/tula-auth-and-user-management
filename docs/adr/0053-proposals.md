# ADR 0053 — Proposals: an agent asks, a person approves

- Status: accepted (the first operation only: banning a user)
- Date: 2026-10-12

## Context

The MCP server of Phase 1 can only read ([ADR 0033](0033-mcp-server.md)). It was built that
way because an assistant reads text that users wrote: a tool that changes something is a
tool a sentence in a user's name could try to trigger. That ADR left one thing open: "write
tools are a later phase and a separate facade, and a decision about confirmation".

Step 2.17 of [the plan](../plans/phase-2.md) is that decision. This record is its first
slice (TULA-23): one operation, banning a user, built so that the next ones (TULA-24), the
dashboard's approval screen (TULA-40), production (TULA-39) and `test_signin` (TULA-41)
extend it instead of replacing it. What is decided here is the mechanism, and it is
decided for all of them.

The requirement is short. An assistant must be able to say "this account should be banned"
in a way that leads to the ban, and **nothing that reaches the model may be able to cause
the ban by itself**: not a tool, not a credential, not a sentence in a user's name.

## Decision

### A third kind of key: the agent key

An environment's API key is `publishable`, `secret` or, now, **`agent`** (`tula_ak_<env>_…`,
`AGENT_KEY_PREFIX`). It is made where every key is made (`POST /v1/admin/api-keys`, the
dashboard's API keys screen, `bun run api-key:create --kind agent`), shown once, stored as a
SHA-256 hash, listed and revoked like the others, and it resolves to its environment.

What it may do is decided by the server, in two places and nowhere else:

| Where | What an agent key gets |
| --- | --- |
| `secretKey()`, on `/v1/admin/*` | A **`GET` or `HEAD`** is served: an agent key reads what a secret key reads. Any other method is `401 auth.invalid_key`, decided from the method **before the key is looked up**, so the answer never depends on the route, the body or the key. |
| `agentKey()`, on `/v1/agent/*` | `POST /v1/agent/proposals`, and since [ADR 0058](0058-test-signin.md) `POST /v1/agent/sign-in-tests`. A secret key, a publishable key and a dashboard session are `401 auth.invalid_key` on both. |

**Since ADR 0058 an agent key can do one thing that changes live data**: run a sign-in
test, which makes a throwaway user, signs it in and deletes it, with the environment's
hooks asked and its events delivered. It is the group's second route and takes no body;
it runs only where the environment's `agents.testSignIn` allows it (off in a production
environment by default), a few times an hour. "The worst a manipulated assistant can do
with it is read and ask" below now reads "read, ask, and run that test where the operator
allowed it". `secretKey()` is as it was: on `/v1/admin/*` an agent key is still a read and
nothing else, and the same run has a route of its own there for a secret key.

Everything else (`/v1/client/*`, `/v1/instance/*`, the dashboard's session exchange) does
not know the key and refuses it as it refuses any unknown credential.

**Why a key kind and not a scope on a secret key.** A secret key that is "only used for
reads" is a credential that can write, held by the process the model talks to; the
separation would be a promise of the tooling. A key the server refuses on every write is a
property of the deployment: the worst a manipulated assistant, a bug in a tool or a
replaced MCP server can do with it is read and ask.

**Why reads go through `secretKey()` and proposals through a route group of their own.**
`secretKey()` stays the only way in to an admin route (the test that walks the admin routes
is unchanged), and it now admits one more credential for a reason that fits in a line: the
method is a read. The proposal route is *not* an admin route: a secret key must not be able
to call it (below), so it cannot sit behind `secretKey()`.

`apps/api/src/agent-key.test.ts` walks the route table: every route that is not a `GET` or
`HEAD` refuses an agent key, with the two exceptions named there (the proposal, and the
sign-in test of ADR 0058), and every admin `GET`
serves it. A new write route is covered without anyone remembering to add it.

**What an agent key reads is everything a secret key reads**, API keys' names and last four
characters and users' email addresses and IP addresses among them. That is personal data
going to a model, exactly as with a secret key behind the read-only facade; the tools
return an allow-list of it (ADR 0033), the key does not narrow it. Narrower read scopes
are not built.

### A proposal

`POST /v1/agent/proposals` takes `{ operation, target: { type, id } }` and nothing else, and
answers a **proposal**: a row of `proposals` (tenant columns, row-level security) with

- the **operation**, from the closed list `PROPOSAL_OPERATIONS` (`ban_user` at first; four
  since TULA-39, "The other reversible operations" below), and the
  **target**, a kind from the closed list the operation allows and an id;
- a **summary**: what approving it does, in plain words. It is written by the server from a
  fixed sentence per operation and the target's id (`proposalSummary` in `@tula/contract`).
  **A proposal holds no text anyone wrote**: no reason, no note, no title. A free-text field
  is where an assistant that was told to would put "approved by the security team";
- who asked: the **agent key's id** (`proposedBy`);
- a status (`pending`, `approved`, `executed`, `failed`; `expired` is derived on reading)
  and `expiresAt`, **ten minutes** after it was made (`PROPOSAL_TTL_MS`; the table's check
  refuses a lifetime over an hour whatever the code says).

Creating one **changes nothing else**. It is recorded (`proposal.created`, actor the agent).

- **The target must exist** (404 otherwise). The agent can read users anyway, so it learns
  nothing, and a person is never asked to approve a ban of nobody.
- **Asking again is the same proposal.** The same agent key, operation and target while one
  is pending answers that one, with no second row and no second audit entry: an assistant in
  a loop does not fill the list a person has to read.
- **Ten a minute per environment** (`PROPOSALS_PER_MINUTE`), counted after the key is
  resolved; a limiter that cannot count refuses.
- **A production environment accepts none unless it opted in** (`403 auth.forbidden`,
  `params.reason: 'production_environment'`). The opt-in is the setting
  `agents.proposalsInProduction`, off by default ("Production environments opt in"
  below; the first version had no setting and always said no). Decided before the target
  is read.
- **Only an agent proposes.** A secret key calling the route is refused by the middleware
  and again by the service. A person who wants a change makes it; if a secret key could
  propose, "who asked" in the audit log would stop meaning "an agent".

### Approval

`POST /v1/admin/proposals/:id/approve`, behind `secretKey()`, so it takes **a secret key or
a dashboard session** and, being a `POST`, never an agent key. `GET /v1/admin/proposals` and
`GET /v1/admin/proposals/:id` list and read them (an agent key may: they are reads).

- **Who may approve** is the caller's actor type, checked in the service against the closed
  list `PROPOSAL_APPROVER_TYPES` (`admin`: a secret key; `instance_admin`: a dashboard
  session). Not a user, not the system, not an agent, whatever middleware a later route is
  put behind.
- **The approval names what is approved.** Its body repeats the proposal's `operation` and
  `target`, and the server refuses it (`409 resource.conflict`, `reason: 'mismatch'`) when
  they are not the proposal's. So what a person was shown is what is carried out: an
  approval typed for one proposal cannot be spent on another by a swapped id, and a client
  that never displayed the proposal cannot approve it.
- **Once.** The store's `approve` is a compare-and-set (`status = 'pending'` and
  `expires_at > now`) that writes the approver and the `proposal.approved` entry (actor: the
  person) in one transaction. Of two approvals at once one wins; the other is
  `already_decided` and nothing runs twice. A proposal at or past its expiry is `expired`.
  The statement has a third condition, the agent key that asked is still an agent key of
  the environment and not revoked: "Revoking an agent key", below.
  The runtime role may update only the columns a decision writes (column-level grants), and
  a check holds the approver's type, id slot and time together.
- **Then the operation, by the server, as the agent.** `Users.ban` is called with the agent
  as its actor and the proposal beside it: `user.banned` carries `proposalId` and
  `approvedBy`. The ban is the same function an administrator's ban is (sessions ended,
  denylisted). Then the proposal is finished: `executed`, or `failed` with a fixed word
  (`target_not_found`: the user was deleted meanwhile; `incomplete`: the operation's own
  write was made and a later step failed, "A ban that was half carried out" below;
  `error`), recorded as `proposal.executed` / `proposal.failed` (actor the agent,
  `approvedBy` in the data).
- **A proposal is spent by its approval, whatever follows.** A failed one is not approved
  again; the agent asks again. If the last write fails the proposal stays `approved`, which
  nothing approves a second time, and an error line with fixed words, the ids and the
  error's name is its trace.

No new error code: `auth.invalid_key`, `auth.forbidden`, `resource.not_found` and
`resource.conflict` with a fixed `params.reason` (`PROPOSAL_APPROVAL_REFUSALS`,
`PROPOSAL_CREATION_REFUSALS`). `@tula/core`'s message table has every contract code and its
bundle budget has no room to give away.

### What is recorded

| Entry | Actor | Target | Data |
| --- | --- | --- | --- |
| `proposal.created` | `agent` (the key's id) | the proposal | `operation`, `targetType`, `targetId` |
| `proposal.approved` | `admin` or `instance_admin` | the proposal | the same, and `proposedBy` |
| `user.banned` | `agent` | the user | `proposalId`, `approvedBy` |
| `proposal.executed` / `proposal.failed` | `agent` | the proposal | the same, `approvedBy`, and for `failed` the reason |

Ids and closed words only, as every event payload is ([ADR 0012](0012-events-and-audit-log.md)).
The actor type `agent`, reserved since Phase 1, is now used: for the proposal, and for what
a proposal carried out. **The agent is the actor of the change and the person is named
beside it**, in the change's own entry: someone reading `user.banned` alone sees that an
agent's proposal did it and who let it. A read with an agent key is not audited, as a read
with a secret key is not.

### The lifetime of a row

A proposal is deleted by the retention job thirty days after its expiry, whatever became
of it (`EXPIRED_PROPOSAL_RETENTION`, `ProposalStore.deleteExpiredBefore`); the audit
entries about it stay as long as the environment keeps audit entries
([ADR 0017](0017-retention.md)). The row is what an operator looks back at for a while;
the lasting record of what an agent asked for, who approved it and what was done is the
audit log. Whether a later "what did this agent do" screen (TULA-40) needs the rows for
longer is its decision.

### The MCP server: a second facade

`@tula/mcp` gains `proposing.ts`, beside `read-only.ts` and sharing nothing with it but the
request timeout:

- `PROPOSE_OPERATIONS` is the allow-list: `['createProposal']`. Enforced as the read list
  is, three times: by the type of `propose`, on every call, and when the facade is made, by
  checking that each id is a **`POST` under `/v1/agent/`** in the client's operation table.
  An id that moved under `/v1/admin/` in a later contract is refused at start. **No
  operation of `/v1/admin/*` may be on this list, and `approveProposal` never.**
- `ProposingAdmin` has one function, `propose({ operation, target }, { signal })`. It builds
  the body field by field from values it has just checked (`PROPOSABLE`: the operation and
  the kind of its target; an id that is one path segment) and passes on a signal. No
  header, method, path, parameter or timeout of the caller's: a test hands it all of them.
- **`ReadOnlyAdmin` is unchanged**: same allow-list, same type, same object. A test holds
  that it has `read` and nothing else, and still refuses `createProposal`.
- The facade wraps the **agent's client** (`createAgentClient` in `@tula/admin`, which
  refuses anything that is not an agent key) and is never built over an admin client by
  the server: with a secret key and no agent key the propose tools answer `not_configured`.

One tool at first, `propose_ban_user` (`{ userId }`, strict); three more since TULA-39
("The MCP tools" below). It answers the projected proposal
(`id`, `operation`, `target`, `summary`, `status`, `createdAt`, `expiresAt`), `changed:
false` and a fixed `nextStep` sentence. The tool's description and the server's
instructions say the same thing three ways: nothing has been changed, a person approves
with their own credential outside this server, never say the change was made. Its
annotation is `readOnlyHint: false` (it records a proposal), `destructiveHint: false`,
`idempotentHint: true`. Agent keys are a `SECRET_SHAPES` pattern.

**`tula mcp` with an agent key does not read the secret key at all** (`TULA_AGENT_KEY`,
`TULA_AGENT_KEY_<NAME>`, `--agent-key-file`). The reads then go through the agent's client
behind the same read-only facade. A secret key that is also set is left unread, and that is
said on standard error.

### `tula approve`

`tula approve <proposal id>` is the person's side: it reads the proposal and the user it is
about with the operator's **secret key** (from the environment or `--secret-key-file`,
never an argument), prints what approving does (the server's summary, and the user's
address and name through `printable()`), asks, and approves **exactly what it printed**.
Not at a terminal it refuses, and it has no `--yes` (the first version had one: "An
approval cannot be scripted", below). The question is asked with a sentence of the CLI's
own per operation: an operation this version does not know is not approved. An agent key
is refused before any request.

## What this does and does not prove

- **It proves a credential was used that the agent's tools do not have.** It does not prove
  a person looked. Any program that calls the route with a secret key approves unread
  (`tula approve` itself no longer can be run by one without a terminal: "An approval
  cannot be scripted", below).
- **A coding assistant with a shell is not separated from the secret key by this.** Bun
  loads `.env.local` for `tula`; an assistant that can run commands in a project whose
  `.env.local` holds the development secret key can call the admin API directly, or run
  `tula approve` under a pseudo-terminal and type the answer. The MCP server not *using* the secret key does not take it
  out of the machine. The separation holds where the agent's process and the person's
  credential are actually apart: a hosted assistant with only the MCP server and an agent
  key, or approval in the dashboard (TULA-40) behind a sign-in the assistant does not have.
  The docs say so wherever the setup is described. That, and the refusal of production,
  is why this slice is called a first one.
- **The instance admin token** beside an agent key (`run_doctor`'s server-side checks) is a
  person's credential in the agent's process. No tool can use it for anything but the
  checks, but `tula mcp` says on standard error that it would rather not have it there.
- **A summary is the server's sentence about an id.** It does not say who the user is; the
  agent's own account of why is in the conversation, where a person should weigh it as a
  claim. `tula approve` reads the user itself for that reason.
- **Reversibility is what bounds a wrong approval**: a ban is lifted. Only reversible
  operations are to be added to `PROPOSAL_OPERATIONS` (the plan's D-table, 2.17); one that
  is not is a decision of its own.

## Not verified

- **No real MCP client has been connected**, to the read-only server or to this one
  ([phase-2-unverified.md](../plans/phase-2-unverified.md), "Step 2.17"). How a client
  shows `propose_ban_user`'s result to a person, whether it shows `nextStep`, and whether a
  model then says "I have asked for" and not "I have banned" was not observed. The ticket
  asks for this before the feature ships. A client is installed on the machine this was
  built on (the Claude Code command line); starting it from the run that built this was
  refused by that run's own permissions, so the commands for a person are in the
  unverified list.
- **What was run on a real server, and what was not.** On 2026-10-12 the proposal
  store's suite and its races passed against PostgreSQL 17 as the runtime login
  (`stores.integration.ts`, `races.integration.ts`; 391 tests in the two files): row-level
  security, the column grants, two approvals at once on separate connections, an approval
  at the expiry, and an approval against the revocation of its agent key in both orders,
  with a round that fails unless the revocation is seen waiting behind the approval's
  share lock. So the lock is shown, at the store. Not run: two API instances (the races
  are two pools in one test process, below the service), and the scenario against a live
  server.
- The scenario and the tests run on a development environment; nothing was run against a
  deployed server.

## Not decided here

- ~~Production: the per-environment opt-in (TULA-39).~~ Decided: "Production environments
  opt in" below.
- Approval in the dashboard, a list for a person to work through, notifications (TULA-40).
- More operations (TULA-24), and `test_signin` (TULA-41).
- Narrower read scopes for an agent key; a key per agent identity beyond "one key is one
  agent"; a limit per agent key rather than per environment.
- Rejecting a proposal (today one is left to expire), and an end for decided proposals.

## Alternatives considered

- **A flag on a secret key, or a "read-only" secret key plus a confirmation tool.** A tool
  that confirms is a tool the model can call.
- **The approval as a one-time code the tool returns and the person types back to the
  assistant.** The code would pass through the model, which is the party it is meant to
  exclude.
- **Let the proposer attach a reason.** It is the most useful field and the most dangerous:
  text chosen by a possibly manipulated model, shown to a person at the moment of decision,
  under the server's name.
- **Carry the operation out by replaying a stored request.** A proposal would then be an
  arbitrary stored admin call. It stores an operation from a closed list and an id, and the
  server calls one function per operation.
- **`/v1/admin/proposals` for the creation, with `secretKey()` taught to let an agent `POST`
  there.** That makes `secretKey()`'s rule "reads, and this one path", and lets a secret key
  propose.

## Revoking an agent key (added after the security review)

The first version let an operator approve, for ten minutes, what a key they had just
revoked had asked for. A key is revoked because its holder is no longer trusted; what it
asked for is then the request of that holder.

- **Revoking the key is the write that ends its pending proposals.** Nothing is written
  to a proposal: a pending proposal is live only while the key that asked is an unrevoked
  agent key of the proposal's own environment, and that is asked of the keys table
  wherever a proposal is read or approved. So the revocation and the end of the proposals
  are one row's update, in the revocation's own transaction, with its own audit entry
  (`api_key.revoked`), and there is no window between the two. A key that is gone
  altogether answers the same.
- **Why derived, and not a stored end.** A stored one needs either an `UPDATE` of
  `expires_at` or a status with no approver. The runtime role is deliberately not granted
  the first (a proposal could be revived), and a new status is a new state in every
  reader of the contract for something a fixed reason says as well. Expiry by time was
  already derived; this is the same idea with a second cause. The cost is a subquery on
  every read of a proposal (an index lookup by primary key), and that no
  `proposal.expired` entry exists: the trace is `api_key.revoked`, and the proposals of
  that key are found by `proposedBy`.
- **The read says it**: `status: 'expired'` with `expiryReason: 'agent_key_revoked'`
  (`PROPOSAL_EXPIRY_REASONS`: `time`, `agent_key_revoked`; `null` for every other status).
  Revoked wins over time: a proposal of a revoked key that is also past its ten minutes
  says the key. `ProposalRecord.proposerActive` is the port's word for it, computed at the
  read and never stored (`NewProposalRecord` has no such field).
- **`approve` refuses three times, and the third is the one that counts.** The service
  refuses before the compare-and-set (`resource.conflict`, `reason: 'agent_key_revoked'`,
  no new error code); the store's statement carries the condition itself, so a key
  revoked between that look and the write approves nothing and records nothing; and after
  a miss the service reads the row again to say why. In Postgres the approval also takes
  a `FOR SHARE` lock on the key's row in its transaction, before the update, so that a
  revocation committing at that moment either is seen by the statement or waits until the
  approval has committed. What that does not give: an approval that commits first is an
  approval, and the operation that follows it runs although the key is revoked a
  millisecond later. That is the same as a revocation a millisecond after a ban: the
  order is real, and the entries say it.
- **The subquery names its tables.** Drizzle writes bare column names in an `UPDATE`, and
  the first version of the condition compared `environment_id` with itself inside the
  subquery, which let another environment's agent key pass. The condition is written
  with an alias for the keys table and the proposals table spelled out, and the store's
  suite has the row that caught it (a proposal that names another environment's agent
  key, a secret key, a publishable key).
- A proposal that was approved before the revocation stays what it became. Revoking a
  key undoes nothing.

## A ban that was half carried out (added after the security review)

`Users.ban` writes the ban and then ends the user's sessions. The second can fail by
itself (the store behind the revoked-session list answers `service.unavailable`). The
first version recorded such a run as `failed` with `error`, and `tula approve` then said
that nothing had been carried out, which was false: the user was banned.

- The service **reads the target before the operation and, after a failure that is not
  "the target is gone", again**. Where the operation's own write was not there before and
  is there after (`bannedAt` is set), the reason is `incomplete`; otherwise, and when
  either read fails, it is `error`, which claims nothing. A user who was already banned
  when the approval came is therefore never `incomplete`, whatever failed: this run did
  not change them. `PROPOSAL_FAILURE_REASONS` is `target_not_found`, `error`,
  `incomplete`; the event and the audit entry carry the word, as an enum value.
- **Never `executed`, and never retried.** The proposal is spent. What is left to do is a
  person's: end the sessions (`DELETE /v1/admin/users/:userId/sessions`, or the
  dashboard). `tula approve` says "the user is banned, and ending their sessions failed",
  names that route, and exits 1. A banned user's refresh is refused, so such sessions
  end by themselves, but not at once; the docs say "may still be live" and no time.
- What is left: a user an administrator banned between this run's first read and its
  failure reads as `incomplete`, though another request wrote the ban. The window is one
  request wide, and what `tula approve` then says (banned, end their sessions) is still
  what a person should do.
- A new operation says what its own write looks like in `changeIsThere`, or gets `error`.

## The document and the agent key (added after the security review)

`secretKey()` admits an agent key for `GET` and `HEAD`, and the OpenAPI document said
"a secret key or a dashboard session" for every admin operation. The document is now made
true in one place: `documentAgentReads` (`apps/api/src/openapi.ts`) adds the `agentKey`
security requirement to every `get` under `/v1/admin/` that takes a secret key, when the
document is built, so a route does not have to remember it and a new read gets it by
default, as the middleware gives it the key by default. A write never lists it. Two
things hold that: `openapi.test.ts` walks the document (every admin read lists
`agentKey`, no admin write does, the agent's own group lists nothing else), and the admin
client's generator stops for an admin `GET` without it and for any other admin method
with it. `createAgentClient` is typed as the whole admin client and was not narrowed to
the reads: the server refuses what an agent key may not do, and a second typed surface
would be a second list to keep true. Narrowing it is possible from the document now.

## `user.banned` and its two fields (added after the security review)

`proposalId` and `approvedBy` are there together or not at all: the schema refuses one
without the other (`banIsWhole`). `eventPayload` never fails a write for it: a payload
that breaks the rule is logged by the names of its fields, as every rule that spans
fields is, and the one call site (`Users.ban`) gives both or neither.

## Where an entry says a request came from (added in review)

An audit entry holds the IP address and the user agent of the request behind it. The
operation of an approved proposal runs inside the **approver's** request, with the agent
as its actor. Its entries (`user.banned`, `proposal.executed`, `proposal.failed`) therefore
hold no address and no user agent: the first version copied the approver's onto them,
which put a person's address under an agent's id and two origins under one actor. The
approver's origin is on `proposal.approved`, the agent's own on `proposal.created`.

## The other reversible operations (TULA-39)

Three operations join `ban_user`, by the mechanism above and no second one: the same row,
the same compare-and-set approval, the same two facades.

| Operation | Target | What approving it runs | The administrator's own route |
| --- | --- | --- | --- |
| `ban_user` | `user`, by id | `Users.ban` | `POST /v1/admin/users/:id/ban` |
| `unban_user` | `user`, by id | `Users.unban` | `POST /v1/admin/users/:id/unban` |
| `end_session` | `session`, by id | `Sessions.revokeForProposal` | `DELETE /v1/admin/users/:id/sessions/:sessionId` |
| `disable_oauth_provider` | `oauth_provider`, by the provider's name | `OAuth.switchOff` | `PUT /v1/admin/oauth-providers/:provider` with `enabled: false` |

**What makes an operation one of these, and what keeps another out.** Each can be put back
by an administrator with one call (unban, ban, a new sign-in, switching the provider on),
none returns or sets a secret, and each acts on **one** thing named by one id. So there is
no proposal that deletes a user or a provider, resets a second factor, revokes or makes a
key, sets a password, writes a provider's credentials, switches a provider **on** (it would
open a way in), rotates a signing secret, replaces the settings, or ends every session of a
user. The list is `PROPOSAL_OPERATIONS` in the contract and `PROPOSABLE` in `@tula/mcp`;
a test hands the facade each of those refused operations by name, as a line that does not
compile and as a call that is refused (`proposing.test.ts`). A new operation is a decision
recorded here, with its row in the table.

**An operation has one kind of target, and the request schemas hold it**
(`PROPOSAL_OPERATION_TARGETS`; a mismatch is a 422 on the proposal and on the approval). A session is ended by **its own id**: `end_session`
with a user as its target is refused by the schema, because "the sessions of this user" is
the bulk operation under another name. `Sessions.revokeForProposal` takes a session id and
finds it in the environment; there is no proposal path into `revokeForUser`.

**A provider is named by its name**, a member of the contract's closed `OAUTH_PROVIDERS`,
because that is what a provider is to an operator and to the admin API (a row's id is in no
answer). So `proposals.target_id` is text, with a check of its shape
(`proposals_target_id_shape`: lower-case letters, digits, `_` and `-`, at most 64), and the
contract's `isProposalTargetId` says per target type what an id is (a UUID for a user and a
session, a provider's name for a provider). Migration `0035_proposals_target_id_text`.
The column was a UUID; nothing that reads it compared it as one.

**Switching a provider off is `enabled: false` and nothing else.** `OAuth.switchOff` reads
the row under the environment's `sign_in_methods` lock and writes it back with the switch
turned: nothing of the write comes from a request, so the client id, the sealed secret and
the rest are what they were. A provider already off is left alone and nothing is recorded.

**The last way to sign in is refused twice, by the function the admin route uses**
(`OAuth.requireWayIn`):

- when the proposal is made, outside the lock, as a courtesy: the same `ValidationError`
  (422) the provider route answers, so a person is not asked to approve what cannot be
  done;
- when it is approved, **inside the lock `Settings.replace` and `OAuth.update` take**: that
  is the one that decides. A proposal that was fine when it was made and is approved after
  the other ways went is approved (the approval is written first, as always), the
  operation is refused, and the proposal ends `failed` with the new reason
  `last_sign_in_method`. It is spent. The provider is still on.

What an administrator's own change records is what this records: `oauth_provider.updated`
with `changed: ['enabled']`. Switching a provider off is not a weakening on the admin
route (`oauthProviderWeakenings`) and is not one here; nothing restates the rule.

**No new activity type.** The change is the entry it always was (`user.unbanned`,
`session.revoked` with the reason `revoked_by_admin`, `oauth_provider.updated`), with the
agent as its actor and `proposalId` and `approvedBy` in its data, together or not at all,
as `user.banned` has them. The reason of an ended session stays `revoked_by_admin`: a
person with an administrator's credential approved it, and a client's handling of the
reason does not change.

**`incomplete` is still a ban's.** A ban commits and then ends sessions; the other three
operations' own write is their last step. `changeIsThere` says for each what its write
looks like, so a failure after a write is not reported as "nothing happened".

### Production environments opt in

`agents.proposalsInProduction`, a boolean in the environment's settings document, **off by
default**. A production environment is one whose own `kind` is `production` (never the
deployment's `ENVIRONMENT`, never `NODE_ENV`); every other environment accepts proposals
whatever the setting says.

- **Refused when a proposal is made**: `403 auth.forbidden`,
  `params.reason: 'production_environment'`, before the target is read. This is what the
  first version always answered for production; ban included.
- **Refused again when one is approved**: `409 resource.conflict`,
  `params.reason: 'production_environment'`, before anything is written, so **the proposal
  is not spent**: an operator who switches the setting back on within the ten minutes can
  approve it. An approval is a `409` with a reason in every other case it is refused, and
  `tula approve` reads the reason; a 403 there would say the approver's credential is the
  problem, and it is not.
- **Both read the settings past the cache** (`Settings.get(…, true)`). The setting is a
  switch somebody may turn off because something looked wrong; "within 5 to 30 seconds
  on other instances" is not good enough for that, and a proposal is rare enough that the
  read costs nothing.
- **No new error code.** `auth.forbidden` and `resource.conflict` exist, the reason is a
  fixed word of the contract's lists (`PROPOSAL_CREATION_REFUSALS`,
  `PROPOSAL_APPROVAL_REFUSALS`), and `@tula/core`'s message table and bundle budget are
  untouched.

**Switching it on is a weakening** (`settingsWeakenings`: `agents.proposalsInProduction`,
`false` to `true`), so it is what every weakening is: the audit entry of the settings
change names the key in `changed` and says `weakened: true`, the dashboard asks first
(a switch under "AI agents" on the general settings screen, with a sentence of its own in
`describeWeakening`), and `tula apply --yes` refuses the plan without `--allow-weaker`.
Switching it off is an ordinary change. In `tula.config.ts` the key left out is `false`,
and managed: a file that says nothing switches it off (`docs/config.md`, and a row in
`diff.test.ts`). The default is left out of the config's fingerprint, so a file applied
before the setting existed hashes as it did.

**The setting is not something an agent can change.** An agent key reaches no `PUT`.
`get_settings` returns it (an agent that is refused can say why), and
`draft_settings_change` can draft it, as it can any setting the projection names: the
draft is an edit to a file for a person to apply, it is listed under `weakened`, and
`tula apply --yes` refuses it. Leaving it out of the draft tool would hide a setting an
operator may ask an assistant about and protect nothing: the draft changes no server.

### Limits

Every proposing tool is one route, and the route is limited twice, per environment,
failing closed (`service.unavailable` when the limiter cannot count):

- `PROPOSALS_PER_MINUTE` (10), shared by every operation, as before: it is what bounds how
  many proposals wait for a person at once.
- `PROPOSALS_PER_OPERATION_PER_MINUTE` (5), a count **per operation**
  (`proposal_create_operation`, keyed by the environment's id and the operation's word).
  An agent talked into asking for one thing again and again uses up that operation's
  minute and half of the shared one; the other operations can still be asked for.

A bucket per operation alone would let four operations fill a person's list four times as
fast; the shared count alone would let one looping tool silence the other three. The
per-operation count is mounted after the body is validated (the operation is in the body),
so a malformed request counts against the shared limit only.

### The MCP tools

`propose_unban_user` (`{ userId }`), `propose_end_session` (`{ sessionId }`) and
`propose_disable_oauth_provider` (`{ provider }`, the contract's enum), each a
`z.strictObject`, each answering what `propose_ban_user` answers: the projected proposal,
`changed: false` and the fixed `nextStep`. `ProposalRequest` is now a union made from
`PROPOSABLE`, one member per operation with that operation's target type, so a tool that
names a session for a ban does not compile.

**A propose tool refuses an answer that is not the proposal it asked for**
(`response.invalid`): the operation and the target of the answer are compared with the
request before anything is projected. A server (or something in front of it) that answers
a ban with "a provider was switched off" must not have that read out as what was proposed.

**The injection corpus** (`packages/mcp/src/testing/injection.ts`): instructions to
approve, a result that says it was carried out, role markers, markdown, HTML, control
characters, characters that draw nothing (written as `\u{…}` escapes), a key to approve
with, and more text than a result holds. Two tests use the one list:

- `@tula/mcp`'s, against a fake API that puts each string in **every field** of the
  answer of every propose tool: the result is the allow-list projection, cleaned and
  capped, or `response.invalid`, and every request made was a `GET` or the one `POST`
  that asks;
- `tula mcp`'s, against the real API in process, with each string in a user's name and a
  session's user agent: every propose tool is called, and the users, their sessions, the
  providers and the settings are byte for byte what they were, with nothing recorded but
  `proposal.created`.

What these show is that **the server changes nothing without an approval, whatever a
model was told**. They do not show what a model does with such text: no model was run.

### `tula approve`

One sentence per operation for the question, the target shown as it is now (a user with
their address and whether they are banned; a session with whose it is and whether it is
still live, below; a provider as "on now", "already off" or "not configured now", read
with the operator's key), and two new things
said in words: `production_environment` (nothing changed, not spent) and
`last_sign_in_method` (approved, nothing changed, the provider still on, spent).

### An approval cannot be scripted

Decided by the owner with TULA-39. **`tula approve` requires a terminal, and has no option
that answers its question.**

The first version asked at a terminal and took `--yes` anywhere else. That made the
command the easiest way round the whole mechanism: an assistant that can run shell
commands, on a machine where the operator's secret key is in the environment (Bun loads
`.env.local` for `tula`), approved its own proposal with one non-interactive command. An
approval is meant to be a person's act with their own credential; a flag that stands in
for the person is the opposite of that.

So:

- Where standard input and standard error (the stream the question is asked on) are not
  both a terminal, the command refuses with one fixed sentence, **before the key is
  resolved and before any request**: not the approval, and not the read of the proposal.
  The check is the injected `CliIo.isTTY`, with a prompt to ask through; no command reads
  `process.stdin.isTTY`, so the tests need no terminal.
- **`--yes` is removed from `approve`**, not kept as a flag that no longer skips anything:
  a flag that does nothing invites a script that believes it did. `-y`, `--yes=true` and
  any other spelling are the parser's "unknown option", refused before the command runs.
  `--json` is output only: the question is still asked, and the proposal is then shown on
  standard error first, because nothing is asked about a proposal that was not shown.
  `tula apply --yes` is unchanged: it applies a file the operator wrote, with the
  operator's key, and CI is where that belongs.
- **A key on standard input is refused** (`--secret-key-file -`). `apply` allows it and
  then requires `--yes`, because standard input cannot carry both the key and an answer;
  `approve` has no `--yes`, so the same fact has the other outcome. The key comes from a
  file or the environment, never an argument, as before.
- The question names the operation and the target, both through `printable()`, beside the
  consequence sentence and the API's address, and the answer is the typed word `yes`.

**What it costs.** No approval from CI, a cron job, a chat bot or any other program
through this command. A team that wants a programmatic approval calls
`POST /v1/admin/proposals/:id/approve` with a secret key, and then owns the question of
who looked; the command will not be the thing that hides it.

**What it does not stop, said plainly.** A terminal is not a person. An agent that
controls a pseudo-terminal on the operator's machine (`script`, `expect`, a terminal
multiplexer, a desktop-automation tool) can start the command and type `yes`, and nothing
here can tell. It also does nothing about the admin route, which takes the same key with
no terminal at all. What actually separates the agent from an approval is unchanged from
"What this does and does not prove": **the agent's key cannot approve, and the operator's
key is not given to the agent**. This change removes the one-line, non-interactive way to
misuse a key that was left within reach; it does not make a key within reach safe.

Tests (`packages/cli/src/approve.test.ts`): not a terminal in four ways (nothing is one,
only standard input is, a prompt without a terminal, a terminal with nothing to ask
through) refuses with the fixed sentence and makes no request; `--yes`, `-y`,
`--yes=true`, `--force` and `--no-input` are refused at a terminal and away from one with
nothing asked or sent; `--json` away from a terminal is refused; seven answers that are
not `yes` approve nothing; a typed `yes` approves once; the key on standard input is
refused without standard input being read. None of them opens a real terminal: that the
real process's check (`process-io.ts`) says "not a terminal" under a pipe, a redirect or
an agent's shell tool was not run for this change.

### Three things a review of this change asked about

- **A target's UUID has one spelling, lower case** (`isProposalTargetId`). With the column
  a `text` (migration 0035) the store keeps the id as the request wrote it, its check takes
  lower case only, and PostgreSQL finds a user by a UUID in any case: an upper-case id of
  an existing user would have been found and then refused by the insert, a 500. It is
  refused by the request's schema instead (422), for a proposal and for an approval, and
  the "ask again for the same target" look-up compares one spelling. That the old path was
  a 500 on PostgreSQL is an argument from the code: the memory adapter does not show it,
  and no PostgreSQL was run.
- **At an approval the production check comes first**, before `mismatch` and before
  "already decided": in a production environment whose opt-in was switched off, an
  approval of a proposal that was already carried out, or one that names something else,
  is answered `production_environment`. Nothing is written either way and the caller
  holds a secret key; the order is kept because the environment not taking approvals is
  the more useful thing to be told.
- **A proposal for what is already so is taken, and approving it changes nothing**: a
  provider that is already off, a user who is not banned, a session that has ended. The
  proposal ends `executed`, and the operation's own audit entry is written only when
  something changed. Refusing such a proposal when it is made would tell an agent no more
  than a read does and would not hold by the time it is approved; `tula approve` shows the
  target as it is now ("already off") for the person to see. The answer and the record
  say it too: the next section.

### Four things the second review asked for

- **`tula approve` shows a session with whose it is and whether it is live.** The first
  version printed the session's id and nothing else, while a user was shown with an
  address and a provider with its state. An agent's account of a session ("a stale
  session of mine") is a claim, and an id gives the person nothing to hold it against.
  The command now reads the session and then its user, with the operator's key, and
  prints the owner's id, address and name, the client kind, when the session was signed
  in, and "live now" or "already ended". **The admin API had no read of one session by
  its id** (only a user's list, which needs the user first), so one was added:
  `GET /v1/admin/sessions/:sessionId`, behind `secretKey()`, by environment and session
  id, another environment's id answered like an unknown one. It returns the session
  list's shape **and two fields that shape did not have**, `userId` and `active`
  (`AdminSessionSchema`): the list is asked for by user and filtered to live sessions, so
  it needed neither, and a read by id has no other way to say whose the session is or
  that it has ended. **`active` is by the stored times**, not by the session's profile
  as configured now (`Sessions.profileOf` is not asked): live by what is stored, and a
  profile tightened since may end such a session at its next request. `tula approve`
  and `docs/cli.md` say so. Nothing else: no token, hash, family or thumbprint. Like every admin
  read it is open to an agent key; `@tula/mcp` has no tool for it and its
  `READ_OPERATIONS` is unchanged. When a read fails the question says so in fixed words
  beside the bare id ("could not be read", "no such session now", and for the owner "the
  user could not be read" or "no such user now") and the person decides with that in
  front of them; the command never guesses and prints nothing of the failure. The user
  agent and the IP address are not printed: the first is text whoever holds the session
  chose.
- **An operation `run` has no branch for throws** (`UnknownOperationError`), into the
  path every unexpected failure takes: the proposal is `failed` with `error`, there is no
  `proposal.executed` and nothing was changed. Before, `run`'s `switch` fell out of its
  last case for a word it did not know and the proposal was recorded as carried out.
  Three things keep such a row from existing (the request's schema, the service's own
  list, the table's check); the default is for the day one of them is ahead of the code
  that runs. The test hands the service an approved row whose operation is a word of no
  list by rewriting what the store's `approve` returns: a row with such a word cannot be
  stored through the port, and the answer's own summary (`proposalSummary`) is built from
  the row as stored.
- **What an approval found already so is carried to the answer and to the record**, as a
  boolean: `changed`, optional, on the proposal the approval answers and in
  `proposal.executed`'s data. `false` when the operation ran and wrote nothing: the user
  was not banned, the session had ended, the provider was off. **Each operation says
  whether it wrote, and `execute` reports that** (`run` returns it): for a session, what
  the store's guarded update answered (`SessionStore.revoke`: `false` when it had already
  ended, and then no entry); for a ban lifted and a provider switched off, the branch of
  `Users.liftBan` and `OAuth.switchOff` that writes, which is the one that writes the
  entry (the provider's under the environment's lock). **A ban does not say, and what
  does not say is `true`**: `Users.ban` ends the user's sessions and writes `user.banned`
  again for a user who is already banned. `changeIsThere`, the read made before the
  operation, is kept for what it was for (telling `incomplete` from `error` after a
  failure) and decides nothing about a run that succeeded. A field that only grows the contract: optional, absent
  from every proposal that was not just carried out, and **not stored** (a later read of
  the proposal does not have it; the audit entry is where it lasts). `tula approve`
  then says "Approved and carried out; the session had already ended, so nothing
  changed. The proposal is spent." instead of the sentence that describes the change, and
  still exits 0: what was approved is so. The case it is for is a target that changed
  between the showing and the approval (the user signed out while the person read).
  **It was first inferred from that earlier read, and that was wrong**: the read saw the
  target already so, another administrator turned it back, the operation then really
  wrote (`user.unbanned`, `oauth_provider.updated`), and the answer and
  `proposal.executed` still said `changed: false`. The tests make the first read answer
  one thing and the store hold another, for each of the three. What is left, stated:
  `changed: false` means the operation's own write did nothing, so `changed: true` and
  the operation's entry now always go together; lifting a ban is a read and then a write
  with no guard between them, so two liftings at once can both write (as two
  administrators' can, with or without a proposal), and each then truthfully says `true`.
- **The four scenarios ask for fewer proposals.** One run made nine counted requests of
  the ten an environment takes in a minute. The step that proposed switching a provider
  on (a 422 from the request's schema, which a route test, the contract's test and
  `@tula/mcp`'s tests show) was taken out of scenario 111: eight, with two to spare, and
  at most three of the five any one operation has. The limit was not raised.
  `conformance/README.md` has the table and the rule for a step that would add one.

### Not verified, and not built

- No MCP client and no model was run against the three tools either
  ([phase-2-unverified.md](../plans/phase-2-unverified.md)).
- The store's suite gained rows for a session and a provider as a target, and the
  migration's check is tested on PGlite. `stores.integration.ts` and
  `races.integration.ts` were **not** run against PostgreSQL for this change.
- The four scenarios run in process. Against a live server they were not run; together
  they make eight counted requests of the ten an environment takes in a minute, which a
  step added to one of them has to mind.
- `tula approve`'s reading of a session was tested against a fake admin API and, for the
  route, against the API in process on memory adapters. The route reads through the
  session store's existing `findById`; it was not run against PostgreSQL for this change.
- That a production environment refuses is shown by API tests and by `tula approve`'s
  and `tula mcp`'s tests in process: a scenario has one environment and one kind of key,
  and that environment is a development one.
- Not built: a proposal that switches a provider on or changes any other setting; a
  limit per agent key; approval in the dashboard (TULA-40; built since, see the next
  section).

## The dashboard's Proposals screen (TULA-40)

A screen of the dashboard (`apps/dashboard/src/features/proposals`) lists an environment's
proposals and approves one with the dashboard's session. **Nothing of the API changed for
it**: it reads `GET /v1/admin/proposals`, and the user, the session or the provider a
proposal is about, and approves with `POST /v1/admin/proposals/:id/approve`.

- **The approval sends what was shown.** The question is asked from a snapshot of the
  proposal taken when the dialog opened; the request's operation and target are that
  snapshot's, never read from the list again. The server's `mismatch` is the check.
  **What the question says the proposal is about is a snapshot too**: the card's line as
  it was drawn when the dialog opened, kept as text and not read again, so the question
  does not change under the person reading it. A question opened before the target was
  read says that it had not been.
- **The question is the dashboard's own words** (`consequenceOf`, the sentences `tula
  approve` uses), beside the server's `summary`. An operation with no such sentence has no
  Approve button, as `tula approve` refuses one with no `CONSEQUENCES` row.
- **In a production environment the target's id is typed** (`ConfirmDialog`'s
  `requireText`), as for every destructive action of the dashboard.
- **The status is the server's.** The countdown is the screen's, by the browser's clock,
  rounded down, in no live region; when it runs out the list is read again, once per
  proposal, and the button stays until the server says `expired`. The list is also read
  every ten seconds (`PROPOSALS_REFRESH_MS`): a proposal arrives while a person waits for
  it, and nothing pushes.
- **Every outcome has its own words**, by the contract's closed lists: `executed`,
  `executed` with `changed: false`, each `failureReason` (`incomplete` never reads as
  "nothing happened", and for a ban it names the user's page), each
  `PROPOSAL_APPROVAL_REFUSALS` reason, and `approved` (outcome not recorded). A failure
  that is not a refusal of the proposal (no answer, a 5xx) is said to have possibly been
  taken. A test holds that every member of each list has words.
- **Sent once.** The dialog's button is unavailable from the click until the dialog
  closes, which is when the answer arrives. A dialog closed while its request is in flight
  does not cancel the request, and the answer is still shown. While one approval is on its
  way no other card can be asked about (unavailable, with the reason in words; only the
  card being approved is `aria-busy`).
- **The answer does not wait for the list.** The list is read again after every answer,
  started and not awaited: a slow read must not keep "the user is banned, end their
  sessions" or a refusal off the screen. Until that read lands a card may still say
  `pending`; a proposal this screen has an answer about cannot be asked about again
  meanwhile.
- **Text from the server is text.** Ids go through `printable()`; nothing is drawn as
  markup. A proposal holds no words of the agent's, and the screen adds no place for any.
- **The words say "approved", never more.** What an approval shows is unchanged by the
  screen ("What this does and does not prove"): a dashboard session is a credential the
  agent's tools do not hold, and a person who clicks without reading is not defended
  against. A test scans the screen's sources for "human verified" and its like.
- **The audit log names both actors**: under Details, an entry with `approvedBy`,
  `proposedBy` or `proposalId` says "Approved by …", "Asked for by agent …" and "Carried
  out proposal …", the type and the id through `printable()`.

### Dismissing a proposal: not built

The ticket left open whether a person can dismiss a pending proposal. It was not built.
A dismissal is not a small addition here: it needs a status (or a decision column) the
closed list `PROPOSAL_STATUSES` does not have, which `tula approve` and `@tula/mcp` read;
a change to the two checks of the table (`proposals_status_known`,
`proposals_approval_whole`) in a new migration; a compare-and-set beside `approve`'s in
both adapters and the shared suite; an answer to who dismissed (an approver's type, and
whether an agent may withdraw its own); a `proposal.dismissed` event with its schema and
fixture; a refusal reason for approving a dismissed proposal; a conformance scenario and
its entry for every client. And what it would buy is small: a proposal that nobody
approves does nothing and is gone in ten minutes, and a person who wants an agent's
proposals ended now revokes its key, which ends all of them with no window. The screen
says both. A dismissal remains a decision of its own.

### Not verified

- The screen was run in Chromium against the real API in process on memory adapters (the
  `dashboard` Playwright project): one user, one agent key, `ban_user` and `unban_user`,
  a revoked key, the audit log, axe in light and dark. `end_session`,
  `disable_oauth_provider`, the failure reasons, the refusals other than a revoked key and
  the production typed confirmation are component tests in happy-dom against a fake API,
  which a test holds to the contract's schemas and to the service's order of refusals.
- No real MCP client made a proposal that the screen then showed; the browser test asks
  with the agent key over HTTP.
- Not run against PostgreSQL: no query, store method or route was added.
