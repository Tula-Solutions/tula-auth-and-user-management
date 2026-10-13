# ADR 0059 — An email address for an account that has none, and the accounts a provider's removal locks out

- Status: accepted (Part A, built); proposed (Part B, a design nobody has built)
- Date: 2026-10-12

## Context

X and Facebook give no email address ([ADR 0026](0026-oauth.md)), so a first sign-in with
either makes an account with none. That account is sent no notice, cannot set a password,
cannot reset one, and, until this change, could not be given an address by anybody. When
its operator switches the provider off or removes its credentials, it is locked out with
nothing that lets it back in but the provider's return. ADR 0026 listed that as its largest
cost and left it to the product's owner.

The owner decided five things (TULA-69):

1. A signed-in user with no address can add one and prove it with an emailed code, after a
   recent authentication.
2. Before a provider is switched off or its credentials are removed, the accounts whose
   only way in is that provider are counted, and the dashboard and `tula diff` / `tula
   apply` show the count.
3. A sign-up with X or Facebook is to be asked for an address.
4. Accounts are to be merged.
5. An administrator may set an address on such an account.

This ADR has two parts. **Part A** is what was built: decisions 1, 2 and 5. **Part B** is a
design for decisions 3 and 4, written for the owner to decide on. Nothing of Part B is in
the code.

## Decision (Part A, built)

### A user gives their account an address

Two routes, both behind `publishableKey()`, `sessionAuth()` and `requireRecentAuth()`, each
with a per-address limit of its own (`modules/email-address`):

| Route | Operation | Answers |
| --- | --- | --- |
| `POST /v1/client/me/email` | `requestEmailAddressCode` | `{ destination, expiresAt }`: the masked address and when the code stops working |
| `POST /v1/client/me/email/verify` | `verifyEmailAddress` | the user, with the address and its verified time |

**They are for an account with no address, and only that.** A user who has one, verified
or not, is answered `email.already_set` (409) by both, before anything is counted, sent or
spent. Changing an address is a different feature with a different threat (it moves where
every reset and notice goes) and is not built here. The one new error code is that one;
`@tula/core`'s message table holds every contract code, and its bundle budget moved by the
57 bytes the code's sentence and the two calls measure (the number and the sum are in
`packages/core/src/bundle.test.ts`).

**The address is stored only by confirming a code, in one transaction with its record.**
Asking stores nothing on the user. The pending address lives on the verification token
(purpose `email_addition`), whose keyed hash covers the user and the normalised address, so
a code confirms the address it was sent to, for the user who asked, and nothing else: it is
not a sign-in code, a reset code, a verification code of a sign-up or a step-up code, and
none of those is one of these. `users.addEmail` then writes the address, its verified time
and the `email` identity row with the activity `user.email_added` (`method: 'self'`,
`verified: true`) or writes nothing. The unique key on the normalised address decides a
race: two users who each proved the same address get one winner, and the loser is answered
`verification.expired` with its code spent.

**A taken address is answered like a free one.** The request looks every address up, so
both cost the same read, and answers the same receipt. A free address is sent the code. A
taken one is sent a notice with no code (`email_in_use`: somebody tried to add this address
to another account; nothing changed), and the token stored for it is a decoy that no code
matches, so the verify step answers `verification.invalid_code` exactly as it does for a
wrong code. Whoever holds a session therefore cannot use the routes to ask whether an
address has an account. What differs is what an inbox receives, which only the inbox's
owner sees.

**The limits.** One message a minute and five an hour per user
(`EMAIL_ADDITION_EMAILS_PER_HOUR`); five an hour per address across users, under a keyed
hash of the address (`EMAIL_ADDITION_EMAILS_PER_ADDRESS_PER_HOUR`, purpose
`email-addition-limits`), so that no number of accounts sends one inbox more than five of
these messages an hour; the per-address-of-the-request limit of the route.

