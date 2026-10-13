---
paths:
  - "apps/api/src/modules/proposal/**"
  - "apps/api/src/middleware/secret-key*"
  - "apps/api/src/middleware/agent-key*"
  - "packages/cli/src/commands/approve*"
  - "packages/mcp/src/proposing*"
  - "apps/dashboard/src/features/proposals/**"
  - "packages/contract/src/proposal*"
---

# Agent keys and proposals

Moved here from `AGENTS.md`, word for word, and canonical for this area: `AGENTS.md` lists
this file under "Area rules" and does not repeat it. A section named in a sentence as
"above" or "below" is found through that list.

## Agent keys and proposals (`modules/proposal`, see ADR 0053)

An **agent key** (`tula_ak_<env>_…`) is an environment's key for an AI agent's tooling. A
**proposal** is a change an agent asked for that has not happened; an **approval** is a
human's answer to one ([GLOSSARY.md](../../GLOSSARY.md)). TULA-23 built the mechanism and one
operation, `ban_user`; TULA-39 added `unban_user`, `end_session` and
`disable_oauth_provider` and the production opt-in (ADR 0053, "The other reversible
operations"); TULA-40 added the dashboard's screen that approves ("Dashboard app"
below); TULA-24 and 41 extend it. A proposal cannot be dismissed, and adding that is a
decision in ADR 0053.

- **An agent key reads and proposes, and that is decided in the middleware, never in a
  route.** `secretKey()` accepts one for `GET` and `HEAD` only, and judges the method
  **before the key is looked up**: any other method with an agent key is the wrong key's
  `auth.invalid_key`, so no admin route has to remember to refuse an agent and a new one
  is refused by default. `agentKey()` (`~/middleware/agent-key`) guards `/v1/agent/*`,
  takes an agent key and nothing else (a secret key, a dashboard session and no key are
  the same 401), and that group has two routes, `POST /v1/agent/proposals` and
  `POST /v1/agent/sign-in-tests` ("Sign-in tests" below: the one thing an agent key does
  that changes live data, where the environment allows it). Never accept an
  agent key by a third path, never add a method to the agent's list, and never put another
  route that changes data under `/v1/agent/`. `agent-key.test.ts` walks the route table: every
  admin write refuses an agent key, by enumeration.
- **The actor is `agent` with the key's id** (`adminActor(c)` when `tenant.agent` is set).
  It is used for a proposal, for what a proposal carried out and for a sign-in test the
  agent's key ran ("Sign-in tests" below: the one thing an agent does without a human's
  approval, where the environment allows it), and for nothing else.
- **A proposal is an operation from a closed list and an id, and holds no text**
  (`PROPOSAL_OPERATIONS`, `PROPOSAL_OPERATION_TARGETS` in the contract; the table's shape
  checks). No reason, note or label from the agent is stored, shown by the server or put
  in an event: a sentence the model wrote, beside "approve?", is how an injected
  instruction reaches the one human in the loop. The summary is the server's own
  (`proposalSummary`, built from the operation and the id). A field for the agent's words
  is a decision in ADR 0053, not an addition.
- **A new operation is: an entry in the contract's two lists, a branch in the service's
  `execute` (never a string from the row looked up in a table of functions), an entry in
  `@tula/mcp`'s `PROPOSABLE` and a tool, a row in `tula approve`'s `CONSEQUENCES`** (a
  version that does not know an operation refuses to approve it), and its line in
  `docs/proposals.md`. Only what can be undone by an existing admin route is proposable
  until TULA-41 decides otherwise.
- **The operations are four, and what keeps another out is three rules**: an
  administrator can put it back with one call, it returns and sets no secret, and it acts
  on **one** thing named by one id. So never a proposal that deletes, resets a factor,
  revokes or makes a key, sets a password, writes a provider's credentials, switches a
  provider **on**, changes a setting, or acts in bulk. `@tula/mcp`'s `proposing.test.ts`
  hands the facade each of those by name, as a line that must not compile and as a call
  that is refused: a new operation is a row of ADR 0053's table first, and that test is
  never loosened to fit one.
