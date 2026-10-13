---
'@tula/contract': minor
'@tula/admin': minor
'@tula/cli': minor
---

`tula approve` shows a session with whose it is and whether it is still live, and says
when an approval found nothing left to change.

- **A session in the question.** For `end_session` the command reads the session and its
  user with the operator's key and prints the owner's id, address and name, the kind of
  client, when the session was signed in and "live now" or "already ended". A read that
  fails is said in fixed words beside the id ("could not be read", "no such session now")
  and is never guessed. The user agent and the IP address are not printed.
- **`GET /v1/admin/sessions/{sessionId}`** (`getSession` in `@tula/admin`) reads one
  session of an environment by its id: the session list's shape with `userId` and `active`
  (`AdminSessionSchema` / `AdminSession` in `@tula/contract`). An unknown id and another
  environment's are the same 404.
- **`changed` on an approval's answer.** `ProposalSchema` gains an optional boolean,
  present only in the answer to the approval that carried the proposal out, and
  `proposal.executed` gains the same field: `false` when the operation ran and found the
  target already so (the session had ended, the user was not banned, the provider was
  off). `tula approve` then prints "carried out; … so nothing changed" in place of the
  sentence that describes the change, and still exits 0. A later read of the proposal does
  not carry the field.

A stored proposal whose operation the server has no branch for is now `failed` with
`error` when it is approved; it was recorded as carried out.