**What the per-address limit costs, and is accepted.** The budget belongs to the address
and is spent by whoever names it. Anyone with an account that has no address (a sign-in
with X or Facebook makes one) can ask five times for an address that is not theirs, and
for the rest of that hour its real owner, adding it to their own account, is answered
`rate_limited`. That is all it can do: the key is this purpose's own, so it spends nothing
of the address's sign-in codes, links or password resets (a test sends one in the same
minute), keeps nobody from signing in, and confirms nothing (the asker cannot read the
inbox). The inbox receives at most five messages it did not ask for, each saying what to
do. The other choice, no limit per address, lets any number of accounts mail one inbox
without bound; a limit per asker and address alone does the same with more accounts. The
owner waits an hour or asks an administrator (`PUT /v1/admin/users/:userId/email`). A
router test pins it (one account's five requests, the owner's sixth refused, the owner
served after the hour). A guess at the code is counted before the
check under a per-user key of its own (`email_addition_code:<environment>:<user>`,
`CREDENTIAL_LOCKOUT`): never the step-up key, because a success clears the key and anyone
with a session can succeed here with their own inbox.

**The order of the verify step** is fixed: the user still exists, is not banned
(`auth.user_banned`) and still has no address; nothing pending is `verification.expired`
and is not counted; the guess is counted; the code is checked; the address is stored. A
banned user, a user who got an address meanwhile (from an administrator) and a code for
another user never reach the comparison.

**The new address is told.** After the store commits, a notice (`email_added`) goes to the
address that was just added, by the notices' usual rules (detached, limited, no code or
link). There is no old address to tell.

**A user with nothing to step up with signs in again.** `requireRecentAuth()` is ten
minutes. An account with no address, no passkey and no authenticator has no step-up method
(ADR 0025), so past the window the answer is `auth.step_up_required` with an empty
`methods`, and the way on is a new sign-in with the provider. That is the stated cost of
keeping the routes behind a recent authentication, and the reason is the usual one: the
address becomes a way to reset and to sign in, so a stolen session past its fresh window
must not be able to attach the thief's inbox. The React step-up dialog already has the
sentence for it.

### An administrator gives an account an address

`PUT /v1/admin/users/:userId/email` (`setUserEmail`, behind `secretKey()`), body
`{ email }`, answers the user.

- **The address is stored unverified.** An administrator has not proven that the person at
  the account reads that inbox, and "verified" is what automatic linking, the emailed
  step-up and custom claims trust. The user proves it the way every unverified address is
  proven: the next sign-in by emailed code, or a reset. Until then it receives notices and
  can receive a reset, which is the point of the route: an operator who is about to switch
  a provider off can give the affected accounts a way back first.
- **It never replaces an address.** A user who has one is `email.already_set` (409). An
  address another account holds is `resource.conflict` (409): an administrator may be told
  that, as `POST /v1/admin/users` already tells them.
- It ends no session and sends nothing. The activity is `user.email_added` with
  `method: 'admin'`, `verified: false`.

The user's own route answers `email.already_set` afterwards: the address is theirs to
prove, not to replace.

### The accounts that depend on a provider

**What is counted.** An account *depends on* a provider when it has that provider
connected and, by `OAuth.canStillSignIn` (the one definition of "a way to sign in"), could
not sign in with the environment's settings as stored and its enabled providers **minus
that one**: no password, no address an enabled emailed code or link could reach, no
passkey with passkeys on, no other enabled provider. The rule is not a new one, it is the
existing rule asked with one provider taken away.

Two consequences are worth saying out loud. The emailed code is off by default, so in an
environment that left it off an account made with Google that never set a password counts
too, although it has an address: it cannot *sign in* without the provider. It is not
locked out for good (a reset gives it a first password), and the dashboard and the docs
say that the count is of accounts that could not sign in, not of accounts beyond recovery.
And an account whose provider is already off depends on it all the same, so the read
answers for any provider, configured or not.

