# Proposals: letting an AI agent ask for a change

An assistant connected through [`tula mcp`](mcp.md) can read an environment. With an
**agent key** it can also **ask** for a change: it records a *proposal*, and nothing
happens until a person approves it with a credential the assistant does not have. The
design is in [ADR 0051](adr/0051-proposals.md).

Today there is one thing an agent can propose: **banning a user**. A production
environment accepts no proposal yet.

## The two credentials

| | Agent key (`tula_ak_…`) | Secret key (`tula_sk_…`) |
| --- | --- | --- |
| Who holds it | The assistant's MCP server | You, and your servers |
| Reads the admin API | Yes: everything a secret key reads | Yes |
| Changes anything | **No**: every write is `401 auth.invalid_key` | Yes |
| Asks for a change (`POST /v1/agent/proposals`) | Yes | No: a person makes a change, an agent asks for one |
| Approves a proposal | **No** | Yes (and so does a dashboard session) |

Make an agent key where you make any key: the dashboard's **API keys** screen (kind
*Agent*), `POST /v1/admin/api-keys` with `"kind": "agent"`, or, in this repository,
`bun run api-key:create --environment <id> --kind agent`. It is shown once. Revoke it like
any key; its pending proposals can still be approved by you, and it can make no more.

An agent key reads your users' names, email addresses and IP addresses. Give it only to an
assistant you would show the dashboard to.

## How a change happens

1. **The assistant asks.** Its tool `propose_ban_user` records a proposal and answers its
   id, a summary of what approving it does, and when it expires. The user is untouched.
2. **You look and approve**, within ten minutes:

   ```sh
   tula approve 0199c2f4-7a10-7c3e-9b1a-5d2e8f4a6c01
   ```

   `tula approve` reads the proposal and the user with **your** secret key, prints what
   would happen and to whom, and asks. See [the command](cli.md#tula-approve).
3. **The server carries it out**, at once, and records it: the ban's audit entry has the
   agent as its actor, the proposal's id, and you as the one who approved.

Over HTTP the approval is `POST /v1/admin/proposals/<id>/approve` with a secret key and a
body that repeats what you are approving:

```json
{ "operation": "ban_user", "target": { "type": "user", "id": "0199c2f4-…" } }
```

The server refuses the approval (`409 resource.conflict`, `params.reason: "mismatch"`) when
that is not what the proposal says, so an approval cannot be spent on a proposal other than
the one you were shown. `GET /v1/admin/proposals` lists an environment's proposals, newest
first, and `GET /v1/admin/proposals/<id>` reads one.

## The rules

- **A proposal expires ten minutes after it was made** and can then never be approved
  (`reason: "expired"`). The assistant can ask again.
- **A proposal is approved once** (`reason: "already_decided"`), also when what it asked
  for could not be carried out (the user was deleted meanwhile: the proposal is `failed`,
  and spent).
- **A proposal says exactly one thing**: an operation from a closed list and the id of what
  it acts on. It has no free text. Its summary is the server's own sentence; whatever
  reason the assistant gives you is in your conversation with it, and is a claim to weigh,
  not part of the proposal.
- **Asking twice is one proposal**: the same agent key asking for the same thing while a
  proposal is pending gets that proposal back.
- **At most ten proposals a minute** per environment.
- **Production environments refuse** (`403 auth.forbidden`,
  `params.reason: "production_environment"`).
- **Only what can be undone**: a ban is lifted with `POST /v1/admin/users/<id>/unban` or in
  the dashboard.

A proposal's `status` is `pending`, `expired`, `approved` (approved, the operation not
finished), `executed` or `failed` (with `failureReason`: `target_not_found` or `error`).

## What is recorded

Every step is in the environment's audit log (and is an event a
[webhook](webhooks.md) delivers):

| Entry | Actor | Says |
| --- | --- | --- |
| `proposal.created` | the agent (its key's id) | the operation and the target |
| `proposal.approved` | you (the secret key's id, or the dashboard session's) | the same, and which agent asked |
| `user.banned` | the agent | `proposalId`, and `approvedBy` |
| `proposal.executed` or `proposal.failed` | the agent | `approvedBy`, and for a failure why |

So `actorType=agent` in the audit log is everything agents asked for and everything that
was done on their asking, each with the person who allowed it.

A proposal is deleted thirty days after its expiry, approved or not; its audit entries
stay for as long as the environment keeps audit entries.

## What approval does not protect against

Approval means **a credential the agent's tools do not hold was used**. Keep it that way:

- **Do not give the assistant's MCP server a secret key.** With `TULA_AGENT_KEY` set,
  `tula mcp` does not read `TULA_SECRET_KEY` at all, and says so if one is set.
- **A coding assistant with a shell can use whatever is on the machine.** `tula` reads
  `.env.local`, where `tula dev` writes a development secret key. An assistant that can run
  commands in that directory can run `tula approve --yes` itself. On a development
  environment that is a ban of a test user; it is still not an approval by you. Where it
  matters, keep the secret key out of reach of the assistant: another machine, a secret
  store that asks you, or approve in a place the assistant is not signed in to.
- **`--yes` approves without a question.** It is for a terminal you are not at; nobody has
  read the proposal then.
- **The assistant's account of why is not checked by anything.** Read the user yourself;
  `tula approve` shows the account's address and name for that.

How an MCP client shows a proposal to you, and whether a model reliably reports "proposed"
rather than "done", has not been observed with a real client
([what is unverified](plans/phase-2-unverified.md)).
