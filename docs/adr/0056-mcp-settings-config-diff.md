# ADR 0056 — A settings change from an assistant is an edit to the config file

- Status: accepted
- Date: 2026-10-12

## Context

The MCP server reads ([ADR 0033](0033-mcp-server.md)) and, with an agent key, asks for one
change that a person approves ([ADR 0053](0053-proposals.md)). An assistant that reads an
environment's settings will sooner or later want one changed: a longer password, a sign-in
method switched on, a provider added.

Settings already have a path from an intention to the server that a person controls: the
config file and `tula diff` / `tula apply` ([ADR 0030](0030-config-and-apply.md)). It shows
the change before it is made, refuses a plan that weakens security under `--yes`, refuses
to overwrite a change made elsewhere, and is run with a secret key the assistant is not
given. A proposal for settings would be a second such path, with a second definition of
what is shown and what is refused.

Step 2.17's second slice (TULA-24) is therefore not a write and not a proposal: **the
assistant gets the change as an edit to the config file, and the existing command applies
it.**

## Decision

### One tool, `draft_settings_change`, in a group of its own

`TOOLS` gains one entry of a new group, `draft` (beside `read`, `scaffold` and `propose`).
A draft tool reads through `ReadOnlyAdmin` and answers something for a person to act on
outside the server. It is `readOnlyHint: true`, is counted by the limiter like a read, and
answers `not_configured` without a key.

It reaches the API through `ReadOnlyAdmin.read` and nothing else, with two operations that
were on the allow-list already: `getEnvironmentSettings`, always, and `listOAuthProviders`,
only when a provider is named. `READ_OPERATIONS` does not change. The tool's module
(`settings-draft.ts`) is handed the facade and the parsed input: no admin client, no
`fetch`, no file system, no working directory, no environment.

### The input names a setting; it is not a document

```
{ settings?:  [{ path, value }],
  providers?: [{ provider, secretEnv, enabled?, clientId?, teamId?, keyId?, tenant?,
                 additionalClientIds? }] }
```

Strict at every level (`z.strictObject`), at least one entry in all, each setting and each
provider named once, at most `MAX_DRAFTED_SETTINGS` (20) settings.

- **`path` must be a setting `get_settings` returns.** It is judged by
  `SETTINGS_DOCUMENT_SHAPE`, the allow-list that tool projects through (`settingShape`):
  one list says what an assistant may see and what it may draft. A setting no tool returns
  (the wording of emails and text messages, the JWT templates, a profile's `jwtTemplate`)
  cannot be drafted; a setting this version does not know cannot be named, so the tool
  never writes a key `tula apply` would call unknown. Under the one map of named entries
  (the session profiles) a name is a path when it is returned as given: `__proto__`,
  `constructor`, `prototype`, `truncated`, and a name the cleaning would change or that
  reads as a secret, name nothing.
- **`value`** is a string, a number, a boolean, `null` or a list of strings. No object: a
  setting is a leaf, and an object is where a `{ "$env": … }` or a whole section could be
  smuggled.
- **There is no field for a secret, a credential, a file path, a webhook endpoint, a hook
  or a native app.** The last three have rules of their own in the file (ADR 0030: an
  endpoint is its address, a hook is its point and an entry is the whole hook, an app's
  `appLinkPaths` left out is unmanaged); a tool that emitted a fragment of one would
  contradict them. They are a decision each, not an addition.

A whole settings document as input was rejected: the result would be the document again
(too large for the caps below), and the assistant would have to copy every setting it did
not mean to change, each copy a chance to change it.

### A provider's secret is a reference, by construction

`secretEnv` is the **name** of an environment variable and is required. It is checked with
`@tula/config`'s own `env()` (the grammar is asked, never copied), so a value that is not a
name (lower case, an `=`, a key, a token) is refused by the schema, before any request. The
entry's `clientSecret` (Apple: `privateKey`) is `env(secretEnv)`, the entry is validated by
`@tula/config`'s `parseConfig` (the validator `tula diff` uses), and the result's shape has
`{ $env }` at those two fields and no place for a string. Nothing of the server's answer
is ever put there; the API returns no secret, and the function does not read the fields
one would be in.

**The name of one of Tula's own credentials is refused**, in the schema: `TULA_SECRET_KEY`
and `TULA_SECRET_KEY_<NAME>`, `TULA_AGENT_KEY` and `TULA_AGENT_KEY_<NAME>`,
`TULA_ADMIN_TOKEN`, `TULA_MASTER_KEY`, `TULA_API_DB_PASSWORD`, `DATABASE_URL`,
`DATABASE_MIGRATION_URL`, `REDIS_URL`, `SMTP_URL`, `TWILIO_AUTH_TOKEN` and
`TWILIO_API_KEY_SECRET`. `tula apply` sends the value of the variable an entry names to
the server as that provider's client secret; an entry that named the secret key, applied
unread, would hand it over. The list is closed and is of names. The tool does not try to
tell a pasted secret from a name by its length or alphabet (a guess that would be wrong
both ways), and it cannot know what any other variable on the operator's machine holds:
the result's fixed `notes` say that the person reads every `$env` name before applying.

`secretEnv` is required even for a provider the server already has, because the config's
schema requires the secret reference of every provider it lists: an entry without one
would not load.

An entry is the provider's **whole** entry (what the server has, with what was asked for
over it), because that is what the file holds: `tula apply` replaces a provider's record.

### The output is the edit, per key, and never file text

```
{ changed: false, nextStep, notes, revision, managedBy,
  settings:  [{ path, from?, to, changes }],
  providers: [{ provider, configured, entry, changed }],
  weakened, weakens }
```