**The shape.** `GET /v1/admin/oauth-providers/:provider/dependents`
(`getOAuthProviderDependents`) answers `{ provider, accounts, more }`. A number and a
boolean and nothing about who: never an id, an address or a name, in the answer, the audit
entry, the event or a log line. The work is bounded: at most
`DEPENDENT_ACCOUNTS_SCAN_LIMIT` (1,000) accounts of the provider are looked at
(`users.countDependentOn`, in both adapters and the shared suite); past that `more` is
`true` and `accounts` is a floor, and every surface says "at least".

**It is a recorded weakening that asks first, not a refusal.** The owner's answer to "are
the accounts counted and shown before the provider goes" was yes. Whether the change is
then *refused* was not asked, and the choice made here is the lead architect's reading of
that yes, to be confirmed: switching off, or removing, a provider that accounts depend on
is treated as every other weakening is.

- `OAuth.update` and `OAuth.remove` count again under the environment's `sign_in_methods`
  lock, and the audit entry carries `weakened: true`, `dependentAccounts` and, when the
  scan was cut, `dependentAccountsIncomplete: true`. The rule is the contract's
  `oauthProviderWeakenings` (the path `enabled`), shared by all three surfaces.
- `OAuth.switchOff`, which carries out an approved `disable_oauth_provider` proposal
  ([ADR 0053](0053-proposals.md)), does the same in the same place: counted under the
  lock, the same rule, the same three fields beside `proposalId` and `approvedBy`. A
  count that cannot be taken throws before anything is written, and the proposal ends
  `failed`. `tula approve` reads the count for a provider that is on and says it in its
  question: the number ("at least" past the scan limit), "no account was found", or fixed
  words for a count that could not be read and for a server that has none. It never
  stops the question and never fails the run: the person at the terminal is the check.
- The dashboard reads the count before it saves and asks first, saying the number in
  words.
- `tula diff` prints a line with the count; `tula apply --yes` refuses the plan without
  `--allow-weaker`, before any write.

A refusal was not chosen because an operator who is closing a provider for a reason (a
compromised app, a contract that ended) must be able to, and because the same operator now
has a way to act on the number first (give the accounts an address). **A refusal can
replace the question later without a contract change**: the count is already taken in the
write's own lock, so the service can throw where it now records, with an existing code and
a fixed `params.reason`; the read route, the schema and the two event fields stay as they
are.

**What the count is not.** It is what was true when it was read. The dashboard's and the
CLI's number comes from the read route; the number in the audit entry is the write's own.
Between the two an account can gain or lose a way in. And `@tula/mcp`'s
`draft_settings_change` does not judge this weakening: it drafts an edit to a file from the
settings and the provider list, never reads the count, and says so in the answer itself: a draft that takes a provider
from on to off carries one more fixed entry in `notes` (no name, no number), because
`weakens: false` would otherwise read as "nobody is locked out". `tula diff` is where
the person who applies the draft sees the number.

**A count `tula` could not read is not a count of none.** Only a server from before the
route (it answers 404 or 405) leaves a plan unjudged. A request that was refused, limited
or failed, one that got no answer and an answer that is no count put the provider's path
in the plan's `weakened` (the contract's own case of a floor: none found, not every
account looked at), so `tula apply --yes` needs `--allow-weaker` and `tula diff` says, in
fixed words, that the count could not be read. A check that a failed request switches off
is no check.

### The profile's section (`@tula/react`)

