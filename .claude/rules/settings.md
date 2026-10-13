---
paths:
  - "apps/api/src/modules/settings/**"
  - "apps/api/src/middleware/cors*"
  - "apps/api/src/adapters/settings-manager*"
  - "packages/contract/src/settings*"
  - "packages/contract/src/environment-settings*"
---

# Per-environment settings

Moved here from `AGENTS.md`, word for word, and canonical for this area: `AGENTS.md` lists
this file under "Area rules" and does not repeat it. A section named in a sentence as
"above" or "below" is found through that list.

## Per-environment settings

Anything about how sign-in behaves that differs between tenants lives in the environment's
settings document (`EnvironmentSettings` in `@tula/contract`; [ADR 0018](../../docs/adr/0018-environment-settings.md)):
app name and support address, password policy, enabled sign-in methods (`password`,
`emailCode`, `emailLink`, `passkey`, `smsCode`), the WebAuthn relying-party id (`passkeys.rpId`), whether
a sign-up needs a password (`signUp.password`), allowed origins and redirect URLs, audit
retention, which security notices are emailed (`notifications`), whether text messages are
sent, to which countries and how many in a day at most (`sms`, [ADR 0037](../../docs/adr/0037-phone-numbers-and-sms.md)), the environment's own
wording of its emails (`emails.templates`, [ADR 0039](../../docs/adr/0039-email-templates.md)) and of its text messages (`sms.templates`, [ADR 0042](../../docs/adr/0042-message-wording-editor.md)), whether two-step
verification is `off`, `optional` or `required` (`mfa.policy`), and the session profiles and
the concurrent-session rule (`sessions`, [ADR 0028](../../docs/adr/0028-session-profiles.md)). **Read it through
`~/modules/settings/service`** (`Settings.current(deps, tenant)`), never from `deps.config`:
`PASSWORD_POLICY` and `CORS_ORIGINS` are only the defaults of an environment that has saved
nothing.

- `GET` / `PUT /v1/admin/settings` reads and replaces the whole document. The `PUT` needs
  `If-Match: "<revision>"` (428 `precondition.required` without it, 412 `precondition.failed`
  when stale). `GET /v1/client/config` is the public view a sign-in screen is drawn from.
- A new setting is a new field **with a default** in the contract schema (additive), in both
  the strict input schema and the lenient stored one. Unknown keys are refused on input.
- Reads are cached per instance (`cacheEnvironmentSettings`): the writer sees its write at
  once, other instances within 5 seconds with Redis and 30 without. Do not add a setting whose
  safety depends on taking effect everywhere immediately.
- A flow that uses a sign-in method calls `Settings.requireMethod` on **every** step, after
  the attempt is loaded and before anything is counted, spent or sent: an attempt started
  before a method was switched off must not finish with it. That includes the steps an attempt
  waits on **after** its first factor (the emailed code of `needs_email_verification`, a second
  factor, an enrolment): they call the flow service's `requireProvenMethod`, which re-checks
  the factor the attempt actually proved (`firstFactor` in its state: a settings switch,
  `Passkeys.relyingParty`, or `OAuth.credentials`). A new parked step calls it too.
- A `PUT` that leaves out `password` or `urls.allowedOrigins` stores the deployment's
  `PASSWORD_POLICY` / `CORS_ORIGINS` for them, not the schema defaults. The body is validated
  as `EnvironmentSettingsInput` (those two stay absent when left out) and only
  `Settings.withDeploymentDefaults` turns it into a storable document, validating the result
  strictly again: nothing reaches the store that `EnvironmentSettingsSchema` refuses. Reading
  is defensive too (`readStoredEnvironmentSettings` drops list entries it would not accept),
  because settings are read on the request path. `password.minLength` has a floor of 8 on input, and the audit entry carries
  `weakened: true` when `Settings.weakened` says the change weakened something: the password
  policy, a security notice, the MFA policy, the sessions, the audit retention period
  (set where there was none, or shortened: older entries are then deleted), or the daily
  limit of text messages (raised).
- **A replace may name the tool that manages the settings from a config file**
  (`x-tula-managed-by` + `x-tula-config-hash`, [ADR 0030](../../docs/adr/0030-config-and-apply.md)):
  the store records it with the revision that write produced, and the answer's `managedBy`
  carries `drifted` once the settings are replaced without the headers. A replace without them
  keeps the record (and its audit entry says `outsideConfig: true`); `none` removes it. The
  stored record is read only through `readStoredManager` (`~/adapters/settings-manager`), in
  every adapter: one that the answer's schema would refuse reads as unmanaged, never as a 500. The
  definition of "weakened" is the contract's `settingsWeakenings`, shared with `tula diff`.
- CORS is decided per request in `~/middleware/cors`: a preflight passes when any environment
  allows the origin, the response is readable only when the key's environment does.
  `/v1/admin/*` and `/v1/instance/*` follow the deployment's `CORS_ORIGINS` only.
