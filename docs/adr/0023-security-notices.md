# ADR 0023 — Security notice emails

- Status: accepted
- Date: 2026-10-03

## Context

An account could be taken over without its owner hearing of it. A changed password, a completed
reset and a sign-in from somewhere new all left an audit entry (ADR 0012) that only an operator
reads; the owner was told nothing. `<UserProfile>` (ADR 0022) now gives users a place to act
(change the password, sign other devices out), so they need to be told when to look.

Three things constrain the design:

- A notice describes something that has already happened. It must never be the reason that
  thing fails or takes longer.
- There is no device binding yet (Phase 2). All the server knows about where a session came
  from is the client kind, the `User-Agent` header and the IP address, and the header is text
  the client chose.
- Emails are already rate limited per address for codes (ADR 0007). Notices must not become a
  way around those limits, nor use them up.

## Decision

### Two notices

| Notice | Subject | Sent after |
| --- | --- | --- |
| Password changed | `Your <App> password was changed`, or `A password was added to your <App> account` for an account's first password | a password is stored: by the signed-in user (`Users.changePassword`), by a completed reset (`Flows.resetPassword`), or by an administrator (`Users.setPassword`) |
| New sign-in | `New sign-in to your <App> account` | a sign-in completes on a device family the account has not been seen on |

Both go to the account's address, in the one layout of `modules/email` (ADR 0018), and name the
app. The password notice says in plain words which of the three happened, and when (UTC). The
sign-in notice gives the device family, the time (UTC) and the IP address. Both say what to do
if it was not the reader: open the app and reset the password from the sign-in screen; when the
environment has a support address, to write there if they cannot get back in.

**No third notice for "a password reset was requested".** That request already sends an email
to the address (the code, or the no-account notice), which is the notice.

**A notice carries nothing that acts on the account**: no code, no token and no link. The
server cannot build a reliable URL to an app's sign-in screen yet, and a security email that
trains people to click links is worse than one that says "open the app". The subject never
starts with digits, so nothing that reads a code from a subject (`^(\d{6})\b`: the conformance
runner, the test fixtures) can take a notice for a code email. Those readers now pick the newest
email *whose subject leads with a code*, not simply the newest email.

### What "a new device" means

There is no device identity, so the definition is deliberately small and explainable:

> A sign-in is from a new device when the **device family** of the session it created is not the
> family of any session of the same user that **began before it** and is still in the session
> table, active or ended.

- **The device family** comes from one function, `deviceFamily(client, userAgent)` in
  `apps/api/src/lib/device.ts`: the browser and operating system the user agent mentions
  (`Chrome on Windows`, `Safari on iPhone`), with no version numbers, or the platform for a
  native client (`iOS app`, `Android app`), or `Unknown device`. The names are the ones
  `<UserProfile>` shows in the device list. The result is always assembled from fixed names; the
  user agent is only matched against fixed patterns, so nothing a client sends reaches an email.
- **"Began before it"** is by creation time and then id, so of two sign-ins that race from the
  same new device exactly one is announced, rather than each seeing the other and neither.
- **An account with no earlier session gets no notice.** That covers the first-ever sign-in of
  an account an administrator created.
- **Only a sign-in is announced.** The session a sign-up ends in belongs to someone who has just
  proven the address. The session a password reset ends in is announced by the password notice;
  a second email about the same event would say less.