`<UserProfile>` draws an "Email address" section for an account that has none, and for no
other: the address, then the code, then the address on the account. It holds no rule of
its own (what an address is, whether it can be added, when a step-up is needed are the
server's answers), its words never say a code was sent (a taken address is sent none), a
step-up the user declines is not an error, and it is keyed by the session, so nothing one
user typed is there for the next. A user with nothing to step up with is told by the
provider's dialog to sign out and sign in again.

**Its size, measured.** The two calls and the message of `email.already_set` are
`@tula/core`'s and are inside the React bundle: they took 340 of the 436 bytes of room it
had (53,175 against a budget of 53,271). The section is 822 more: 53,997. The budget moved
to that measurement by the test's convention, to 54,433, so the 436 bytes of room are what
is left; the sum is in the comment beside the constant. `@tula/core`'s own budget moved by
its 57 bytes, to 16,976.

### What Part A does not do

- No user changes an address they have, and no administrator replaces one.
- Nothing asks for an address during a sign-up (Part B).
- Nothing merges accounts (Part B). An address another account holds cannot be added, so a
  person with an X account and an older email account still has two.
- `@tula/expo` and the Swift client have the two calls and no screen (neither has any).
- No migration: `users.email` was already nullable, and the token's `destination` column
  already existed.

## Part B: a design, not built

### B1. Asking for an address in an X or Facebook sign-up

**Recommended shape: a new status, `needs_email`, followed by the existing
`needs_email_verification`.** After the exchange finds an identity that is nobody's, for a
provider of `OAUTH_PROVIDERS_WITHOUT_ADDRESS`, the attempt parks on `needs_email` instead
of creating the account. The client submits an address
(`POST /v1/client/sign-ins/:attemptId/email`), the server emails a code and moves the
attempt to `needs_email_verification`, whose screen and call every client already has.

Reusing `needs_email_verification` alone, with no address yet, was considered and is not
recommended: its step carries a destination today and its only action is "submit the
code", so every shipped client would draw a code field for a code nobody sent.

What a new status costs, and why it is safe:

- `nextStatus` gains the status and two events (`email_submitted`, `email_skipped`), and
  its table test a row for every kind × step × event.
- Every client's default branch is already "not supported": `@tula/react`'s step `switch`,
  `@tula/expo`'s `flowScreen`, the Swift `FlowScreen.notSupported`. The generated native
  types keep an unknown status (ADR 0050, open enumerations). **An older client therefore
  fails safe**: it shows "not supported", signs nobody in, and no account exists yet.
  That is also its cost: with the setting on, an app that has not been updated cannot
  complete an X or Facebook *sign-up* (a sign-in with a known identity never reaches the
  step). The setting is therefore off by default and the docs say "update your apps
  first".
- A setting, per environment: `signUp.providerEmail` = `off` (today's behaviour, the
  default), `optional` (the step offers "skip", and a skipped sign-up makes today's
  address-less account, which Part A's routes can complete later) or `required`. Changing
  it is not a weakening in either direction: it adds or removes a question, not a check.

**For the owner:** required, optional or both as a setting? The recommendation is the
setting, default `off`, because `required` turns away a person who will not give an
address to an app they reached through a provider chosen for exactly that reason.

### B2. When the account is created, and when the hook is asked

**The account is created only after the address is proven** (or skipped, under
`optional`). Until then the attempt holds the verified provider identity and the pending
address in its state, and nothing else exists: no user, no identity row, no session. This
keeps the rule that there is no unverified address a sign-up put on an account, and it
means an abandoned attempt leaves nothing to clean up but itself.

**`before_sign_up` is asked once, at that same point**, with the proven address (or `null`
after a skip) and the method the provider's name. Not at the exchange, and not when the
address is submitted: asked before the proof, whether the hook was called would tell an
observer whether the address has an account, which is the rule ADR 0035 already states.
The side-by-side test it calls for applies: an address that has an account and one that
does not get the same answers and neither reaches the receiver before the code is proven.

**Uniformity while the address is unproven.** Submitting an address answers the same for
every address: the same step, the same masked destination, the same limits, the token a
decoy when the address has an account that the attempt will not be allowed to merge into
(B3). The existing "account exists" notice with no code is what such an inbox receives.

### B3. The proven address already has an account

What has been proven at that moment: control of a provider account (the bound ticket), and
control of the inbox (the code). That is exactly what a sign-in by emailed code proves,
plus a provider identity. So the recommendation is: **treat it as a sign-in by emailed
code to that account, which then connects the provider**, and hold it to every rule that
sign-in is held to.

| Situation | Outcome |
| --- | --- |
| `emailCode` is on, the address is verified, no second factor | The identity is linked, the user is signed in, `user.identity_linked` is recorded and the owner is told. |
| The account has a second factor | `needs_second_factor`, as after any first factor. The identity is linked only when the attempt completes, never before: a person with the inbox alone must not attach a provider to an account whose owner has a second factor. |
| The existing address is unverified | The code verifies it. If the account has a password, the password is removed in the same transaction (ADR 0024's rule: the address is proven for the first time by someone who did not prove the password). |
| The user is banned | `auth.user_banned`, nothing linked. |
| `emailCode` is off in the environment | **Refused**, and the submit step already answered as for a free address (the decoy). The inbox is sent the "account exists" notice, which says to sign in the usual way and connect the provider from the profile. An environment that has decided an inbox alone does not sign anyone in must not get a side door through a provider sign-up. The code exists already: `oauth.account_exists`, shown when the code step is reached. |
| The provider identity is already another user's | Cannot happen here: a known identity never reaches the step. |

`before_sign_up` is not asked (no account is created); `before_session` and `before_token`
are, where they always are.

The alternative, linking whenever the code is right whatever `emailCode` says, was
considered. It is simpler to explain to a user and it is what several products do. It is
not recommended because it makes "prove the inbox" a way to sign in to an existing account
in every environment that enables X or Facebook, which is a setting the operator switched
off.

**What `linking-table.test.ts` gains.** Today X and Facebook have one row each ("an
unknown identity is a new user with no address"). With the step they gain the rows above,
stated per provider like every other provider's, plus "the setting off: the old row". The
test still fails for a provider with no rows, and the two rules stay two: a provider that
gives an address is judged by the provider's word, one that gives none by the code.

**For the owner:** confirm the `emailCode`-off refusal, or choose the simpler rule.

### B4. Merging two accounts that both exist

This is the person who already has an address-less X account *and* an older account with
the address. Part A answers them "this address cannot be added"; B3 does not help, because
their X identity is known and never reaches the step.

**Recommended: its own ticket.** It is a different kind of operation from everything
above: it deletes a user. It needs, at least:

- proof of both accounts at once: a live, recently authenticated session of the one, and
  a full sign-in to the other (password or code, and its second factor) inside the same
  attempt, so that neither a stolen session nor an inbox alone merges anything;
- a rule for every row that names a user: identities (move), passkeys (move; the user
  handle differs, so each must still verify), the phone number and the texted factor (one
  survives), TOTP and backup codes (the surviving account's), password history, sessions
  (the absorbed account's end), audit entries (kept, with the absorbed id recorded on a
  new `user.merged` activity), and what a hook or a webhook receiver is told;
- which id survives, since applications store Tula's user id: the recommendation is the
  older account's, and an event that names both, so an application can move its own rows;
- no undo. A merge is the one thing here an administrator cannot reverse.

Until it is built the honest answer for that person is an administrator: delete the newer
account, sign in to the older one, connect X from the profile.

**For the owner:** is this wanted for end users, or is an administrator's route (merge A
into B, with the same row rules and no proof of the user's) enough for now? The
administrator's route is much smaller and covers the support case.

### B5. What Part B costs and what it does not solve

- An older client cannot finish an X or Facebook sign-up while the setting is on.
- A sign-up gains an email round trip, and a third hook call is not added (the question
  moves, it is not asked twice).
- `required` loses the people who chose a provider to avoid giving an address.
- Accounts made before the setting was switched on still have no address; Part A's routes
  and the administrator's route are their way to one, and nothing prompts them.
- Nothing here tells a locked-out user anything: an account with no address cannot be
  written to. The count in Part A is what an operator has instead.

## Consequences

- An account with no address is no longer a dead end: its user can add one, and its
  operator can.
- Switching a provider off is still possible in one step, and is now said with a number
  and recorded as a weakening.
- The `user.email_added` event, the `email.already_set` code, two email kinds
  (`email_in_use`, `email_added`: 28 kinds now) and four operations are new public
  surface.
- Three conformance scenarios hold the behaviour, with journeys for `@tula/core`,
  `@tula/expo` and the Swift client.
- What was not run is in `docs/plans/phase-2-unverified.md`.
