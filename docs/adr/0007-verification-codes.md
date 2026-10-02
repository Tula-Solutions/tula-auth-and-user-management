# ADR 0007 — Email verification codes and magic links

- Status: accepted
- Date: 2026-10-01

## Context

Sign-up and password reset prove control of an email address with a 6-digit code, optionally a
magic link. A 6-digit code has only 10^6 values, so both its storage and the number of guesses
need care. The module is a service (`modules/verification`) that the flow engine calls; it has
no routes of its own.

## Decision

- **Codes are stored as a keyed hash:** `HMAC-SHA256(key, "<token id>:<code>")` via
  `~/lib/keyed-hash`, with the key derived from `TULA_MASTER_KEY` by HKDF for the
  `verification-codes` purpose. A plain SHA-256 of 10^6 values is reversed instantly by anyone
  who can read a row; binding the token id stops a hash being replayed onto another row.
- **Link tokens are 256-bit random values stored as SHA-256.** They need no attempt counter.
- **Codes come from the CSPRNG with rejection sampling** (`randomDigits`), so digits are uniform.
- **10-minute TTL, 5 attempts.** The guess is counted with one guarded `UPDATE` *before* the
  code is compared, so concurrent guesses can never exceed the limit between them. The same
  behaviour suite runs against the memory and Postgres stores.
- **Single use, newest only.** Verifying consumes the token; issuing a new code consumes earlier
  ones for the same subject and purpose in the same transaction. Using the link also ends the
  code, and the reverse. Codes and links are honoured only for the newest token of a subject, so
  two concurrent issues can never leave an older link usable.
- **Send, then store.** The email goes out before the token is stored, so a relay failure leaves
  the previous code working. A failed send still counts against the send limits.
- **One generic failure.** Unknown, used, replaced, expired, foreign-environment and
  wrong-purpose tokens all report `verification.expired`. Only a wrong guess on a live token
  reports `verification.invalid_code` (with `attemptsRemaining`), and an exhausted one
  `verification.too_many_attempts`.
- **Send limits per destination and environment:** one email per minute and five per hour, keyed
  by a hash of the normalized address. This bounds inbox flooding and how many fresh codes an
  attacker can request to guess at (5 codes x 5 guesses per hour against 10^6 values).
- **Email goes through a `Mailer` port:** SMTP (nodemailer) in every tier, pointed at Mailpit
  locally; live tiers must set a real relay and `MAIL_FROM`. A relay failure is a 500; only the
  error name, code and SMTP status are logged, because relay messages quote the recipient.
- **The magic-link URL is supplied by the caller** (`linkUrl`), because the route that accepts
  the link belongs to the flow that issued it. Without it, only a code is sent.

## Consequences

- Rotating `TULA_MASTER_KEY` invalidates outstanding codes (they expire in 10 minutes anyway).
- Rate-limit counters are in process memory in Phase 0, so limits are per instance until the
  Redis adapter lands (Phase 1).
- Emails are plain and unbranded for now; per-project templates arrive with the dashboard.