- Ended sessions count for as long as they are kept: 30 days after they ended (ADR 0017).
- **A session bound to a device key is known by its key, not by its family**
  ([ADR 0043](0043-device-binding.md), "The new-device notice knows a bound session by its
  key"): its sign-in is from a new device when no earlier session of the user, in the same
  horizon, is bound to the same key. Every native app of one platform is one family, which
  says nothing about which phone; a key does. A reinstalled app has a new key and is a new
  device. A session that is not bound is judged by the definition above, unchanged, and
  the email is the same for both: it names the family, never a key.

The IP address is shown as stored with the session (an IPv4 address a dual-stack socket
reported as `::ffff:203.0.113.7` is shown as `203.0.113.7`). It is the account owner's own data going to
the owner, and it is the one detail that lets them tell "me, on the train" from "not me". No
location is derived from it: that needs a geo-IP database, and a wrong city is worse than none.

### Where they are sent from

- The password notice is started in `Users.replacePassword`, the one function all three paths
  store a password through, straight after the store reports success and before anything else
  (ending sessions, clearing the lockout). No path can store a password without it, and a later
  failure cannot leave a changed password unannounced.
- The sign-in notice is started in the flow engine's `finish`, the one place a flow creates a
  session, after `Sessions.create` has returned. A request that failed, lost the race for its
  attempt, or stopped at `needs_second_factor` never gets there, so it sends nothing.

Both are **started, not awaited**. `modules/notice` runs each in the background: it reads the
settings, decides, counts the limit and hands the email to the relay after the response has
gone. No database transaction is open while it runs; each read is its own. Whatever fails
(relay, limiter, settings, a store) ends in one `warn` log line with the notice's kind, the
environment, the user id and the error's name and codes (`describeMailFailure`): never the
message, which can quote the recipient, and never the address. On shutdown the server waits for
the notices under way before closing its connections.

Sending a notice is not an audited action: the change it describes already is.

### Limits

Each user may be sent **three notices of each kind per hour** per environment
(`NOTICES_PER_HOUR`), counted in the rate limiter under `notice_<kind>:<environment>:<user id>`.

- The allowance is separate from the per-address code limits of ADR 0007, in both directions:
  notices cannot be used to exhaust the allowance a reset code needs, and a burst of sign-ins or
  password changes sends at most three emails.
- It is counted only for a notice that would otherwise be sent (the switch is on, the device is
  new), so ordinary sign-ins use none of it.
- **When the limiter cannot count, the notice is skipped.** Everywhere else a failed limiter
  fails closed by refusing the request (ADR 0016). Here refusing the sign-in would turn a Redis
  outage into a lockout, and sending without counting would be unbounded email. So the notice
  is dropped, the failure is logged, and the action it describes is untouched.

### Switches

`EnvironmentSettings` gains `notifications: { passwordChanged, newSignIn }`, both `true` by
default, added like any other setting (ADR 0018): a default in the strict input schema and in
the lenient stored one, so documents saved earlier read as "on". They are not part of
`/v1/client/config`. **Switching a notice off counts as a weakening**: the settings audit entry
carries `weakened: true`, as it does for a looser password policy (`Settings.weakened`).

## Consequences

- An owner hears within seconds of their password changing or of a sign-in from an unfamiliar
  browser, and the email tells them what to do without asking them to click anything.
- **A device family is not a device identity.** Every Chrome on Windows is the same family, so
  an attacker who uses (or claims) the victim's browser and operating system gets no notice.
  The user agent is trivially spoofed by anyone who knows or guesses what the victim uses. The
  notice catches the careless and the automated, not the targeted. Real device binding, and
  with it a real "new device", comes in Phase 2; this definition is replaced then, not extended.
  (It came for sessions bound to a device key, above. A browser's session is never bound, so
  for browsers this definition stands.)
- The reverse also holds: a browser the server cannot name is `Unknown device`, and all such
  clients are one family. A user who switches browsers gets a notice for a sign-in that is
  theirs. That is the cheap direction to be wrong in.
- A sign-in through the `server` client kind is named after the user agent of the server that
  made the request, so all of an app's server-side sign-ins are one family.
- An account whose every session ended more than 30 days ago has nothing to compare with, and
  its next sign-in is not announced. Likewise, a family last seen on a session that has since
  been purged is announced again.
- A notice can be lost: it is best-effort, sent once, with no retry and no outbox. A process
  killed between the response and the send drops it. The audit log remains the record.
- The fourth notice of a kind within an hour is not sent. An attacker cannot use that to hide:
  the first three are theirs to cause, and each already told the owner.
- A password reset now sends two emails to the address (the code, then the notice), and so
  does an administrator's reset. Anything that reads "the newest email" for a code has to look
  for the newest email with one; the conformance runner's Mailpit reader, the in-process
  targets and the browser-test fixture were changed to do so.
- The device table lives twice: in `apps/api/src/lib/device.ts` and in `@tula/react`'s
  `deviceName`. The server's is the one that decides anything; they should move to one place
  when the contract package gains a home for it.
