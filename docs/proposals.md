# Proposals: letting an AI agent ask for a change

An assistant connected through [`tula mcp`](mcp.md) can read an environment. With an
**agent key** it can also **ask** for a change: it records a *proposal*, and nothing
happens until a person approves it with a credential the assistant does not have. The
design is in [ADR 0053](adr/0053-proposals.md).

An agent can propose four things, each of which an administrator can put back with one
call:

| Operation | What approving it does | Put back with |
| --- | --- | --- |
| `ban_user` | Bans one user: their sessions end and they cannot sign in. | Lifting the ban. |
| `unban_user` | Lifts one user's ban. Sessions that were ended stay ended. | Banning them again. |
| `end_session` | Ends **one** session, named by its id. | The user signing in again. |
| `disable_oauth_provider` | Switches **one** provider off (`enabled: false`). Its credentials are kept. | Switching it on again (`PUT /v1/admin/oauth-providers/<provider>`, or the dashboard). |

Nothing else can be proposed: nothing that cannot be undone (deleting a user, removing a
provider, resetting two-step verification, revoking a key), nothing that returns or sets
a secret (a key, a password, a provider's credentials), nothing that opens a way in
(switching a provider on, changing a setting), and nothing in bulk (there is no proposal
for every session of a user).

A **production environment refuses every proposal unless it opted in**:
[see below](#production-environments).

## The two credentials

| | Agent key (`tula_ak_…`) | Secret key (`tula_sk_…`) |
| --- | --- | --- |
| Who holds it | The assistant's MCP server | You, and your servers |
| Reads the admin API | Yes: everything a secret key reads | Yes |
| Changes anything | **No**: every write of the admin API is `401 auth.invalid_key`. One exception, off in production by default: it can run a [sign-in test](mcp.md#the-sign-in-test), which makes a throwaway user and deletes it | Yes |
| Asks for a change (`POST /v1/agent/proposals`) | Yes | No: a person makes a change, an agent asks for one |
| Approves a proposal | **No** | Yes (and so does a dashboard session) |

Make an agent key where you make any key: the dashboard's **API keys** screen (kind
*Agent*), `POST /v1/admin/api-keys` with `"kind": "agent"`, or, in this repository,
`bun run api-key:create --environment <id> --kind agent`. It is shown once. Revoke it like
any key: it can make no more proposals, and **what it asked for and nobody approved ends
with it** (see [the rules](#the-rules)).

An agent key reads your users' names, email addresses and IP addresses. Give it only to an
assistant you would show the dashboard to.

## How a change happens

1. **The assistant asks.** A propose tool (`propose_ban_user`, `propose_unban_user`,
   `propose_end_session`, `propose_disable_oauth_provider`) records a proposal and answers
   its id, a summary of what approving it does, and when it expires. Nothing is changed.
2. **You look and approve**, within ten minutes:

   ```sh
   tula approve 0199c2f4-7a10-7c3e-9b1a-5d2e8f4a6c01
   ```

   `tula approve` reads the proposal, and the user, the session or the provider it is
   about, with **your** secret key, prints what would happen and to what, and asks. A
   session is shown with whose it is and whether it is still live: an assistant's account
   of "a stale session" is a claim, and this is what you check it against. You type `yes`, at
   a terminal: the command has no option that answers for you and refuses to run without
   one. See [the command](cli.md#tula-approve).
3. **The server carries it out**, at once, and records it: the change's own audit entry
   (`user.banned`, `user.unbanned`, `session.revoked`, `oauth_provider.updated`) has the
   agent as its actor, the proposal's id, and you as the one who approved.

Over HTTP the approval is `POST /v1/admin/proposals/<id>/approve` with a secret key and a
body that repeats what you are approving:

```json
{ "operation": "ban_user", "target": { "type": "user", "id": "0199c2f4-…" } }
```

The server refuses the approval (`409 resource.conflict`, `params.reason: "mismatch"`) when
that is not what the proposal says, so an approval cannot be spent on a proposal other than
the one you were shown. The target of `end_session` is `{ "type": "session", "id": "<session id>" }`
and of `disable_oauth_provider` `{ "type": "oauth_provider", "id": "google" }` (the
provider's name); an operation with another kind of target is a 422. `GET /v1/admin/proposals` lists an environment's proposals, newest
first, and `GET /v1/admin/proposals/<id>` reads one.

## The rules

- **A proposal expires ten minutes after it was made** and can then never be approved
  (`reason: "expired"`). The assistant can ask again.
- **A proposal is approved once** (`reason: "already_decided"`), also when what it asked
  for could not be carried out (the user was deleted meanwhile: the proposal is `failed`,
  and spent).
- **An approval that found nothing left to change says so.** A proposal for what is
  already so is taken, and approving it is `executed`: the session had ended, the user was
  not banned, the provider was already off. The answer to that approval then carries
  `changed: false`, the `proposal.executed` audit entry says the same, the operation's own
  entry (`session.revoked`, …) is not written, and `tula approve` says that nothing
  changed. `changed` is in the answer to the approval only: a later read of the proposal
  does not have it. Banning a user who is already banned is a change (`changed: true`):
  their sessions are ended and `user.banned` is recorded again.
- **A proposal says exactly one thing**: an operation from a closed list and the id of what
  it acts on. It has no free text. Its summary is the server's own sentence; whatever
  reason the assistant gives you is in your conversation with it, and is a claim to weigh,
  not part of the proposal.
- **Revoking the agent key ends its pending proposals**, in the same write: there is no
  moment at which the key is revoked and a proposal of it can still be approved. Such a
  proposal reads as `expired` with `expiryReason: "agent_key_revoked"`, and approving it is
  refused (`409 resource.conflict`, `params.reason: "agent_key_revoked"`). It does not come
  back: a new key asks again. What was approved before the revocation stays approved and
  carried out; revoking a key undoes nothing.
- **Asking twice is one proposal**: the same agent key asking for the same thing while a
  proposal is pending gets that proposal back.
- **At most ten proposals a minute** per environment, and **at most five a minute of any
  one operation**. Beyond either the answer is `rate_limited`; when the limiter cannot
  count, `service.unavailable`. Nothing is recorded for a refused request.
- **Production environments refuse unless they opted in** (`403 auth.forbidden`,
  `params.reason: "production_environment"`): [below](#production-environments).
- **Only what can be undone**, one thing at a time: the table at the top says how each is
  put back.
- **Switching a provider off never removes the last way to sign in.** It is refused when
  it is proposed (the `422 validation.failed` the provider route itself answers), and
  judged again when the proposal is approved, by the same rule and under the same lock as
  an administrator's own change: a proposal that was fine when it was made and is approved
  after the other ways went is `failed` with `failureReason: "last_sign_in_method"`. The
  provider is still on, and the proposal is spent.

A proposal's `status` is `pending`, `expired` (with `expiryReason`: `time`, or
`agent_key_revoked`), `approved` (approved, the operation not finished), `executed` or
`failed` (with `failureReason`: `target_not_found`, `last_sign_in_method`, `error` or
`incomplete`).

### Production environments

A production environment (one whose own kind is `production`) accepts proposals only where
its settings say so: **`agents.proposalsInProduction`**, `false` by default. Every other
environment accepts them whatever the setting says.

- Switch it on in the dashboard (**Settings**, "AI agents"), with `PUT /v1/admin/settings`,
  or in `tula.config.ts` (`settings: { agents: { proposalsInProduction: true } }`,
  [config.md](config.md)).
- **Switching it on is recorded as a weakening**: the audit entry of the settings change
  names `agents.proposalsInProduction` and says `weakened: true`, the dashboard asks
  first, and `tula apply --yes` needs `--allow-weaker`. Switching it off is an ordinary
  change.
- **It is asked twice.** A proposal is refused when it is made (`403 auth.forbidden`), and
  again when it is approved (`409 resource.conflict`, both with
  `params.reason: "production_environment"`): switch the setting off and what agents asked
  for and nobody approved yet is not carried out. Such a proposal is **not spent**: switch
  the setting on again before it expires and it can be approved. Both checks read the
  setting as it is saved, not a cached copy.
- An agent key cannot change the setting (no admin write takes one). Through `tula mcp` an
  assistant can read it and can draft the edit to your config file
  ([`draft_settings_change`](mcp.md)), which is flagged as a weakening and applied by you.

What it means to switch it on: an assistant that holds an agent key of your production
environment can put a ban, the lifting of a ban, the end of a session or the switching off
of a provider in front of whoever approves. The change is still only made by an approval;
[what approval does not protect against](#what-approval-does-not-protect-against) applies
to production with more at stake.

### A ban that was only half carried out

Banning a user is two things: the account is marked as banned, and its sessions are ended.
If the first is done and the second fails (the store behind the revoked-session list did
not answer), the proposal is `failed` with `failureReason: "incomplete"`, and that word
means exactly this: **the user is banned and can no longer sign in, and sessions of theirs
may still be live** (a banned user's refresh is refused, so they end, but not at once).
Nothing is tried again by
itself and the proposal cannot be approved a second time. End the sessions yourself:
`DELETE /v1/admin/users/<id>/sessions` with a secret key, or the user's page in the
dashboard. `tula approve` says so and exits 1. `error` means the server could not tell
that anything was changed; read the user to be sure.

## What is recorded

Every step is in the environment's audit log (and is an event a
[webhook](webhooks.md) delivers):

| Entry | Actor | Says |
| --- | --- | --- |
| `proposal.created` | the agent (its key's id) | the operation and the target |
| `proposal.approved` | you (the secret key's id, or the dashboard session's) | the same, and which agent asked |
| `user.banned`, `user.unbanned`, `session.revoked` (reason `revoked_by_admin`) or `oauth_provider.updated` (`changed: ["enabled"]`) | the agent | `proposalId`, and `approvedBy` |
| `proposal.executed` or `proposal.failed` | the agent | `approvedBy`, and for a failure why |

So `actorType=agent` in the audit log is everything agents asked for and everything that
was done on their asking, each with the person who allowed it.

A proposal is deleted thirty days after its expiry, approved or not; its audit entries
stay for as long as the environment keeps audit entries.

## What approval does not protect against

Approval means **a credential the agent's tools do not hold was used**. It does not mean
that a person looked: the server sees a key, not who typed. An assistant that has a shell
and finds the secret key in its environment, or in a file it can read, can approve its own
proposal. Keep the two apart:

- **Do not give the assistant's MCP server a secret key.** With `TULA_AGENT_KEY` set,
  `tula mcp` does not read `TULA_SECRET_KEY` at all, and says so if one is set.
- **A coding assistant with a shell can use whatever is on the machine.** `tula` reads
  `.env.local`, where `tula dev` writes a development secret key. An assistant that can run
  commands in that directory can call the admin API with that key. `tula approve` refuses
  to run without a terminal, so one command in a shell tool no longer does it, but an
  assistant that can drive a terminal (a pseudo-terminal, a desktop it controls) can
  still type the answer. On a development
  environment that is a ban of a test user; it is still not an approval by you. Where it
  matters, keep the secret key out of reach of the assistant: another machine, a secret
  store that asks you, or approve in a place the assistant is not signed in to.
- **Nothing approves unattended through `tula approve`.** There is no `--yes`, and no
  approval from a script or from CI. A program that calls the admin API's approve route
  with a secret key does approve, and nobody has read the proposal then.
- **The assistant's account of why is not checked by anything.** Read the user yourself;
  `tula approve` shows the account's address and name for that.

How an MCP client shows a proposal to you, and whether a model reliably reports "proposed"
rather than "done", has not been observed with a real client
([what is unverified](plans/phase-2-unverified.md)).
