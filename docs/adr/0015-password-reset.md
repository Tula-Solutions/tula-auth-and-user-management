# ADR 0015 — Self-service password reset

- Status: accepted
- Date: 2026-10-03

## Context

Phase 0 shipped without a way for a user to replace a forgotten password; only an administrator
could set one. A reset is the most direct route into an account, so it must not reveal which
addresses have accounts, must not leave a credential lying in a URL, and must end whatever
access the old password gave.

## Decision

- **A reset is a flow attempt** of a third kind, `password_reset`, with one waiting step,
  `needs_new_password`, and the same 10-minute lifetime, compare-and-set completion and
  `flow.not_found` rules as sign-in and sign-up (ADR 0009).
  - `POST /v1/client/password-resets` `{ email }` emails a 6-digit code.
  - `POST /v1/client/password-resets/:id/password` `{ code, password }` finishes it.
  - `POST /v1/client/password-resets/:id/resend-code` sends a fresh code.
- **The code and the new password travel in one request.** A two-step design (verify the code,
  then set the password) would make a verified attempt id a 10-minute credential that sits in a
  URL path, and paths are logged. With one request nothing but the emailed code ever authorizes
  the change.
- **Starting a reset does not enumerate accounts.** An address with no account gets the same
  response and is emailed a notice ("there is no account for this address") instead of a code.
  Its attempt is a decoy holding a real token whose code nobody was sent, so guesses, attempt
  counts, resends and send limits behave the same, and it can never complete even if the code is
  guessed. Both paths do one lookup and send one email.
- **The code is the verification service's** (ADR 0007) with purpose `password_reset`: stored as
  a keyed hash bound to the token id, five guesses, ten minutes, one email a minute and five an
  hour per address. A code issued for verifying an address cannot reset a password, and the
  reverse.
- **The code is spent only once the new password has passed the policy**, and before the
  password is stored. A rejected password uses one of the five guesses but the user can try
  another; of two racing requests with the same code only one stores a password. The policy
  check uses the account's names as well as the address, and happens only after the right code,
  so it tells a stranger nothing.
- **Completing a reset**, in this order: check the policy and hash the new password; spend the
  code; end every session of the user (their access tokens are denylisted); store the password
  with its `user.password_changed` entry (`method: reset`, the user as actor); end sessions once
  more, to catch a sign-in with the old password that landed between the first sweep and the
  store; clear the sign-in lockout; mark the email verified if it was not (the code proved control of it); sign the user
  in on the requesting device. Sessions end before the password is stored so that a failure
  midway can never leave a new password with the old sessions alive. A failure after the code
  is spent means starting a new reset (if the first sweep itself fails, the sessions' access
  tokens may already be denylisted while their rows remain: the safe direction); clearing the lockout and marking the email verified are
  best-effort and never fail a reset whose password is already stored.
- **A code proves control of the address it was sent to**, not of the account: if the account's
  address is no longer the one the attempt started with, the reset is refused like a wrong code.
- **A banned user** is sent a code like anyone else and gets `auth.user_banned` only after
  presenting the right one; the password is not changed.
- **Limits**: starting a reset and resending share the sign-up per-IP limit (10 a minute) and
  have their own per-environment ceiling (600 a minute); submitting uses the credential per-IP
  limit (30 a minute) and the verify ceiling (ADR 0011).

## Consequences

- If the second session sweep fails, the request errors with the password already changed and
  the code spent. A session started with the old password in the instant between the first
  sweep and the store would then outlive the reset until the next one; it takes that failure and
  that sign-in together. The user's new password works, and a fresh reset sweeps again.
- An address with no account can be sent a notice by anyone, bounded by the per-address send
  limits. Sign-up already lets anyone send a code to any address, so this adds no new reach.
- Reset, verification and sign-up emails share one per-address allowance, so a burst of one
  kind can delay another for up to an hour (ADR 0009 weighs this).
- When second factors arrive (Phase 1), a reset must lead to `needs_second_factor` rather than
  straight to `complete`: an inbox alone must not bypass MFA. The transition table is where that
  changes.
- There is no "your password was changed" notification email yet. Phase 1 adds security
  notifications.
- Users without a password credential cannot reset one into existence: `setPasswordHash`
  replaces, it does not create. Phase 1's passwordless users need that decided.
  *Decided in [ADR 0019](0019-flow-engine-v2.md):* a reset now creates the first password, and
  a reset by a user with a second factor leads to `needs_second_factor` instead of a session.
