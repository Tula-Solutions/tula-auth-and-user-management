# ADR 0009 — Server-driven sign-up and sign-in flows

- Status: accepted; partly superseded by [ADR 0019](0019-flow-engine-v2.md)
- Date: 2026-10-01

> **Superseded in part (ADR 0019).** An attempt is no longer identified by its id alone: every
> call after the start presents the attempt's secret. A sign-in start answers
> `needs_first_factor` when more than one method is enabled. `nextStatus` takes a context and
> can lead to `needs_second_factor`. A browser attempt is bound to an allowed origin. The rest
> of this record stands.

## Context

The API decides the next step of every sign-in and sign-up; clients only render it (business
plan §5.2). The flows must not reveal which email addresses have accounts, must not let anyone
claim an address they don't control, and must be safe when requests race.

## Decision

- **An attempt is a row** (`flow_attempts`) with a kind, the step it is waiting on, server-only
  state and a 10-minute lifetime. Unknown, foreign-environment, wrong-kind, completed and
  expired attempts all answer `flow.not_found`.
- **Transitions are one pure function** (`nextStatus`), table-tested. Phase 0:
  `sign_up: needs_email_verification → complete`;
  `sign_in: needs_password → complete`, or `→ needs_email_verification → complete` for a user
  whose email is not verified. An event that is not valid at the current step is
  `flow.invalid_step`.
- **Every step change is a compare-and-set** in the store (one guarded `UPDATE`), so of two
  racing requests only one completes an attempt and creates a session.
- **Sign-up creates the account only after the email is verified.** Until then the names and
  the argon2id hash of the password live in the attempt's state. They are dropped from it on
  completion; an attempt whose email could not be sent is deleted at once; and the server
  deletes every expired attempt on boot and every ten minutes (since
  [ADR 0017](0017-retention.md), as part of the retention job). Nobody can squat on an address
  they don't control.
- **Sign-up does not enumerate accounts.** If the address already has an account the response
  is identical. The owner is emailed a notice instead of a code, and the attempt is a *decoy*:
  it holds a real token whose code nobody was sent, so guesses, attempt counts and send limits
  behave exactly as for a new address. A decoy can never complete, even if its code is guessed.
  The password is hashed in both cases so they take the same time.
- **Sign-in does not enumerate accounts.** Starting a sign-in always answers `needs_password`
  and does not look the identifier up. The password step returns one error,
  `auth.invalid_credentials`, for an unknown identifier, a user with no password and a wrong
  password; unknown users still cost one argon2id verify. A ban is revealed only to someone who
  submitted the right password.
- **Limits.** Per IP on every route; a per-environment ceiling on the expensive steps;
  exponential lockout on failed passwords per identifier, keyed by a hash of the identifier so
  it follows the account across attempts and IPs; emails per address (ADR 0007). ADR 0011 has
  the full table.
- **Token delivery follows the client kind** given when the attempt starts (`x-tula-client`,
  default `web`): browsers get the refresh token as an httpOnly cookie, other clients in the
  body (ADR 0008).
- **Weak password hashes are upgraded** after a successful sign-in (`needsRehash`).
- **Failure ordering.** A code is sent before the attempt moves to `needs_email_verification`,
  so a refused send leaves the previous step retryable. An attempt is marked `complete` before
  its session is created (so two racing requests can't both create one); if session creation
  then fails, the client gets a 500 and signs in again. Recording the last sign-in time is
  best-effort and never discards issued tokens.

## Deviation from the plan

The plan lists email codes *and* magic links. Phase 0 ships **codes only**. With a link, the
device that started the attempt receives the session after the link is opened elsewhere, which
makes the attempt id a credential on its own; that needs the attempt bound to a client-held
secret first. The verification service already issues and verifies links (ADR 0007), so this is
a flow change only, planned for Phase 1.

## Consequences

- A sign-up for an existing address sends that owner an email. The per-address send limits
  (one a minute, five an hour) bound how much an attacker can use this to annoy someone.
- Two sign-ups for one new address can both be verified; the second gets `flow.invalid_step`
  and the account keeps the first password.
- Lockout is per identifier, so someone who keeps failing on purpose can make a known address
  wait before it can sign in with a password (ADR 0011 weighs this).
- Password change, admin reset and banning live in the user module (ADR 0010). A forgotten
  password is reset through a third flow kind, `password_reset` (ADR 0015).
- Anyone can use up an address's email allowance (one a minute, five an hour) by starting
  sign-ups for it. Until the hour passes, that address's own sign-up, resend, or the code an
  unverified user needs at sign-in is refused with `rate_limited`. This is the cost of bounding
  how much mail an attacker can make the server send to one person.