The tool does not have the file (it reads none, on purpose: `tula mcp` never calls
`loadConfig`, and a file is a path, an import and code that runs). So it cannot return
a textual diff of it, and it does not return generated TypeScript either: a sentence of
code built from values is a value interpolated into prose, which ADR 0033 forbids. What it
returns is structured: where, and what to write.

**How the caps are met.** Nothing is raised and nothing is bypassed.

- Every field goes through `project(value, shape)`. A setting's `from` and `to` go through
  the shape of that very setting in `SETTINGS_DOCUMENT_SHAPE`; a provider's entry through
  `PROVIDER_ENTRY_SHAPE`; `weakened`, `managedBy`, `revision` and a problem through shapes
  of their own. `nextStep` and `notes` are constants.
- A result is at most 20 edits and 8 provider entries of bounded leaves, which fits in
  64,000 characters in all but contrived cases; `bound` still has the last word, and an
  edit that does not fit is `output.too_large`, never a list cut short. A cut edit would be
  a different change.
- **A value that the projection would alter is refused, not returned altered**
  (`not_returnable`): cut at its field's limit, cleaned of a character that cannot be
  seen, of another type, or replaced because it reads as a secret. What the reader copies
  into the file is exactly what was asked for, or nothing. The same holds for a stored
  field of a provider that would be written into its entry.
- `from` is shown as `get_settings` would show it (a stored value that reads as a secret is
  `[redacted]` there too); it is information, never something to write.

### Nothing is judged by a rule of the tool's own

- **Validity** is the contract's `EnvironmentSettingsInputSchema` on the whole document the
  change would make (the stored one, read with `parseStoredEnvironmentSettings`, with the
  wanted values set), and `parseConfig` for a provider. A problem the stored document
  already had is not held against the change. A refusal is `change.invalid` with
  `problems: [{ path, code }]`: the validator's path and its closed issue code, never its
  sentence (which can quote a value) and never a value. At most 50 distinct problems are
  listed; a list that left one out has `truncated: true` and `problemsOmitted`, the count,
  so a cut list is never read as whole.
- **Weakenings** are the contract's `settingsWeakenings(before, after)` and
  `oauthProviderWeakenings`, under the names `tula diff` prints (`password.minLength`,
  `providers.google.additionalClientIds`). `weakens` is `weakened.length > 0`.
- **A document this version cannot read is a failure** (`settings.unreadable`), not a
  draft: with nothing to compare against, a weakening could go unsaid.

What the tool does not judge is said in its docs: what only the server knows at apply
(that some way to sign in remains, counting providers; that the revision is still the one
read). `tula diff` and `tula apply` are the check.

### What the reader is told, in fixed words

`changed: false` on every answer, a refusal included, and `nextStep`: nothing was changed
on the server or on disk; a person reviews the file, runs `tula diff` and `tula apply`
with their own secret key; this server cannot apply it. `notes` says how the edits are
read, that the file is the whole truth for settings (so an edit belongs in the file that
manages the environment, and where `managedBy` is null a file of only these edits would
reset the rest), and what `weakened` means. None of the four holds a value.

### New dependencies of `@tula/mcp`

`@tula/config` (for `env`, `parseConfig`, `providerSecret`) and `@tula/contract` (the
settings schema and the weakening rules). Both are workspace packages `@tula/cli` already
loads; `@tula/mcp` is still loaded only by `import()` inside `tula mcp`.

`@tula/config` has one entry point, and it also exports `loadConfig`. So the module that
loads a config file is in `@tula/mcp`'s import graph, and what holds is narrower than "it
is not there": **the tool never calls `loadConfig` and reads no file.** A test scans the
tool's two sources: from `@tula/config` they import `env`, `parseConfig`, `providerSecret`
and `isConfigError` and nothing else, and neither names `loadConfig`,
`DEFAULT_CONFIG_FILE`, `resolveSecret` or `requiredSecrets`. A second entry point of
`@tula/config` without the loader was considered and left: built as two bundles the
package would have two copies of `ConfigError`, and `isConfigError` from one would not
know an error thrown by the other.

## Consequences

- An assistant can prepare a settings change and cannot make one. The worst a manipulated
  assistant does through this tool is put a bad edit in front of a person, who sees it
  again, with its weakenings named, in `tula diff`.
- The tool's result is not the file. A client (or a person) still has to place each edit;
  where no file manages the environment the notes say that the file must start from the
  whole document.
- A setting added to the contract is draftable when it is named in
  `SETTINGS_DOCUMENT_SHAPE`, which is also when `get_settings` starts returning it.
- A change that sets an origin or a name holding a secret-shaped or invisible string is
  refused. Accepted: the alternative returns something other than what was asked.

## Alternatives considered

- **A proposal for settings** (ADR 0053's mechanism). Rejected for now: it would be a
  second way to change settings beside the file, with its own preview and its own refusal
  rules, and `managedBy` would say "drifted" after every approval.
- **Return the whole config file, or a unified diff of it.** The server would have to read
  the file (and so execute it), and the text would be values interpolated into code, cut at
  64,000 characters or not at all.
- **Return a `tula.config.ts` fragment as text.** The same interpolation, and a string cap
  of 512 characters that would cut it.
- **Take a whole settings document as input.** See above.
- **Make `secretEnv` optional for a provider the server has.** The entry would not load in
  `@tula/config`, and a tool that guessed a variable's name would be inventing where a
  secret lives.
- **Clean a wanted value and return it cleaned.** The edit would differ from the request
  without saying so.

## Not verified

No MCP client was run against the tool: whether a client shows `nextStep` and `weakened`
to a person, and how well a model turns the edits into a correct change of a real
`tula.config.ts`, is not known ([phase-2-unverified.md](../plans/phase-2-unverified.md)).
