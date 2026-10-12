# ADR 0051 — Proposals: an agent asks, a person approves

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
| `agentKey()`, on `/v1/agent/*` | The one route of the group, `POST /v1/agent/proposals`. A secret key, a publishable key and a dashboard session are `401 auth.invalid_key` here. |

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
`HEAD` refuses an agent key, with the one exception named there, and every admin `GET`
serves it. A new write route is covered without anyone remembering to add it.

**What an agent key reads is everything a secret key reads**, API keys' names and last four
characters and users' email addresses and IP addresses among them. That is personal data
going to a model, exactly as with a secret key behind the read-only facade; the tools
return an allow-list of it (ADR 0033), the key does not narrow it. Narrower read scopes
are not built.

### A proposal

`POST /v1/agent/proposals` takes `{ operation, target: { type, id } }` and nothing else, and
answers a **proposal**: a row of `proposals` (tenant columns, row-level security) with

- the **operation**, from the closed list `PROPOSAL_OPERATIONS` (`ban_user`), and the
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
- **A production environment accepts none** (`403 auth.forbidden`,
  `params.reason: 'production_environment'`). The plan lets an environment opt in; that
  setting is TULA-39 and is not built, so today the answer is always no. Decided before the
  target is read.
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
  The runtime role may update only the columns a decision writes (column-level grants), and
  a check holds the approver's type, id slot and time together.
- **Then the operation, by the server, as the agent.** `Users.ban` is called with the agent
  as its actor and the proposal beside it: `user.banned` carries `proposalId` and
  `approvedBy`. The ban is the same function an administrator's ban is (sessions ended,
  denylisted). Then the proposal is finished: `executed`, or `failed` with a fixed word
  (`target_not_found`: the user was deleted meanwhile; `error`), recorded as
  `proposal.executed` / `proposal.failed` (actor the agent, `approvedBy` in the data).
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

One tool, `propose_ban_user` (`{ userId }`, strict). It answers the projected proposal
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
Not at a terminal it needs `--yes`. The question is asked with a sentence of the CLI's own
per operation: an operation this version does not know is not approved. An agent key is
refused before any request.

## What this does and does not prove

- **It proves a credential was used that the agent's tools do not have.** It does not prove
  a person looked. `tula approve --yes` in a script approves unread, and so does any program
  that calls the route with a secret key.
- **A coding assistant with a shell is not separated from the secret key by this.** Bun
  loads `.env.local` for `tula`; an assistant that can run commands in a project whose
  `.env.local` holds the development secret key can run `tula approve --yes` itself, or
  call the admin API directly. The MCP server not *using* the secret key does not take it
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
  asks for this before the feature ships.
- The scenario and the tests run on a development environment; nothing was run against a
  deployed server.

## Not decided here

- Production: the per-environment opt-in (TULA-39).
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

## Where an entry says a request came from (added in review)

An audit entry holds the IP address and the user agent of the request behind it. The
operation of an approved proposal runs inside the **approver's** request, with the agent
as its actor. Its entries (`user.banned`, `proposal.executed`, `proposal.failed`) therefore
hold no address and no user agent: the first version copied the approver's onto them,
which put a person's address under an agent's id and two origins under one actor. The
approver's origin is on `proposal.approved`, the agent's own on `proposal.created`.
