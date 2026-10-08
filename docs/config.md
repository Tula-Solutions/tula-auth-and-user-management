# Settings as code: `tula.config.ts`, `tula diff` and `tula apply`

An environment's sign-in behaviour is its **settings** (app name, password policy, sign-in
methods, allowed origins and redirect URLs, notices, the MFA policy, passkeys, session profiles)
and its **OAuth providers**. Both can be written in a file, reviewed in a pull request and
applied by a pipeline. So can its **webhook endpoints** ([Webhook endpoints](#webhook-endpoints),
below). The decisions behind this page are in
[ADR 0030](adr/0030-config-and-apply.md).

> Nothing is published to npm yet. Inside this repository the CLI is `bun run tula -- <args>`,
> and a working example is [`examples/tula-config/tula.config.ts`](../examples/tula-config/tula.config.ts).

## The file

```ts
// tula.config.ts
import { defineConfig, env } from '@tula/config'

export default defineConfig({
  environments: {
    dev: {
      kind: 'development',
      settings: {
        app: { name: 'Northline (dev)', supportEmail: 'help@northline.app' },
        signIn: { methods: { emailCode: { enabled: true }, emailLink: { enabled: true } } },
        urls: {
          allowedOrigins: ['http://localhost:5173'],
          allowedRedirectUrls: ['http://localhost:5173/auth/callback'],
        },
      },
      providers: {
        github: { clientId: 'Iv1.0123456789abcdef', clientSecret: env('GITHUB_CLIENT_SECRET_DEV') },
      },
    },

    prod: {
      kind: 'production',
      settings: {
        app: { name: 'Northline', supportEmail: 'help@northline.app' },
        signIn: { methods: { emailCode: { enabled: true }, passkey: { enabled: true } } },
        signUp: { password: 'required' },
        urls: {
          allowedOrigins: ['https://app.northline.app'],
          allowedRedirectUrls: ['https://app.northline.app/auth/callback'],
        },
        audit: { retentionDays: 365 },
        notifications: { passwordChanged: true, newSignIn: true, mfaChanged: true, identityChanged: true },
        mfa: { policy: 'required' },
        passkeys: { rpId: 'northline.app' },
        sessions: {
          maxPerUser: 10,
          onLimit: 'end_oldest',
          profiles: {
            web: { idleTimeout: '7d', absoluteTimeout: '30d' },
            mobile: { idleTimeout: '30d', absoluteTimeout: '90d' },
          },
        },
      },
      providers: {
        google: {
          clientId: '1234567890-abc.apps.googleusercontent.com',
          clientSecret: env('GOOGLE_CLIENT_SECRET'),
        },
        apple: {
          clientId: 'app.northline.web',
          teamId: 'A1B2C3D4E5',
          keyId: 'K1L2M3N4O5',
          privateKey: env('APPLE_PRIVATE_KEY'), // the .p8 file's contents
        },
      },
    },
  },
})
```

- **`settings`** is the settings document, exactly as `PUT /v1/admin/settings` takes it
  (`EnvironmentSettingsInput` in `@tula/contract`). It is typed, so an editor completes it,
  and validated when the file is loaded: a mistake is reported with its path
  (`environments.prod.settings.pasword: unknown key`) before anything is sent.
- **`providers`** are Google, GitHub and Apple. A client id is written in the file. A secret
  is **never** written: `clientSecret` and `privateKey` only accept `env('NAME')`, the name of
  an environment variable. A string there does not compile, and a file that holds one is
  refused when it is loaded.
- **`kind`** is optional. With it, `tula` refuses a secret key of the other kind
  (`tula_sk_dev_…` for a `production` entry) before it sends anything.
- The file is TypeScript: share settings between environments with a constant and a spread.

### What a missing field means

`apply` replaces the whole settings document, so **the file is the truth**: a setting you
leave out goes back to its default. Two settings are different, because their default is the
*deployment's* and only the server knows it:

| Left out | What `apply` does |
| --- | --- |
| `password` | keeps the policy the server has (at first, the deployment's `PASSWORD_POLICY`) |
| `urls.allowedOrigins` | keeps the origins the server has (at first, `CORS_ORIGINS`) |
| anything else | resets it to its default |

The plan lists what was kept. To manage either, write it in the file.

A **provider** the file does not mention is left alone and shown as *unmanaged*; `--prune`
deletes it.

**Webhook endpoints** follow the same rule, one level up: a file with no `webhooks` list does
not manage them at all, and a list manages exactly what it names
([Webhook endpoints](#webhook-endpoints)). So do **hooks**, under a `hooks` key
([Hooks](#hooks)).

## Webhook endpoints

An environment's [webhook endpoints](webhooks.md) can be listed in the file:

<!-- snippet: examples/tula-config/tula.config.ts#webhooks -->
```ts
// The endpoints this environment's events are posted to. An endpoint is its address;
// there is no secret to write: the server makes it when `tula apply` registers the
// endpoint (`--secrets-file <path>` keeps it). `enabled` is left out, so the switch
// stays as the server has it. `dev` has no `webhooks` key: its endpoints are not
// managed by this file.
webhooks: [
  {
    url: 'https://api.northline.app/webhooks/tula',
    eventTypes: ['user.created', 'user.deleted'],
  },
],
```
<!-- /snippet -->

| Field | |
| --- | --- |
| `url` | where events are posted: what `POST /v1/admin/webhook-endpoints` takes, judged by the server (`https`, no credentials, a public address) |
| `eventTypes` | the event types delivered, at least one. A **set**: order and repeats mean nothing |
| `enabled` | optional. Left out, the switch is **not managed** |

The rules, each of which the plan shows before anything is written:

- **A secret can never be in the file.** There is no field for one: a `secret` key does not
  compile, and a file that holds one is refused when it is loaded, without the value being
  repeated. The signing secret is made by the server.
- **No `webhooks` key: not managed.** `tula` does not read the environment's endpoints, shows
  nothing about them and changes none, with or without `--prune`. `webhooks: []` is
  different: it says the file manages webhooks and lists none.
- **An endpoint is its address.** It has no name or id in the file; an entry is matched to the
  server's endpoint with **exactly** the same `url`, character for character, which is how
  the server itself stores and compares an address (it does not normalise one, so
  `https://a.example/hook` and `https://a.example/hook/` are two endpoints). The same address
  twice in the file is an error when the file is loaded.
- **A changed address is a new endpoint, never an update.** The plan shows the new address as
  `create` (with a **new signing secret**) and the old one as *unmanaged*; with `--prune` the
  old one is removed, and its pending deliveries and its delivery log go with it. The plan
  says so in words. To keep an endpoint's secret and log while moving it, change its address
  through the admin API first, then the file.
- **An endpoint the list leaves out is left alone** and shown as *unmanaged*, as a provider
  is. `--prune` removes it.
- **Event types are a set.** `['user.deleted', 'user.created', 'user.created']` and
  `['user.created', 'user.deleted']` are the same thing: no difference in the plan and the
  same fingerprint of the file. A change shows the types added and removed, sorted
  (`eventTypes +"session.created" -"user.deleted"`).
- **`enabled` left out is not managed.** A new endpoint starts switched on and an existing one
  is left as it is, **including one the server switched off** because it kept failing or
  answered `410`: a file that does not write `enabled` never fights the server. Written
  (`true` or `false`), it is set. Switching on an endpoint the server switched off needs no
  extra flag, but the plan says why it was off, on the endpoint's line and as a warning
  (`! switches on a webhook endpoint the server switched off (https://… : failing); if it
  still fails the server switches it off again`). A pipeline that keeps `enabled: true` in
  the file switches such an endpoint on again at every run.
- **Removal destroys something.** Removing an endpoint deletes its pending deliveries and its
  delivery log, for good. At a terminal the question says so (`This REMOVES 1 webhook
  endpoint with its pending deliveries and its delivery log, for good.`). With `--yes`
  nobody reads it, so the run is refused and nothing is written unless
  `--allow-webhook-removal` is given too. (`--prune` alone is not enough under `--yes`: a
  pipeline that already prunes providers would otherwise start deleting delivery logs the day
  a `webhooks` list is added to the file.)
- **The signing secret of a new endpoint is shown once, by the server, to the run that
  creates it.** `tula apply` never prints it unless asked and removes it from every line it
  writes from the moment it arrives. A plan that creates an endpoint is refused, with or
  without `--yes` and before anything is written, until the run says what to do with it:

  | Option | |
  | --- | --- |
  | `--secrets-file <path>` | write the secrets to a **new** file only you can read (mode 0600), as JSON: `[{ "id", "url", "secret" }]`. **Nothing that is at the path is ever replaced**: the file is created exclusively, in one step, before the first write, so a file that is there (whatever it holds, an earlier run's secrets or an empty list), a symbolic link, a named pipe or a directory is refused, also one that appears a moment before. It is rewritten after every endpoint, so a run that fails part-way has kept what it was given; before each rewrite it is read back, and if it no longer holds what this run wrote (somebody replaced it) it is not written over. That last check and the rewrite are two steps: a replacement made exactly between them is not protected. A file this run created and wrote nothing into is removed again |
  | `--show-secrets` | print each secret on standard output, under its endpoint's line (with `--json`: in `webhookSecrets`). Not for a pipeline whose log is kept |
  | `--discard-secrets` | keep nothing. Rotate the secret later to get one ([rotating a secret](webhooks.md#rotate-a-secret)); for the 24 hours of that rotation's overlap deliveries are also signed with the first secret, which nobody holds, and that is harmless |

  Give the secret to the receiver, then delete the file. If a secret cannot be written to
  the file after its endpoint was created (the disk is full), the run stops and says so in
  those words: the endpoint exists, its secret was not kept, rotate it to get one. It is
  printed then only if `--show-secrets` was given too, and the closing line counts only what
  is in the file.
- **Order.** Webhook endpoints are written **after** the settings and every provider:
  nothing about signing in waits for them, and an address the server refuses does not stop a
  settings change that was safe to make. Among themselves: changes to existing endpoints,
  then new ones, then removals, so an address being replaced is never without an endpoint.
  An environment has at most 10 endpoints; when the new ones do not fit beside the ones
  being removed, exactly as many removals as it takes go first (the oldest of those being
  removed anyway), and the plan says so (`! the environment is at its limit of 10 webhook
  endpoints: 1 of the removals is made before the new endpoint is created, to make room`).
  A plan that would leave more than 10 is refused whole.
- **An address the server has more than once cannot be matched.** The API allows two endpoints
  with one address. If the file names such an address, `tula` cannot tell which one is meant
  and does not guess: `tula diff` prints the plan and fails (exit `1`), `tula apply` writes
  nothing, and the message gives the ids so that all but one can be removed by hand.
- **Someone else's change.** Endpoints have no revision, so a webhook write cannot be made
  conditional the way the settings' is. Instead `apply` reads the endpoints once more just
  before its first webhook write (if that read fails, it says so and writes nothing to them)
  and stops, writing nothing to them, if an endpoint was
  added, removed or changed (address, event types, switch) since the plan was made. That
  catches a change made while a person read the plan. It does **not** catch one made in the
  moment between that read and the writes: such a change to a field the plan also changes is
  overwritten. A change only sends the fields that differ, so a concurrent change to another
  field of the same endpoint survives; an endpoint removed meanwhile fails its write and is
  reported. `--expect-revision` is about the settings only.
- **A failure part-way** is reported as for every other write: what was applied, what was
  not. An address the server will not call shows the API's code and its one fixed word for
  the rule, and nothing else:

  ```
  Failed: webhook https://hooks.example.com/tula: create
  error: The server cannot deliver to that address. (webhook.url_not_allowed, HTTP 422)
    reason: resolve_failed
  ```

In the plan:

```
Webhooks
  + https://api.northline.app/webhooks/tula: create (eventTypes "user.created" "user.deleted"; a signing secret is made, shown once)
  ~ https://ops.northline.app/hooks: update (eventTypes +"session.created" -"user.updated")
  = https://old.northline.app/hooks: unmanaged (on the server, not in the file; --prune removes it, with its pending deliveries and its delivery log)

  ! creates 1 webhook endpoint: its signing secret is shown once, to the run that creates it (`tula apply` needs --secrets-file <path>, --show-secrets or --discard-secrets)
```

**An address is printed**, by `tula diff` and `tula apply`, in the plan, in every line about
its endpoint and so in a pipeline's log. A secret never is: no read of the API returns one.
So an address must not hold a secret:

- A user name or a password in front of the host (`https://user:password@host/…`) is refused
  when the file is loaded, by position (`webhooks.1.url`) and without the value. The server
  refuses such an address too, but `tula diff` would have printed it first.
- A token in the path or the query is **not** refused (the server allows it) and is printed
  like the rest of the address. Prefer the signature to a token in the address.

## Hooks

An environment's [hooks](hooks.md) can be written in the file, by the point each is asked
at. A hook is a question whose answer decides what happens next; it is not a webhook, and
the two keys are managed apart.

<!-- snippet: examples/tula-config/tula.config.ts#hooks -->
```ts
// The questions this environment asks before it acts, by point: at most one hook per
// point. There is no secret to write here either. What an entry leaves out is the
// API's default: on, a deadline of two seconds, and `failureMode: 'deny'` (a call that
// fails refuses what was asked about). `dev` has no `hooks` key: its hooks are not
// managed by this file.
hooks: {
  before_sign_up: { url: 'https://api.northline.app/hooks/tula/sign-up' },
  before_token: { url: 'https://api.northline.app/hooks/tula/claims', deadlineMs: 1000 },
},
```
<!-- /snippet -->

- **No `hooks` key: not managed.** `tula` does not read the environment's hooks, never
  changes one and says nothing about them, also with `--prune`. A file written before hooks
  could be in it keeps the fingerprint it had. `hooks: {}` is different: it manages the
  hooks and says there should be none (and, with `--prune`, removes the ones there are).
- **A hook is its point.** An environment has at most one hook per point, so the point is
  what a hook in the file is matched to. Changing the address of a point's hook is an
  **update**: the hook keeps its id and its signing secret. (A webhook endpoint is its
  address; a hook is not.)
- **What an entry leaves out is the API's default**, and is managed: `enabled: true`,
  `deadlineMs: 2000`, `failureMode: 'deny'`. An entry is the whole hook. **A change made in
  the dashboard to a hook's switch, deadline or failure mode is reverted by the next
  `tula apply`, and `tula diff` shows it in the plan first.** So a hook someone
  switched off in the dashboard is switched on again by a file that does not say
  `enabled: false`, and a hook set to `allow` there goes back to `deny`. A check that
  silently stays off or loosened would be the worse surprise.
- **A point the file leaves out is left alone** and shown as *unmanaged*, as a provider is.
  `--prune` removes its hook.
- **A point this version of `tula` does not know** (a later server's) is shown and never
  touched, also with `--prune`.
- **There is no secret in the file.** The entry has no field for one: a `secret` key does
  not compile and is refused when the file is loaded. The server makes the signing secret
  when the hook is registered and shows it once, to the run that creates it. `tula apply`
  treats it exactly as it treats a new webhook endpoint's
  ([above](#webhook-endpoints)): a plan that creates a hook is refused, before anything is
  written, without `--secrets-file <path>`, `--show-secrets` or `--discard-secrets`; the
  secret is removed from every line the run writes unless `--show-secrets` was given; and a
  secret that could not be written to the file is said as not kept, with its hook reported
  as created.
- **One secrets file for both.** The file is one JSON list. A webhook endpoint's entry is
  `{ "id", "url", "secret" }`, as it has always been; a hook's begins with the point:
  `{ "hook": "before_sign_up", "id", "url", "secret" }`. A run that creates only endpoints
  writes what it wrote before hooks existed. With `--json --show-secrets` the hooks' secrets
  are in `hookSecrets`, beside `webhookSecrets`.
- **A hook's secret cannot be rotated.** With `--discard-secrets`, or after a secret that
  was not kept, the only way to get one is to remove the hook and add it again. Until then
  its receiver cannot verify a question, so with `failureMode: 'deny'` what the hook guards
  is refused. Prefer `--secrets-file`.
- **What weakens.** The rule is the server's own (`hookWeakenings`, the one behind the audit
  log's `weakened`), and the plan lists each case under `! weakens security` by its path:

  | In the plan | Path | |
  | --- | --- | --- |
  | a hook created with, or changed to, `failureMode: 'allow'` | `hooks.<point>.failureMode` | a call that fails no longer refuses |
  | a hook switched off (`enabled: false` where it was on) | `hooks.<point>.enabled` | the check is gone |
  | a hook that is on, removed (`--prune`) | `hooks.<point>` | the check is gone |

  `tula apply --yes` refuses such a plan, before any write, without `--allow-weaker`. There
  is no separate flag for removing a hook: unlike a webhook endpoint's, a hook's removal
  deletes no log, and what it costs is exactly the weakening. **Adding a hook that refuses
  on failure (`deny`, the default) is not a weakening**, and neither is removing one that
  was already off, switching one on, or going from `allow` to `deny`. Adding a `deny` hook
  is still a change to who can sign in: if its endpoint does not answer, every sign-up or
  sign-in it guards is refused from that moment. Deploy the receiver first.
- **Order.** Hooks are written last: after the settings, every provider and every webhook
  endpoint. An endpoint registered in the same run is then there for the `hook.*` events
  the hook writes produce, and an address the server refuses for a hook does not stop
  anything about signing in. Among themselves: new hooks, then changes that weaken nothing,
  then changes that weaken, then removals. What tightens is in place before anything is
  loosened, so a run that fails part-way has not left the environment weaker than the file
  says and weaker than it was.
- **Someone else's change.** Hooks have no revision either. `apply` reads them once more
  just before its first hook write and stops, writing nothing to them, if one was added,
  removed or changed (address, switch, deadline, failure mode) since the plan was made; if
  that read fails it says so and writes nothing to them. As for webhook endpoints, that
  catches a change made while a person read the plan and not one made in the moment between
  the read and the writes. The server refuses a write to a hook that changed between its
  own read and write (`resource.conflict`), which is reported as a failed operation.
- **An address is printed**, as an endpoint's is, and one with a user name or a password is
  refused when the file is loaded, by position (`hooks.before_sign_up.url`) and without the
  value.

In the plan:

```
Hooks
  ~ before_sign_up: update (deadlineMs 2000 → 800, failureMode "deny" → "allow")
  + before_session: create (url https://api.northline.app/hooks/tula/session, enabled true, deadlineMs 2000, failureMode "deny"; a signing secret is made, shown once)
  - before_token: remove (https://api.northline.app/hooks/tula/claims), with its signing secret

  ! weakens security: hooks.before_sign_up.failureMode, hooks.before_token (`tula apply --yes` needs --allow-weaker)
  ! creates 1 hook: its signing secret is shown once, to the run that creates it (`tula apply` needs --secrets-file <path>, --show-secrets or --discard-secrets)
```

## Pointing the CLI at an environment

The environment a run changes is decided by the **secret key**, not by the name in the file.
The name only picks the entry and the variables:

| | Looked up in this order |
| --- | --- |
| API URL | `--api-url`, `TULA_API_URL_<NAME>`, `TULA_API_URL` |
| Secret key | `--secret-key-file <path>` (`-` reads standard input), `TULA_SECRET_KEY_<NAME>`, `TULA_SECRET_KEY` |

`<NAME>` is the entry's name in capitals (`prod` → `TULA_SECRET_KEY_PROD`, `prod-eu` →
`TULA_SECRET_KEY_PROD_EU`). Neither value is ever read from the config file.

There is no `--secret-key` option, on purpose: a command line is saved in shell history and
visible in process lists and CI logs. Mint a key with `bun run api-key:create --environment <id>`.

- **The API URL must be https**, or this machine (`localhost`, `*.localhost`, `127.0.0.1`,
  `[::1]`). Over plain http the secret key and every provider secret cross the network in
  clear text, so `http://auth.example.com` is refused before anything is sent
  (`client.invalid_url`). `--insecure-http` allows it, for a private network you trust.
- **A key file should be yours alone.** If the file given as `--secret-key-file` can be read by
  the group or by others, the CLI warns once on standard error (`chmod 600 <file>`). The check
  is skipped on Windows.
- **`--secret-key-file -` reads a pipe, never a terminal**: typed at a terminal the key would
  be shown on screen, so that is refused. Standard input then cannot answer a question either,
  so `tula apply --secret-key-file -` needs `--yes`.

## `tula diff`

```sh
export TULA_API_URL=https://auth.example.com
export TULA_SECRET_KEY=…
tula diff --env prod
```

```
Environment "prod" at https://auth.example.com (settings revision 7)

Settings
  ~ app.name: "Tula" → "Northline"
  ~ urls.allowedOrigins: +"https://app.northline.app" -"http://localhost:5173"
  ~ mfa.policy: "required" → "optional"
  kept as on the server (not in the file): password

Providers
  + google: create (clientId "1234567890-abc.apps.googleusercontent.com", enabled true, secret set from $GOOGLE_CLIENT_SECRET)
  = github: unmanaged (on the server, not in the file; --prune deletes it)

  ! weakens security: mfa.policy

Changes pending. Run `tula apply` to make them.
```

- `+` added, `~` changed, `-` removed, by path. Allowed origins, redirect URLs and
  the countries text messages may go to (`sms.allowedCountries`) are sets:
  their order is not a change, and a change shows the entries added and removed.
  One thing does read the order of `urls.allowedOrigins`: a texted code is bound to the host
  of its **first** entry ([phone numbers](phone-numbers.md)). Reordering the list changes that
  line of the message, and `diff` shows nothing for it: write the origin your users type the
  code on first.
- JWT templates (`sessions.jwtTemplates`) are a set by name, and a template's claims a set by
  key: their order is not a change. A claim is one value: a changed claim is one line at
  `sessions.jwtTemplates.<name>.claims.<key>` with the claim before and after, never a line
  for its `from` or `value` alone. A file with no template, and a profile with no
  `jwtTemplate`, hash as they did before templates existed.
- A secret is never shown. A provider line says `secret set from $NAME` or
  `stored secret kept`. `diff` does not even read the variable.
- `! weakens security` uses the server's own definition (the one behind the audit log's
  `weakened` flag): a weaker password policy, a security notice switched off, an MFA policy
  moved towards `off`, sessions that live longer, custom claims taken away from a profile's
  sessions or redefined (`sessions.profiles.<name>.jwtTemplate`: a backend reads a missing
  claim as "no"; adding a template or a claim, and editing a template no profile uses, are
  ordinary changes), an audit retention period set or shortened. `tula apply --yes` refuses such a plan without `--allow-weaker`, and `diff`
  says so under the plan.
- A [hook](#hooks) is flagged by the same rule the server records it by: created with or
  changed to `failureMode: 'allow'` (`hooks.<point>.failureMode`), switched off
  (`hooks.<point>.enabled`), or removed while it is on (`hooks.<point>`). The settings'
  paths come first in the list, then the hooks'.
- `audit.retentionDays` is flagged **when applying would delete entries**: the file sets a
  period where the server keeps entries for ever (`null`, which is also what leaving it out
  means), or a shorter period than the server has. A longer period, the same one, or none
  where there was one is an ordinary change. The plan then has a second line,
  `! deletes audit entries older than N days, for good, starting with the next retention run
  (every ten minutes; a large backlog takes several)`: nothing brings them back. At a
  terminal the question `tula apply` asks says so too ("This DELETES audit entries older
  than N days, for good"). The
  first apply of a file that sets a period to an environment that has none is such a plan.
- `! the server has settings this version of tula does not know (…)`: the server is newer
  than the CLI. Applying would reset those settings to their defaults, so `tula apply` refuses
  without `--allow-unknown`. Upgrade `tula` instead.
- `! the settings were changed outside the config file since the last apply`: someone saved
  in the dashboard or through the API. The differences are in the plan.
- `--json` prints the same plan as data: `weakened` and `unknown` list the paths, `webhooks`
  holds the endpoints, `hooks` the hooks (`{ "managed", "hooks" }`), `blockers` the reasons
  the plan cannot be applied at all, and
  `applyRequires` (`{ "allowUnknown": false, "allowWeaker": true, "allowWebhookRemoval":
  false, "webhookSecrets": false, "hookSecrets": false }`) says what `apply` will ask for:
  the three flags, and a word on the signing secrets of the endpoints and of the hooks it
  creates.

| Exit code | Meaning |
| --- | --- |
| `0` | the environment is as the file says |
| `2` | there are changes to apply |
| `1` | an error: bad config, bad key, the API refused or could not be reached, or a plan that cannot be applied (a webhook address the server has twice, more than 10 endpoints) |

## `tula apply`

```sh
tula apply --env prod          # prints the plan, asks, then applies
tula apply --env prod --yes    # no question: for CI
```

- It asks before changing anything; only the word `yes` continues. The question is written
  to standard error, so `tula apply > plan.txt` still asks. Without a terminal (standard input
  and standard error) it refuses unless `--yes` is given, so a pipeline never hangs on a
  question.
- **A plan that weakens security needs a person, or a flag.** At a terminal the question
  itself names it (`This WEAKENS security (mfa.policy). Apply these changes …?`). With `--yes`
  nobody reads the warning, so the run is refused and nothing is written unless
  `--allow-weaker` is given too:

  ```
  error: This plan weakens security (mfa.policy), and with --yes nobody is asked. Nothing was
  changed. Pass --allow-weaker with --yes to apply it.
  ```
- **Settings this version does not know are never reset silently.** When the server has a
  setting the CLI's version of the contract does not (a newer server), replacing the document
  would put it back to its default. `apply` refuses, with or without `--yes`, names the paths
  and writes nothing. Upgrade `tula`; `--allow-unknown` applies anyway.
- **It never overwrites a change made elsewhere.** The settings are replaced only if they are
  still at the revision the plan was made against (`If-Match`). If someone saved in between:

  ```
  error: The settings were changed by someone else after this plan was made. Nothing was
  written to the settings. Run `tula diff` again and review the new plan.
  ```

  To apply exactly the plan a reviewer saw, pass the revision `diff` printed:
  `tula apply --env prod --yes --expect-revision 7`.
- **Order.** The server will not leave an environment with no way to sign in, so `apply`
  enables what the new state relies on before it removes anything: a new provider before the
  password is switched off; the settings before a provider is switched off or deleted.
- **If a write fails part-way**, it stops and says exactly what was applied and what was not.
  Run it again: it starts from what the server has now and finishes the rest.
- **Provider secrets** are read from their variables when the provider is written: when it is
  created, when its client id (or Apple's team or key id) changes, or with `--rotate-secrets`.
  A missing variable stops the run before anything is written. Switching a provider on or off
  does not need its secret.
- Errors show the API's code and, for a refused document, each field's path:

  ```
  error: Some fields are invalid. (validation.failed, HTTP 422)
    signIn.methods: at least one sign-in method must stay enabled
  ```

| Option | |
| --- | --- |
| `--env`, `-e <name>` | the entry in the file; may be left out when it has one |
| `--config`, `-c <path>` | default `tula.config.ts` in the current directory |
| `--yes`, `-y` | apply without asking |
| `--prune` | delete providers, and remove webhook endpoints and hooks, that the server has and the file does not list |
| `--rotate-secrets` | send every managed provider's secret again |
| `--expect-revision <n>` | apply only if the settings are still at this revision |
| `--allow-weaker` | with `--yes`: apply a plan that weakens security (the settings, or a [hook](#hooks)) |
| `--allow-unknown` | apply although the server has settings this version does not know (they are reset) |
| `--allow-webhook-removal` | with `--yes`: apply a plan that removes a webhook endpoint, with its pending deliveries and its delivery log |
| `--secrets-file <path>` | write the signing secrets of the webhook endpoints and the hooks the run creates to a new file (mode 0600) |
| `--show-secrets` | print them |
| `--discard-secrets` | keep none of them |
| `--insecure-http` | allow a plain http API URL that is not localhost (a private network you trust) |
| `--secret-key-file <path>` | read the secret key from a file; `-` for standard input (piped, with `--yes`) |
| `--json` | print the plan (and what was applied) as JSON |

Exit code `0`: applied, or nothing to do. `1`: an error, or the confirmation was declined.

## In CI

Gate pull requests on the plan, apply on merge. `tula diff` exits `2` when there are changes,
which is not a failure in a pull request: it is the thing to review.

```yaml
# .github/workflows/tula-config.yml
name: tula config
on:
  pull_request:
    paths: [tula.config.ts]
  push:
    branches: [main]
    paths: [tula.config.ts]

jobs:
  plan:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - name: Show what merging would change in production
        env:
          TULA_API_URL: ${{ vars.TULA_API_URL }}
          TULA_SECRET_KEY: ${{ secrets.TULA_SECRET_KEY_PROD }}
        run: |
          set +e
          bunx tula diff --env prod
          code=$?
          # 0: nothing to apply. 2: changes, shown above for the reviewer. Anything else fails.
          if [ "$code" -ne 0 ] && [ "$code" -ne 2 ]; then exit "$code"; fi

  apply:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    environment: production        # put a required reviewer on this environment
    steps:
      - uses: actions/checkout@v7
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - name: Apply
        env:
          TULA_API_URL: ${{ vars.TULA_API_URL }}
          TULA_SECRET_KEY: ${{ secrets.TULA_SECRET_KEY_PROD }}
          GOOGLE_CLIENT_SECRET: ${{ secrets.GOOGLE_CLIENT_SECRET }}
          APPLE_PRIVATE_KEY: ${{ secrets.APPLE_PRIVATE_KEY }}
        # --yes alone never weakens security, never resets a setting a newer server has and
        # never removes a webhook endpoint: such a plan fails this step. Each on purpose is
        # its own, reviewed change:
        #   bunx tula apply --env prod --yes --allow-weaker
        #   bunx tula apply --env prod --yes --prune --allow-webhook-removal
        # --secrets-file matters only to a run that creates a webhook endpoint: the server
        # shows its signing secret once. Without the option such a run is refused.
        run: bunx tula apply --env prod --yes --secrets-file "$RUNNER_TEMP/tula-webhook-secrets.json"
      - name: Hand new webhook secrets to the secret store
        # The file exists only when an endpoint was created. Store it where the receiver
        # reads its secret (your vault's CLI goes here), and never print it: a log is kept.
        run: |
          file="$RUNNER_TEMP/tula-webhook-secrets.json"
          if [ -s "$file" ]; then
            your-vault put tula/webhook-secrets < "$file"
            rm "$file"
          fi
```

If your pipeline has nowhere to put a secret, use `--discard-secrets` there and rotate the
secret by hand afterwards; do not use `--show-secrets` in a pipeline.

A plan that weakens security (the pull request's `diff` output says
`tula apply --yes refuses this plan without --allow-weaker`) fails the apply job as written.
That is deliberate: add `--allow-weaker` in the same pull request that weakens the config, so
the flag is reviewed with the change, and take it out again afterwards.

To fail a scheduled job when production has drifted from the file, use the exit code as it
is: `tula diff --env prod` fails the step on `2`.

The plan job needs no provider secret. Use a secret key of its own for it if you can: it only
reads, but a secret key is a secret key.

## "Managed by a config file"

When `apply` writes the settings it records itself and the file's fingerprint with them. The
admin API then answers:

```json
"managedBy": {
  "tool": "tula-apply",
  "configHash": "sha256:9f2c…",
  "at": "2026-10-04T09:12:00.000Z",
  "revision": 8,
  "drifted": false
}
```

A dashboard uses this to say the settings come from a file. `drifted` turns `true` when the
settings are saved again *without* going through `apply`; the audit entry of that save carries
`outsideConfig: true`. The next `apply` puts the file back in charge. A write that only
changes this record (a first apply over identical settings, a new version of the file) still
bumps the settings revision. The fingerprint is
computed over the file's content with each secret as its variable's **name**; it says nothing
about a secret's value. Providers and webhook endpoints are not covered by `drifted` (they
have no revision): `tula diff` is the full check. The fingerprint covers the `webhooks` list
(event types as a set), so a change to it is a new version of the file; a file without the
list has the fingerprint it had before the list could be written.

## What `tula` runs on

`tula` is a Bun program (`#!/usr/bin/env bun`): it imports your `tula.config.ts` directly,
which Bun runs as it is. `@tula/config` and `@tula/admin` also run on Node; `loadConfig` on
Node needs 22.18 or later for a TypeScript file, or a `.js` config.

The config file is **code that runs** when the CLI loads it, like a build script. Review
changes to it the way you review code.