- **An operation has one kind of target, and a session is ended by its own id**
  (`PROPOSAL_OPERATION_TARGETS`; the request schemas refuse a mismatch with a 422, on the
  proposal and on the approval). `end_session` with a user as its target is "every session
  of this user" under another name: never accept it, and never give `execute` a path into
  `Sessions.revokeForUser`. A provider is named by its name (`isProposalTargetId`; the
  table's `proposals_target_id_shape`), never by a row's id.
- **Switching a provider off is `OAuth.switchOff` and nothing else**: the row as it was
  read under the `sign_in_methods` lock, written back with `enabled: false`. Nothing of
  that write comes from a request; never let a proposal carry a client id, a secret or
  `enabled: true`. **The last way to sign in is judged twice by `OAuth.requireWayIn`, the
  function the provider route uses**: at the proposal, outside the lock, as a courtesy
  (the route's own 422), and at the approval inside the lock, which is what decides
  (`failed`, `last_sign_in_method`, the provider still on, the proposal spent). Never
  state that rule a second time, and never drop the one inside the lock because the
  first passed minutes ago. What is recorded is what the route records
  (`oauth_provider.updated`, `changed: ['enabled']`), **the weakening included, by the
  route's own rule** (ADR 0059): the accounts whose only way in the provider is are
  counted again under that lock (`countDependents`), judged by the contract's
  `oauthProviderWeakenings`, and where there are any the entry says `weakened: true` with
  `dependentAccounts`. A count that cannot be taken fails the operation (`error`, nothing
  written): never record the change on a guess, and never refuse it for the count.
  `tula approve` says the number in its question when it could read it (the read route,
  the operator's key, only for a provider that is on) and fixed words when it could not;
  never a guess, and never the read number after the approval.
- **A production environment accepts proposals only where `agents.proposalsInProduction`
  is on, and that is asked twice, past the settings cache** (`requireAccepted`,
  `Settings.get(…, true)`): when a proposal is made (`auth.forbidden`) and when one is
  approved (`resource.conflict`), both with `params.reason: 'production_environment'`,
  for every operation, a ban included. "Production" is the environment's own `kind`,
  never `ENVIRONMENT` and never `NODE_ENV`. The approval's refusal comes before anything
  is written, so the proposal is **not spent**: never move it after the compare-and-set.
  Switching the setting on is a weakening (`settingsWeakenings`), shared by the audit
  entry, the dashboard's question and `tula apply --yes`; left out of `tula.config.ts`
  it is `false` and managed, and the default is out of the config's fingerprint. An agent
  key cannot change it; `get_settings` returns it and `draft_settings_change` drafts it
  as a weakening, on purpose (ADR 0053 has the argument).
- **Creations are counted twice per environment, and both fail closed**:
  `PROPOSALS_PER_MINUTE` shared by every operation (what waits for a person at once) and
  `PROPOSALS_PER_OPERATION_PER_MINUTE` for each operation (one looping tool does not
  silence the others), the second mounted after the validator because the operation is in
  the body; its key holds the environment's id and the operation's word and nothing of
  the target. A new operation gets its count by being in the list: never a tool, an
  operation or a path that reaches `Proposals.create` past either. The four proposal
  scenarios make eight counted requests, against a live server inside one minute
  (`conformance/README.md`, "Proposals and the limit they share", has the count per
  scenario and per operation): a step that asks for another has to fit the ten, is added
  to that table, and is left to a route test where one shows the same. Never raise either
  limit for a scenario.
- **Approval is a human's credential and only that** (`PROPOSAL_APPROVER_TYPES`: `admin`,
  a secret key, and `instance_admin`, a dashboard session). The approve route is a `POST`
  under `/v1/admin/`, which the middleware already refuses to an agent key, and
  `Proposals.approve` refuses an `agent` actor again (`approverOf`). Keep both. Never add
  a way to approve that the holder of an agent key alone can reach, and never a tool,
  in `@tula/mcp` or anywhere a model's tooling runs, that approves.
- **An approval names what it approves.** The body repeats the operation and the target;
  the service compares it with the row before anything is written (`mismatch`), and carries
  out what the **row** holds. Never approve by id alone.
- **A proposal is single use because the approval is written first**: `ProposalStore.approve`
  is a compare-and-set on "still `pending` and not expired at `now`", together with the
  `proposal.approved` entry, and only the request that wrote it goes on to the operation.
  The second of two approvals at once, a later one and one past the expiry write nothing
  and run nothing (`already_decided`, `expired`: `PROPOSAL_APPROVAL_REFUSALS`, fixed words
  under `resource.conflict`). Never run the operation before that write, never give an
  approval back when the operation fails (`failed` is spent, with a fixed
  `failureReason`), and never retry an operation from a stored proposal. When even the
  outcome cannot be recorded the row stays `approved`, which nothing approves again, and
  an error line with fixed words is its trace.
- **The lifetime is `PROPOSAL_TTL_MS` (ten minutes), and expiry is derived, not stored**:
  `expired` is `pending` past `expiresAt`, said by `toProposal` and held by the store's
  compare-and-set. The database bounds a lifetime to an hour whatever the service says
  (`proposals_lifetime_bounds`). The runtime role updates only the decision's columns:
  never grant it `UPDATE` on `expires_at`, the operation or the target (a proposal could
  be revived or re-aimed), and keep the test of that in
  `adapters/postgres/proposals.test.ts`.
- **Revoking an agent key ends its pending proposals, and nothing is written to do it.**
  A pending proposal is live only while the key that asked is an unrevoked agent key of
  the proposal's own environment (`ProposalRecord.proposerActive`: computed at every read,
  never stored, absent from `NewProposalRecord`). So the revocation's own write, with its
  own `api_key.revoked` entry, is the end of them, with no window. It is read as
  `expired` with `expiryReason: 'agent_key_revoked'` (`PROPOSAL_EXPIRY_REASONS`; revoked
  wins over time), never as a new status. **The condition is in the store's `approve`
  statement, in both adapters**, beside "pending" and "not expired"; the service's look
  before it (`resource.conflict`, `reason: 'agent_key_revoked'`) is the first defence and
  never the only one, and Postgres takes `FOR SHARE` on the key's row in the approval's
  transaction. Never move the condition out of the statement, never store the end (the
  role has no `UPDATE` on `expires_at`, on purpose), and **write that subquery with the
  keys table aliased and the proposals table spelled out**: Drizzle writes bare column
  names in an `UPDATE`, and an unqualified `environment_id` there compared the key's
  column with itself (the store suite's "names another environment's agent key" row).
  What was approved before a revocation stays approved; a revocation undoes nothing.
- **`failed` has four words, and `incomplete` is a claim about the target**
  (`PROPOSAL_FAILURE_REASONS`). The service reads the target before the operation and
  again after a failure that is not `target_not_found` (`changeIsThere`): the operation's
  own write was not there and now is (`bannedAt` set) means `incomplete`; anything else,
  a failed read and a user who was already banned included, means `error`. Never
  report such a run as `executed`, never retry it, and keep `tula approve` saying what
  was done and what is left for a person (the user is banned; end their sessions with
  `DELETE /v1/admin/users/:userId/sessions`), with exit 1. A new operation says what its
  write looks like there, or gets `error`. The test makes the session sweep fail after
  the ban committed: a test that fails the ban's own write does not cover this.
- **The OpenAPI document says an agent key reads, in one place**: `documentAgentReads`
  (`~/openapi`) adds `agentKey` to every `get` under `/v1/admin/` that takes a secret
  key, when the document is built. Never write `agentKey` into a route's own `security`
  under `/v1/admin/`. `openapi.test.ts` holds that every admin read lists it and no admin
  write does, and the admin client's generator (`renderAdminApi`) stops for either.
- **What was done is the agent's entry and names the human**: `proposal.created` (agent),
  `proposal.approved` (the human, with `proposedBy`), then the operation's own entry
  (`user.banned`, actor `agent`, with `proposalId` and `approvedBy`) and
  `proposal.executed` or `proposal.failed` (agent, with `approvedBy`). `Users.ban` takes
  the proposal as its last argument for that, and so do `Users.unban`,
  `Sessions.revokeForProposal` (`session.revoked`, reason `revoked_by_admin`) and
  `OAuth.switchOff` (`oauth_provider.updated`); an operation that becomes proposable gains
  the same two optional fields in its event's schema, **with the refinement that they are
  there together or not at all** (`carriedOut` in the contract's `events.ts`), and nothing
  else: never a new activity type for a change an administrator's route already records. `approvedBy` is a
  type from the closed list and an id the server made. **The entries the agent is the
  actor of after an approval carry no IP address and no user agent**: the approving
  request's origin is the human's and is on `proposal.approved` alone (a test pins it).
- **Asking again is the same proposal** (`findPending`: same agent key, operation and
  target, still pending): no second row and no second entry.
- **An operation the server has no branch for fails, and runs nothing** (`run`'s default:
  `UnknownOperationError`, into the `error` path: `failed`, no `proposal.executed`). The
  database's check and the contract's list are what keep such a row out; the default is
  what holds when a newer version wrote one, or a list grew without its branch. Never
  make the default a no-op that ends `executed`.
- **What an approval found already so is said, with a boolean and nothing else**:
  `changed: false` in the approval's answer and on `proposal.executed`, when the
  operation ran and wrote nothing (a user who was not banned, a session that had ended, a
  provider that was off). **It is what the operation says of its own write, never the
  read `execute` makes before it** (`run` returns it: the session store's guarded update,
  the writing branch of `Users.liftBan` and of `OAuth.switchOff`): a target turned back
  between the read and the operation is really written to. An operation that does not
  say is `true`, and a ban is one: `Users.ban` ends sessions and writes its entry again.
  `changeIsThere` is for `incomplete` and nothing else. A new operation returns whether
  it wrote, from its write. `changed` is in the answer of the approval that
  carried the proposal out and nowhere else (not stored, absent from a later read): never
  add a column for it, and never a word, a reason or a "what it was" beside it.
- **`GET /v1/admin/sessions/:sessionId` reads one session by its id** (`Sessions.get`,
  `AdminSessionSchema`: the session list's shape, with `userId` and `active`), behind
  `secretKey()`, for the environment in scope: another environment's id and an unknown one
  are the same 404. It is what `tula approve` shows a session from. It returns no token,
  hash, family or thumbprint and must not gain one; it is not in `@tula/mcp`'s
  `READ_OPERATIONS`, and adding it there is a decision (a session's owner by its id).
- **No new error code.** The refusals are `auth.invalid_key`, `auth.forbidden`,
  `resource.not_found`, `resource.conflict` and `rate_limited` with fixed `params.reason`
  words from the contract: `@tula/core`'s message table holds every contract code and its
  bundle budget has no room for codes no client of it can receive.
- **`tula approve` prints before it asks and approves what it printed**: it reads the
  proposal and its target with the operator's secret key, prints the server's text through
  `printable()`, refuses an agent key before any request, refuses an operation it has no
  `CONSEQUENCES` row for, and sends the operation and target it showed. Exit 0 only when
  the operation was carried out.
  A provider is shown as it is now, in the CLI's own words for two booleans ("on now",
  "already off", "not configured now"). **A session is shown with whose it is and whether
  it is still live** (`describeSession`: `getSession`, then `getUser`; the owner's id,
  address and name, the client kind, when it was signed in, "live now" or "already
  ended"): an id alone gives a person nothing to check an agent's account against. The two
  reads touch neither the proposal nor the session; what could not be read is said in
  fixed words beside the bare id ("could not be read", "no such session now", "the user
  could not be read"), never guessed, and nothing of the failure's own text is printed.
  Of the device only the client kind is shown: never the user agent or the IP address
  (text and a value the session's holder chose). **Where the approval's answer says
  `changed: false` the command says that nothing changed** ("carried out; the session had
  already ended, so nothing changed"), never the consequence sentence: keep the tests of
  "a target that became so between the showing and the approval".
  `production_environment` is said as "nothing
  changed, not spent" and `last_sign_in_method` as "approved, nothing changed, the
  provider still on, spent", both with exit 1.
- **`tula approve` runs at a terminal or not at all, and nothing answers its question
  for it** (ADR 0053, "An approval cannot be scripted"). Where `io.isTTY` (standard input
  and standard error both a terminal; injected, never `process.stdin.isTTY` in a command)
  is not true, or there is nothing to ask through, it refuses with one fixed sentence
  **before the key is resolved and before any request**, whatever the options. It has no
  `--yes` and gets none, under any name: an unknown option is refused by the parser before
  the command runs, and `--json` still asks (the proposal then printed on standard
  error). `--secret-key-file -` is refused: standard input is where the answer is typed.
  The question names the operation and the target through `printable()` and takes the
  typed word `yes`, nothing shorter. `tula apply`'s `--yes` is another command's and is
  unchanged. Keep the tests of each ("not at a terminal", "there is no option that
  answers the question"), and **never word this as stopping an agent that can type at a
  terminal**: one that drives a pseudo-terminal on the operator's machine still can. What
  holds is that an agent key cannot approve and the operator's key is not the agent's.
  The cost, said in `docs/cli.md`: no approval from a script or CI.
- **The injection corpus is one list** (`packages/mcp/src/testing/injection.ts`: its
  invisible characters written as `\u{…}` escapes), used by `@tula/mcp`'s tests (every
  string in every field every propose tool's answer has: the result is the projection,
  cleaned and capped, or `response.invalid`) and by `tula mcp`'s against the real API
  (every string in a user's name and a session's user agent: the users, sessions,
  providers and settings byte for byte unchanged, nothing recorded but
  `proposal.created`). A new propose tool is run by both because both iterate
  `PROPOSE_TOOL_NAMES`; a new kind of hostile text is a row of the list. **A propose tool
  refuses an answer that is not the proposal it asked for** (`ask` in `tools.ts`:
  `response.invalid`); never project a proposal without that comparison. What these tests
  show is that a proposal alone makes no change: nothing changes without an approval; never word them as showing
  what a model does.
- **What approval proves is that a credential the agent's tools do not hold was used, not
  that a person looked.** An assistant with a shell on a machine whose `.env.local` holds
  the secret key can call the admin API with it, or run `tula approve` under a
  pseudo-terminal and type the answer. ADR 0053, `docs/proposals.md` and
  `docs/cli.md` say so; never word approval as "human verified", and never present the
  residual as closed. No real MCP client has been connected to either server
  (`docs/plans/phase-2-unverified.md`, "Step 2.17"): do not describe how a client shows a
  proposal until one has.
