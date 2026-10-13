# @tula-tech/cli

## 0.1.0-alpha.1

### Patch Changes

- @tula-tech/mcp@0.1.0-alpha.1
  - @tula-tech/admin@0.1.0-alpha.1
  - @tula-tech/config@0.1.0-alpha.1
  - @tula-tech/contract@0.1.0-alpha.1

## 0.1.0-alpha.0

### Minor Changes

- a34eb0e: `tula approve <proposal id>` approves a change an AI agent proposed: it prints what would
  happen and to whom, asks, and approves exactly what it printed, with your secret key.
  `tula mcp` takes an agent key (`TULA_AGENT_KEY`, `TULA_AGENT_KEY_<NAME>` or
  `--agent-key-file`); with one it serves the propose tools and does not read the secret
  key at all.
- 1c76ead: App-link and custom-scheme redirects ([docs/native-apps.md](../docs/native-apps.md),
  ADR 0044).
  
  - `@tula-tech/contract`: a new Zod-free entry point, `@tula-tech/contract/redirect-url`
    (`redirectUrlKind`, `isRedirectUrl`, `isCustomSchemeRedirectUrl`,
    `REDIRECT_SCHEMES_NEVER_CUSTOM`, `OAUTH_PROVIDERS_WITH_PKCE`,
    `OAUTH_PROVIDERS_WITHOUT_PKCE`, `bindsCodeWithPkce`, `customSchemeRedirectRefusal`).
    `urls.allowedRedirectUrls` accepts a custom scheme in reverse-domain form
    (`com.example.app:/oauth`); listing one is a weakening (`urls.allowedRedirectUrls`). A
    web entry must now start with `https://` or `http://` as written. A native app has
    `appLinkPaths` (`isAppLinkPath`, `normalizeAppLinkPaths`, `MAX_APP_LINK_PATHS`); the two
    file builders serve `applinks` and `handle_all_urls` for an app that has some;
    `nativeAppWeakenings` reports a gained path; the `native_app.*` events carry a count of
    paths. `request.redirect_not_allowed` may carry `params.reason`.
  - `@tula-tech/admin`: the generated types have `appLinkPaths` on a native app and on its create
    and update bodies.
  - `@tula-tech/config`: `appLinkPaths` on a `nativeApps` entry.
  - `@tula-tech/cli`: `tula diff` and `tula apply` plan `appLinkPaths` as a set. Left out of an
    entry the paths are unmanaged (kept, and the diff says how many the server has); written,
    also as `[]`, the list is the whole set. A gained path is `nativeApps.<platform>/<identifier>.appLinkPaths` and needs
    `--allow-weaker` under `--yes`, as does a custom-scheme redirect URL the file adds.
- 5e7c061: `tula approve` requires a terminal, and `--yes` is removed from it. The question (which
  names the operation and what it is carried out on) is asked at a terminal and answered by
  typing `yes`; where standard input and standard error are not both a terminal the command
  refuses before it reads or changes anything, whatever options it was given. `--json` still
  asks, and prints the proposal on standard error first. `--secret-key-file -` is refused
  for this command: standard input is where the answer is typed, so the key comes from a
  file or the environment.
  
  An approval is a person's act with their own credential: an assistant that can run shell
  commands can no longer approve its own proposal by running the command non-interactively.
  The cost is that nothing approves through `tula approve` from a script or CI. It does not
  stop a program that drives a pseudo-terminal; what does is keeping the secret key away
  from the assistant. `tula apply --yes` is unchanged.
- 55115bc: `tula approve` shows a session with whose it is and whether it is still live, and says
  when an approval found nothing left to change.
  
  - **A session in the question.** For `end_session` the command reads the session and its
    user with the operator's key and prints the owner's id, address and name, the kind of
    client, when the session was signed in and "live now" or "already ended". A read that
    fails is said in fixed words beside the id ("could not be read", "no such session now")
    and is never guessed. The user agent and the IP address are not printed.
  - **`GET /v1/admin/sessions/{sessionId}`** (`getSession` in `@tula-tech/admin`) reads one
    session of an environment by its id: the session list's shape with `userId` and `active`
    (`AdminSessionSchema` / `AdminSession` in `@tula-tech/contract`). An unknown id and another
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
- 2d26c53: The CLI (ADR 0031): `create-tula`, `tula dev`, `tula doctor` and `tula policy test`.
  
  - `create-tula` (new): scaffolds a project. A Compose file with service images pinned by
    digest, a `.env` (mode 0600) with a generated master key, instance admin token and database
    passwords, a `.gitignore` that covers it, `tula.config.ts`, and the example app of the
    chosen framework (`--framework react-vite | nextjs`). It refuses a directory that is not
    empty (`--force`), an unsafe project name, and never replaces an existing `.env`.
    `--tula-packages <dir>` installs the `@tula-tech/*` packages from local tarballs while nothing is
    published; `--api-image` names the API image.
  - `@tula-tech/cli`: `tula dev` starts the project's Compose stack, runs the migrations and the seed
    with the commands the API image ships, mints a publishable and a secret development key into
    its own block of `.env.local` (a second run reuses them; the user's own lines are never
    changed; the secret key is printed only with `--show-keys`) and prints the URLs.
    `tula dev down [--volumes]` stops it. `tula doctor` checks a deployment from this machine
    and through `GET /v1/instance/diagnostics`, with a fix under every check that is not ok
    (`--json`, `--strict`; exit 1 when a check fails). `tula policy test` shows which rules of
    an environment's password policy a password passes: the password is asked for without echo
    or read from standard input, evaluated on this machine and never sent or printed (exit 2
    when it would be refused).
  - Hardening after review: `tula dev` closes `.env.local` to mode 0600 on every run (the
    `Host` interface gains `restrictFile`) and finds its block even when a line of yours
    mentions the end marker; `tula doctor` never requests an address the server names unless
    it is the API URL's own origin; `create-tula` writes `.gitignore` first and `.env` last,
    merges into an existing `.gitignore` under `--force`, and refuses a symbolic link at any
    path it would write.
  - `@tula-tech/admin`: `createInstanceClient({ baseUrl, adminToken })` for the instance routes
    (`/v1/instance/*`), generated from the contract like the admin client; a response now
    carries the server's `Date` header.
- 9166270: Settings as code (ADR 0030): `tula.config.ts`, `tula diff` and `tula apply`.
  
  - `@tula-tech/admin` (new): a typed client for every `/v1/admin/*` operation, generated from the
    OpenAPI contract. `createAdminClient({ baseUrl, secretKey })`, one `call(operationId, input)`
    function, one error class (`TulaAdminError`) carrying the contract's code, field errors and
    `Retry-After`. Server-side only: it refuses a publishable key, refuses to be created in a
    browser, and its `browser` export condition resolves to a module that throws. A plain
    `http:` `baseUrl` is refused unless the host is this machine or `allowInsecureHttp` is set,
    and a path parameter that is not a single path segment is refused before the request
    (`client.invalid_param`).
  - `@tula-tech/config` (new): `defineConfig()` for `tula.config.ts`, validated with the contract's
    schemas. One file describes several environments: the settings document and the OAuth
    providers of each. A provider's secret is `env('NAME')` and nothing else; a literal is a type
    error and a load error. `loadConfig()`, `selectEnvironment()`, `hashEnvironmentConfig()`.
  - `@tula-tech/cli` (new): the `tula` executable. `tula diff` prints what would change and exits 2
    when something would; `tula apply` asks, then replaces the settings under `If-Match` and
    creates, updates or (with `--prune`) deletes providers, in an order the server accepts.
    `apply` refuses a plan that would reset settings this version does not know
    (`--allow-unknown`) and, with `--yes`, one that weakens security (`--allow-weaker`).
    `--insecure-http` allows a plain http API URL that is not localhost. A key file readable by
    others is warned about, and `--secret-key-file -` is refused at a terminal.
  - `@tula-tech/contract`: `settingsWeakenings()` (the one definition of "weakened", now shared by
    the server's audit entry and the CLI's warning), `SettingsManagedBySchema`, and the headers
    `x-tula-managed-by` / `x-tula-config-hash` with which a replace records the tool and config
    that manage an environment's settings. `GET /v1/admin/settings` answers `managedBy`
    (additive; `null` when nobody manages them), with `drifted` once they are changed around
    the file.
- 849ff94: `tula dev --tunnel` starts the local stack under a public https address (this machine's
  Tailscale Funnel name), so that a phone can reach it. The address is written into the
  command's own block of `.env.local`; the settings that name it are printed, not written;
  and the run refuses to start beside the mock provider or the development SMS inbox, which
  the API serves on a loopback address only. `tula dev down`, and `tula dev` without the
  flag, close the tunnel again, and so does a run that fails or is interrupted (Ctrl-C);
  where the tunnel is opened is recorded in the block before it is opened, so a run that
  was killed outright can still be closed by `tula dev down`. The scaffolded Compose file reads the API's `PUBLIC_URL`
  from `TULA_PUBLIC_URL`, which only that command sets.
- f3216d0: A device-binding option on a session profile
  ([docs/device-binding.md](../docs/device-binding.md), ADR 0043): `deviceBinding` is `none`,
  `optional` or `required`. Under `required` a native app that starts a sign-in without a
  device key is refused; under `none` one that brings a key is. Browsers are not affected by
  any value. The default is `none` for the `web` profile and `optional` for every other, which
  is how sessions behaved before. A change applies to new sign-ins only.
  
  - `@tula-tech/contract`: `DeviceBindingPolicySchema`, `DeviceBindingPolicy`,
    `defaultDeviceBinding(name)` and `WebSessionProfileSchema`; `deviceBinding` on a session
    profile; the error code `device.binding_required` (400); `deviceBound` on `SessionSchema`
    (the session lists); and `settingsWeakenings` lists
    `sessions.profiles.<name>.deviceBinding` when a profile asks less for a key.
  - `@tula-tech/core`: the message of `device.binding_required`, which never ends the local
    session; `session.list()` entries carry `deviceBound`.
  - `@tula-tech/react`: `<UserProfile>` marks a session that is bound to a device key, in words
    (`userProfile.deviceBound`).
  - `@tula-tech/admin`: the generated types carry the option, the code and `deviceBound`.
  - `@tula-tech/config`: `deviceBinding` on a profile in `tula.config.ts`. Left out, it is the
    profile's default and is not part of the file's hash.
  - `@tula-tech/cli`: `tula diff` shows the option and flags a profile that asks less as
    `! weakens security`; `tula apply --yes` refuses that without `--allow-weaker`.
  - `@tula-tech/mcp`: `list_user_sessions` returns `deviceBound` (a yes or no, never a key) and
    `get_settings` a profile's `deviceBinding`.
- 9d2a864: `tula diff` says how many accounts could not sign in without a provider the plan switches
  off or removes ("at least" when the server did not look at every account), and lists it as
  a weakening: `tula apply --yes` refuses such a plan without `--allow-weaker`, before any
  write (ADR 0059). A server from before the count (it answers the API's own 404 for an
  unknown route) is planned as before. A count that could not be read for any other reason (a refusal, a limit, a failure,
  no answer) flags the plan too: `tula apply --yes` is not let through by a request that
  failed, and the diff says the count could not be read.
  
  `tula approve` says, in its question for a proposal that switches a provider off, how many
  accounts can sign in only with that provider (fixed words when the count could not be read
  or the server has none; never a guess).
- bce497c: Email templates: an environment's own subject and wording for each email
  (`emails.templates` in the settings, keyed by the kind of message).
  
  - `@tula-tech/contract` gains the kinds, the placeholders and the rules of each kind
    (`EMAIL_TEMPLATE_KINDS`, `EMAIL_TEMPLATE_PLACEHOLDERS`, `EMAIL_TEMPLATE_RULES`), the
    checks (`emailTemplateProblems`, `readsAsLink`, `parseEmailTemplate`) and the schemas
    (`EmailTemplateSchema`, `EmailTemplatesSchema`, `EmailSettingsSchema`). The settings
    document has a new section, `emails`, with no template by default: an environment that
    has saved nothing sends the email it always did.
  - A template is text with `{{name}}` placeholders. One that lacks the code or the link its
    message needs is refused when saved, and so is one of any kind that holds something that
    reads as a link, an address or a domain name (`EMAIL_LINK_SCHEMES`): the only link in an
    email is the server's own. A security notice can be given no code and no link, its
    subject cannot start with a digit (`EMAIL_TEMPLATE_DIGIT_PLACEHOLDERS`), and it always ends
    with the server's own facts and its own sentence of what to do if the reader did not do
    what the notice reports. A text-direction control, a private-use or unassigned character
    and a lone surrogate are refused (`hidden_character`), never stripped.
  - `app.name` is refused, when it is set, if it holds a text-direction control, a
    private-use or unassigned character or half a surrogate pair. A name already stored is
    still read.
  - `@tula-tech/config` accepts `settings.emails.templates`, validated when the file is loaded. A
    file with no template hashes as before.
  - `tula diff` shows a template field by field (`emails.templates.<kind>.subject`), and
    `tula apply` removes the template of a kind the file leaves out, as for every setting.
  - `@tula-tech/admin`'s settings types include the section.
- 2483914: Hooks in `tula.config.ts` ([docs/config.md](../docs/config.md#hooks)). An environment can
  list its hooks by point (`hooks: { before_sign_up: { url, enabled?, deadlineMs?,
  failureMode? } }`); `@tula-tech/config` exports `HookConfig` and `HooksConfig`. There is no field
  for a signing secret, and an environment without the key is not read, not changed and keeps
  its fingerprint. `tula diff` plans them (a hook is its point, so a changed address is an
  update) and marks as weaker a hook that lets failures through (`failureMode: 'allow'`), one
  switched off and one that is on and removed; `tula apply --yes` refuses such a plan without
  `--allow-weaker`. A created hook's signing secret goes where a new webhook endpoint's goes
  (`--secrets-file`, `--show-secrets` or `--discard-secrets`; required before any write), and
  `--json` gains `hooks`, `hookSecrets` and `applyRequires.hookSecrets`.
- 0de4f8d: JWT templates: an environment can add custom claims to its sessions
  ([docs/jwt-templates.md](../docs/jwt-templates.md), ADR 0036). A template is a named set of
  claims under `sessions.jwtTemplates`, each read from a closed list of sources (the user's
  address, whether it is verified, when the account and the session began, the client kind) or a
  constant; a session profile names the one it uses (`jwtTemplate`). The claims are issued under
  the one claim `ext` of the access token, and in what the server answers for a stateful
  session. A token of a profile without a template is unchanged.
  
  - `@tula-tech/contract`: `JwtTemplateSchema`, `JwtTemplateClaimSchema`, `JWT_TEMPLATE_SOURCES`,
    `jwtTemplateMaxBytes`, `readStoredJwtTemplate`, `jwtTemplateOfProfile`,
    `isSessionProfileName` (the one rule for a profile's and a template's name), the optional `ext`
    on `AccessTokenClaimsSchema`, and `settingsWeakenings` reports
    `sessions.profiles.<name>.jwtTemplate` when a profile's sessions lose a claim or get a
    redefined one. A new Zod-free entry point, `@tula-tech/contract/custom-claims`:
    `CUSTOM_CLAIMS_CLAIM`, `RESERVED_CLAIM_NAMES`, the caps (`MAX_CUSTOM_CLAIMS_BYTES` and
    others), `isCustomClaimKey`, `isCustomClaimValue`, `customClaimsBytes` and
    `readCustomClaims`.
  - `@tula-tech/nextjs`: `auth()` returns `customClaims` (a read-only record of `unknown` values;
    empty when signed in with none, `null` when signed out), for token and stateful sessions
    alike, and `SessionClaims` gains the optional `ext`. An `ext` that is not what Tula issues
    is treated as absent.
  - `@tula-tech/admin`: the settings types carry `jwtTemplates` and a profile's `jwtTemplate`.
  - `@tula-tech/config`: both are part of `settings`. An environment without templates keeps the
    fingerprint it had.
  - `@tula-tech/cli`: `tula diff` compares templates by name and their claims by key, shows a changed
    claim as one value, and reports a profile whose sessions would lose claims as weaker, which
    `tula apply --yes` refuses without `--allow-weaker`.
- 8eb6b9b: The MCP server (ADR 0033): `tula mcp`.
  
  - `@tula-tech/mcp` (new): `createTulaMcpServer(options)`, a Model Context Protocol server with
    eleven tools, all read-only. Read tools over the admin API: `list_users`, `get_user` (with
    how the user signs in), `list_user_sessions`, `list_audit_entries`, `get_settings`,
    `list_oauth_providers` and `run_doctor`. Scaffold tools that need no credentials and write
    nothing: `detect_framework`, `scaffold_provider`, `scaffold_protected_route` and
    `scaffold_sign_in_page` (Next.js App Router and React with Vite), which return the example
    apps' own files for the client to write. No tool changes live data: the tools reach the API
    only through a facade over an allow-list of `GET` operations. Every result passes an
    allow-list projection (a field that is not named is dropped), has control characters removed
    and secret-shaped values replaced, and is bounded (512 characters a string, 64,000 a result).
    Characters a reader cannot see are removed before secret shapes are looked for: format
    characters (zero-width, bidirectional controls, the soft hyphen, Unicode tag characters),
    variation selectors, private-use and unassigned code points and lone surrogates; a run of
    combining marks is cut at eight. Names in any script are unchanged; a joined emoji is
    returned as its parts. Only the first 4096 characters of a value (or four times its limit)
    are looked at, and every pattern is linear. Each call's requests are aborted when it is
    cancelled or out of time; four read tools run at once, sixteen wait, the next is `busy`,
    and a call already cancelled is answered `cancelled` without taking a turn. A secret split
    by a control character or a newline is replaced whole. A record's key is cleaned before it
    is compared: an entry whose key is a duplicate or a prototype name once cleaned is left
    out and the record has `truncated: true`.
  - `@tula-tech/cli`: `tula mcp` serves it on standard input and output. Credentials come from the
    environment or a file, as for every other command (`TULA_API_URL[_<NAME>]`,
    `TULA_SECRET_KEY[_<NAME>]` or `--secret-key-file`, `TULA_ADMIN_TOKEN` or
    `--admin-token-file` for `run_doctor`); none is required. Standard output carries only the
    protocol. The server is loaded only by `tula mcp`: every other command starts without the
    MCP SDK. `examine` takes an optional `signal` that abandons a doctor run.
  - `@tula-tech/admin`: exports `OPERATIONS` and `INSTANCE_OPERATIONS` (each operation's method and
    path) and the `OperationRoute` type.
  - `create-tula`: the React example is split into `auth-provider.tsx`, `protected.tsx` and
    `sign-in-page.tsx`, which a scaffolded project now has; `--tula-packages` also needs the
    `@tula-tech/mcp` tarball.
- 784639a: Native app identity ([docs/native-apps.md](../docs/native-apps.md)). An environment
  registers its iOS apps (a team ID and a bundle ID) and Android apps (a package name and the
  SHA-256 fingerprints of its signing certificates) through `/v1/admin/native-apps`, and the
  server serves Apple's `apple-app-site-association` and Android's `assetlinks.json` for it
  under `/v1/environments/<id>/.well-known/`. The files name the apps for the domain's
  credentials only (`webcredentials`, `get_login_creds`); they hand an app no link.
  
  `@tula-tech/contract` gains the schemas, the identifier patterns and caps, the two file builders
  (`appleAppSiteAssociation`, `assetLinks`), `nativeAppWeakenings` and three event types
  (`native_app.created`, `native_app.updated`, `native_app.deleted`). `@tula-tech/admin` gains the
  typed operations. `@tula-tech/config` takes `nativeApps` on an environment and exports
  `NativeAppConfig`, `IosAppConfig` and `AndroidAppConfig`; an environment without the key is
  not read, not changed and keeps its fingerprint. `tula diff` plans them (an app is its
  platform and its identifier) and marks as weaker an app registered, an iOS app's changed
  team and a gained fingerprint; `tula apply --yes` refuses such a plan without
  `--allow-weaker`, writes native apps last, and `--json` gains `nativeApps`.
- 1f189d8: Native sign-in with Google's ID token
  ([docs/native-apps.md](../docs/native-apps.md#signing-in-with-google-without-a-browser),
  ADR 0045).
  
  - `@tula-tech/contract`: the two requests of the sign-in (`IdTokenStartRequestSchema`,
    `IdTokenStartSchema`, `IdTokenExchangeRequestSchema`, `ID_TOKEN_PROVIDERS`,
    `MAX_ID_TOKEN_LENGTH`). A provider's settings have `additionalClientIds`
    (`AdditionalClientIdsSchema`, `isGoogleClientId`, `MAX_ADDITIONAL_CLIENT_IDS`): the
    client ids, beside the provider's own, whose ID tokens are accepted. Google only, and
    never the provider's own `clientId` (`ownClientIdAmong`; the admin API and
    `@tula-tech/config` refuse it). A
    gained one is a weakening (`oauthProviderWeakenings`); `oauth_provider.updated` may name
    the field in `changed` and carry `additionalClientIdCount`.
  - `@tula-tech/core`: `signIn.withIdToken({ provider: 'google' })` for an `ios` or `android`
    client. It answers the server's nonce and an `exchange(idToken)` that returns the flow.
    The start carries a device proof when the client has a device key.
  - `@tula-tech/admin`: the generated types have `additionalClientIds` on a provider and on its
    update body.
  - `@tula-tech/config`: `providers.google.additionalClientIds` (`GoogleProviderConfig`). Left out
    means none. A file that names none keeps its fingerprint.
  - `@tula-tech/cli`: `tula diff` and `tula apply` plan Google's `additionalClientIds` as a set.
    The file's list is the whole set; a gained id is `providers.google.additionalClientIds`
    and needs `--allow-weaker` under `--yes`. A `ProviderChange` has `weakened`.
  - `@tula-tech/mcp`: `list_oauth_providers` returns `additionalClientIds`.
- d72fb3d: Sign in with Discord and LinkedIn.
  
  - `@tula-tech/contract`: `discord` and `linkedin` in `OAUTH_PROVIDERS`; the first-factor
    strategies `oauth_discord` and `oauth_linkedin`, which are also `user.created` methods and
    `HOOK_SIGN_UP_METHODS`, so a `before_sign_up` hook may be asked with either `method`. Each
    takes `clientId` and `clientSecret`, like Google and GitHub.
  - `@tula-tech/core` and `@tula-tech/admin`: the generated types carry the two providers and
    strategies. No run-time change.
  - `@tula-tech/react`: "Continue with Discord" and "Continue with LinkedIn" buttons on `<SignIn>`
    and `<SignUp>`, and both names under "Connected accounts". The marks are drawn inline;
    nothing is fetched. They were drawn without either brand page open: check them against
    Discord's and LinkedIn's brand guidelines before shipping.
  - `@tula-tech/config`: `providers.discord` and `providers.linkedin` (`clientId`,
    `clientSecret: env('NAME')`).
  - `@tula-tech/cli`: `tula diff` and `tula apply` manage both.
  
  LinkedIn's sign-in has no PKCE and no nonce (LinkedIn documents neither). The account is the
  `sub` of the verified ID token; the address and whether it is verified are read from
  LinkedIn's userinfo endpoint. See `docs/providers/linkedin.md` before offering it.
- 07eff2f: Sign in with Microsoft (Entra ID work and school accounts, and personal accounts).
  
  - `@tula-tech/contract`: `microsoft` in `OAUTH_PROVIDERS`; the first-factor strategy
    `oauth_microsoft`; `MicrosoftTenantSchema`, `MicrosoftTenant` and
    `MICROSOFT_TENANT_ALIASES`; `tenant` on `OAuthProviderUpdate` (required for Microsoft:
    `common`, `organizations`, `consumers` or a tenant id; a domain name is refused) and, as
    `string | null`, on `OAuthProviderSettings`; `oauth_microsoft` as a `user.created` method
    and `tenant` as a name in `oauth_provider.updated.changed`; `oauth_microsoft` among
    `HOOK_SIGN_UP_METHODS`, so a `before_sign_up` hook may be asked with that `method`.
  - `@tula-tech/core` and `@tula-tech/admin`: the generated types carry the new provider, strategy and
    field. No run-time change in `@tula-tech/core`.
  - `@tula-tech/react`: a "Continue with Microsoft" button on `<SignIn>` and `<SignUp>` and
    "Microsoft" under "Connected accounts". The mark is drawn inline; nothing is fetched.
  - `@tula-tech/config`: `providers.microsoft` (`clientId`, `clientSecret: env('NAME')`, `tenant`)
    and the type `MicrosoftProviderConfig`.
  - `@tula-tech/cli`: `tula diff` and `tula apply` manage Microsoft and its `tenant`. A change of
    tenant keeps the stored secret, as switching a provider on or off does.
  - `@tula-tech/mcp`: `list_oauth_providers` returns each provider's `tenant`.
  - `create-tula`: the scaffold's comments about the mock provider no longer list the
    providers by name.
- 82d87eb: Sign in with X and Facebook, and accounts with no email address.
  
  Neither provider is asked for an email address, so a first sign-in with either makes an
  account that has none. **`User.email` is now `string | null`** in the contract and in every
  generated type: code that reads a user's `email` has to allow for `null`. The same holds
  for the `before_sign_up` hook's question (`data.email`).
  
  - `@tula-tech/contract`: `x` and `facebook` in `OAUTH_PROVIDERS`; `OAUTH_PROVIDERS_WITHOUT_ADDRESS`
    and `givesNoAddress(provider)`, the one place that says which providers give no address;
    the strategies `oauth_x` and `oauth_facebook`, which are also `user.created` methods and
    `HOOK_SIGN_UP_METHODS`. `UserSchema.email` and `HookBeforeSignUpDataSchema.email` are
    nullable.
  - `@tula-tech/core` and `@tula-tech/admin`: the generated types carry the two providers, the two
    strategies and the nullable `email`. No run-time change. `verifyHook`'s examples check
    the address for `null`.
  - `@tula-tech/react`: "Continue with X" and "Continue with Facebook" buttons on `<SignIn>` and
    `<SignUp>`, and both names under "Connected accounts". The marks are drawn inline and
    were not checked against X's or Meta's brand guidelines. `<UserButton>` and
    `<UserProfile>` draw a user with no address by name, with no address line, no
    verification badge and no password section.
  - `@tula-tech/nextjs`: `currentUser()` may return a user whose `email` is `null`.
  - `@tula-tech/config`: `providers.x` and `providers.facebook` (`clientId`,
    `clientSecret: env('NAME')`; for Facebook the app id and the app secret).
  - `@tula-tech/cli`: `tula diff` and `tula apply` manage both.
  - `@tula-tech/mcp`: `get_user` and `list_users` return `email: null` for such a user; the
    scaffolds greet a user who has neither a first name nor an address.
  - `create-tula`: the app templates do the same.
  
  An account with no address gets no security emails, cannot sign in by emailed code or link,
  cannot have a password, and cannot be given an address yet. Switching its provider off,
  or removing the provider's credentials, locks it out until the provider is configured
  again, and nothing warns first. A JWT template's `user.email` and `user.email_verified`
  claims are both left out of its tokens (absent, not `false`); `user.created` still says
  `emailVerified: false` for it. Facebook's sign-in has no PKCE
  and no nonce (Meta documents neither for this flow). What X charges for the API call a
  sign-in makes was not confirmed. See `docs/providers/x.md` and `docs/providers/facebook.md`
  before offering either.
- 59c2709: A phone number on an account, proven with a texted code (ADR 0037).
  
  - `@tula-tech/contract`: phone numbers as plain data, exported from the index (`parsePhoneNumber`,
    `maskPhoneNumber`, `COUNTRY_CALLING_PREFIXES`, `SMS_COUNTRIES`, `isSmsCountry`,
    `phoneNumberCountries`, `isPhoneNumberAllowed`). A user gains `phoneNumber` and
    `phoneNumberVerifiedAt`. The settings gain `sms` (`enabled`, default `false`;
    `allowedCountries`, default `[]`, where empty means nothing is sent), and the client
    configuration `phone.enabled`. New error codes `phone.invalid`, `sms.disabled`,
    `sms.country_not_allowed` and `sms.unavailable`; new events `user.phone_number_added` and
    `user.phone_number_removed`, whose payload holds no number. New schemas
    `PhoneNumberRequestSchema`, `PhoneCodeSentSchema`, `PhoneNumberVerifyRequestSchema` and
    `SmsCountrySchema`.
  - `@tula-tech/core`: `client.user.phone.request({ phoneNumber })`, `.verify({ code })` and
    `.remove()` for the signed-in user, and the type `PhoneCodeSent`. The answers are checked
    before anything is built from them, and a user is installed only for the session that asked.
  - `@tula-tech/react`: `<UserProfile>` gains a "Phone number" section (add with a texted code,
    change, remove), shown where the environment can text a code or the user has a number.
    New strings under `phone` in the localization table.
  - `@tula-tech/admin`: the generated types know the three operations, the `sms` settings and a
    user's phone fields.
  - `@tula-tech/cli`: `tula diff` and `tula apply` compare `sms.allowedCountries` as a set.
  - `@tula-tech/mcp`: `get_settings` returns `sms`. A user's phone number is not returned by any
    tool.
- 99593eb: An agent can propose three more changes, each of which an administrator can put back with
  one call: lifting a ban (`unban_user`), ending one session by its id (`end_session`) and
  switching one OAuth provider off (`disable_oauth_provider`: `enabled: false`, its
  credentials kept, and refused when it would remove an environment's last way to sign in,
  when it is proposed and again when it is approved). `@tula-tech/mcp` gains
  `propose_unban_user`, `propose_end_session` and `propose_disable_oauth_provider`;
  `tula approve` shows and asks about each in words of its own.
  
  A production environment accepts proposals only where its settings say so: the new
  setting `agents.proposalsInProduction`, off by default. Switching it on is a weakening
  (recorded in the audit log, asked about in the dashboard, and refused by
  `tula apply --yes` without `--allow-weaker`). In `tula.config.ts` the key left out is
  `false`; the default does not change a config's fingerprint.
  
  Proposals are limited to five a minute for each operation, beside the ten a minute an
  environment's agents share. A proposal's `target.id` is a UUID for a user and a session
  and a provider's name for a provider; `failureReason` gains `last_sign_in_method`, and an
  approval can be refused with `production_environment`.
- 259f896: A tool, `test_signin`: an assistant checks that sign-up and sign-in work
  ([ADR 0058](../docs/adr/0058-test-signin.md)). The server runs the test and answers a
  report of each step; no token, code, attempt secret or address is in it. **It is the one
  tool that changes live data**: a throwaway user is made and deleted, the environment's
  hooks are asked and its events delivered. It runs with an agent key or a secret key, only
  where the environment's `agents.testSignIn` allows it (off in production by default), a
  few times an hour. `tula mcp` now serves 17 tools and its first line says which one
  changes data. `@tula-tech/mcp` exports `TEST_TOOL_NAMES`, `signInTester` and `TEST_OPERATIONS`;
  the read-only and proposing facades are unchanged.
- 61af5e2: Text messages in the dashboard, and a wider reach of a required texted second step is a
  weakening ([ADR 0025](../docs/adr/0025-mfa.md), [ADR 0037](../docs/adr/0037-phone-numbers-and-sms.md),
  [docs/phone-numbers.md](../docs/phone-numbers.md)).
  
  **`@tula-tech/contract`**
  
  - `settingsWeakenings` lists two more changes, both only where `mfa.smsCode` is on and
    `mfa.policy` is `required` after the change: text messages switched on or a first country
    allowed (`mfa.smsCode`), and a country added where a texted code could already be that
    second step (`sms.allowedCountries`). A save that makes either is recorded with
    `weakened: true`, asked about by the dashboard and refused by `tula apply --yes` without
    `--allow-weaker`. Nothing that was listed before is listed differently.
  - `smsCostLimits(dailyMessageLimit)`, `SMS_PREFIX_HOURLY_SHARE`,
    `SMS_ENVIRONMENT_HOURLY_SHARE` and `SmsCostLimits`: what a daily limit allows in an hour
    in all and to one destination prefix. The server holds a send to this function; it was
    the server's own before.
  - `smsPrefixCountries(prefix)`: every country of the table that a destination prefix covers.
  
  **`@tula-tech/cli`**
  
  - `tula diff` and `tula apply` say in words, under the plan, when it switches off the
    texted code as the second step (`mfa.smsCode` off in the file, or left out of it): users
    whose only second step is a texted code cannot sign in until it is on again or an
    administrator resets them. The plan is as before and is still not a weakening.
  - The same for a plan that takes a country out of `sms.allowedCountries` (the countries are
    named) and for one that switches `sms.enabled` off: users there can no longer receive a
    code. Neither changes the plan or needs a flag.
  - The two new weakenings are in `plan.weakened`.
  
  The dashboard (not published) has a **Text messages** screen: the SMS settings and both
  uses of a texted code on the one save model, whether the deployment has a sender, and the
  codes sent and never used by destination prefix.
- 73cadb2: SMS send limits and a daily limit per environment (ADR 0037).
  
  - `@tula-tech/contract`: the settings gain `sms.dailyMessageLimit` (default `500`, 1 to
    1,000,000, no value switches it off): the most text messages an environment sends in one
    UTC day. Raising it is a weakening (`settingsWeakenings` lists `sms.dailyMessageLimit`).
    New: `DEFAULT_SMS_DAILY_MESSAGE_LIMIT`, `MAX_SMS_DAILY_MESSAGE_LIMIT`,
    `phoneNumberPrefix` (a number's destination prefix: the calling prefix the country list
    matched) and `SMS_PREFIX_MAX_DIGITS`; `SmsUsageSchema` and `SmsPrefixUsageSchema` with
    `SMS_USAGE_MAX_DAYS`, `SMS_USAGE_DEFAULT_DAYS` and `SMS_USAGE_MAX_PREFIXES`, for the new
    operation `getSmsUsage` (`GET /v1/admin/sms/usage`): codes texted and used, by destination
    prefix. No new error code: a limit answers `rate_limited`.
  - `@tula-tech/config`: `settings.sms.dailyMessageLimit` in `tula.config.ts`. An environment that
    leaves it at the default keeps the fingerprint it had.
  - `@tula-tech/admin`: the generated types know `getSmsUsage` and the new setting.
  - `@tula-tech/cli`: `tula diff` flags a higher `sms.dailyMessageLimit` as a weakening, and
    `tula apply --yes` refuses it without `--allow-weaker`. A file that leaves the limit out
    asks for the default.
  - `@tula-tech/mcp`: `get_settings` returns `sms.dailyMessageLimit`.
- 0435d00: Text message wording and a preview of any message (`sms.templates` in the settings, and
  `POST /v1/admin/message-preview`).
  
  - `@tula-tech/contract` gains the kinds of text message, their placeholders and rules
    (`SMS_TEMPLATE_KINDS`, `SMS_TEMPLATE_PLACEHOLDERS`, `SMS_TEMPLATE_RULES`,
    `MAX_SMS_TEMPLATE_LENGTH`), the checks (`smsTemplateProblems`, `isSmsTemplateKind`,
    `readStoredSmsTemplates`), an estimate of what a text costs (`smsSegments`) and the
    schemas (`SmsTemplateSchema`, `SmsTemplatesSchema`). The `sms` settings have a new
    field, `templates`, empty by default: an environment that has saved nothing sends the
    message it always did.
  - A template is one sentence with `{{code}}` exactly once and, at most once, `{{appName}}`.
    The server still adds the last line (`@host #code`) itself. A template is refused when
    saved if it lacks the code, is over 140 characters, holds a line break, a hidden
    character, four digits in a row, a word that starts with `@` or `#`, something that
    reads as a link, or a letter, a digit or a combining mark directly beside a placeholder, or does not start with a letter.
  - `@tula-tech/config` accepts `settings.sms.templates`, validated when the file is loaded. A
    file with no wording hashes as before.
  - `tula diff` shows `sms.templates.<kind>.text` as one line, and `tula apply` removes the
    wording of a kind the file leaves out, as for every setting.
  - `@tula-tech/admin` has the `previewMessage` operation and the new settings types.
  - `@tula-tech/mcp`'s `get_settings` still returns `enabled`, `allowedCountries` and
    `dailyMessageLimit` of `sms`, and not the wording.
- 6bdf186: Webhook endpoints in the config file. An environment may list
  `webhooks: [{ url, eventTypes, enabled? }]`; `tula diff` shows what would change and
  `tula apply` makes it so.
  
  - An endpoint is its address, compared exactly. A changed address is a new endpoint (with a
    new signing secret), and the old one is an endpoint the file no longer lists.
  - No `webhooks` key: the endpoints are not read or touched. With a list, an endpoint it
    leaves out is shown as unmanaged and removed only with `--prune`.
  - Event types are a set; `enabled` is managed only when written.
  - There is no field for a secret, and a `secret` key is refused. The signing secret of an
    endpoint `apply` creates is never printed unless asked: the run needs `--secrets-file
    <path>` (a new file, mode 0600), `--show-secrets` or `--discard-secrets`, and is refused
    before any write without one of them.
  - Under `--yes`, a plan that removes an endpoint (and with it its pending deliveries and its
    delivery log) needs `--allow-webhook-removal`.
  - Webhook endpoints are written after the settings and the providers. A plan that names an
    address the server has more than once, or would leave more than ten endpoints, is refused
    whole, and `tula diff` exits 1 for it.
  
  `tula diff --json` gains `webhooks` and `blockers`, and `applyRequires` gains
  `allowWebhookRemoval` and `webhookSecrets`. A file without a `webhooks` list behaves, and
  hashes, as before.

### Patch Changes

- b38efc0: Licensed under Apache-2.0. Every package has the `license` field and ships the repository's
  `LICENSE` file.
- 0a5e496: `audit.retentionDays` takes effect: the server's retention job now deletes an environment's
  audit entries older than the period, permanently. The schema and its default (`null`: keep
  entries for ever) are unchanged.
  
  **Check the setting in every environment before you upgrade the server.** Until now the
  setting was stored and did nothing. An environment that already holds a number starts
  deleting its older audit entries, for good, with the first retention run of the new version
  (migration `0017`; runs happen at start-up and every ten minutes, and a large backlog takes
  several). `null`, the default, keeps everything, as before. Saving a period, or a shorter
  one, deletes the older entries for good, starting with the next retention run: export first
  (`GET /v1/admin/audit-logs`).
  
  `settingsWeakenings` now lists `audit.retentionDays` when a period is set where there was
  none or is made shorter (not when it is lengthened or removed). So the server's audit entry
  for such a change carries `weakened: true`, `tula diff` warns about it and
  `tula apply --yes` refuses it without `--allow-weaker`.
- 8a4734a: The first release to npm, as alphas under the `alpha` dist-tag. Each of the nine packages
  says where it comes from (`repository`, `homepage`, `bugs`, `keywords`), and its README says
  how to install it and that the API may change between alphas. `@tula-tech/contract` has a README.
  
  `@tula-tech/expo` and `@tula-tech/expo-screens` are held back until they have been run on a device.
  `create-tula --framework expo` therefore refuses, before anything is written, to scaffold a
  project that could not be installed, unless `--tula-packages` points it at tarballs from a
  checkout of the repository.
- 5b2bcf0: A draft tool, `draft_settings_change`: an assistant names the settings and OAuth providers
  that should change and gets the change back as an edit to the environment's entry in
  `tula.config.ts` ([ADR 0056](../docs/adr/0056-mcp-settings-config-diff.md)). It reads
  through the unchanged read-only facade, writes no file and calls no route that writes; a
  person applies the edit with `tula diff` and `tula apply`. A provider's secret is only
  ever `{ $env: 'NAME' }` (the tool takes a variable's name and no secret), what the change
  weakens is listed under the names `tula diff` prints, and a change no config file could
  hold is refused with the paths of its problems. `tula mcp` now serves 13 tools.
  `@tula-tech/mcp` depends on `@tula-tech/config` and `@tula-tech/contract`, and exports `DRAFT_TOOL_NAMES`.
- 633d73b: Fixes from the whole-phase review of the client SDKs and the CLI.
  
  - `@tula-tech/nextjs`: `safeRedirectPath` checks the path it returns, not only the value it was
    given. `/.//host`, `/..//host`, `/a/..//host` and `/%2e//host` were normalised by the URL
    parser to `//host` and returned, which a router reads as another origin (an open redirect
    through `redirect_url`). A path that starts with an encoded slash or backslash (`/%2f`,
    `/%5c`) is refused too.
  - `@tula-tech/react`: `safeUrl` and `go()` refuse a destination with no scheme that names a host
    (`//host`, `/\host`, a path that normalises to one). A relative destination means this
    origin; another site is written with its scheme.
  - `@tula-tech/react`: a failed sign-out is no longer shown as a sign-out. `<UserButton>` and
    `<UserProfile>` swallowed the error `@tula-tech/core` throws when the server could not be told
    and went to `afterSignOutUrl`; behind `@tula-tech/nextjs` the cookies were still there and the
    next request was signed in again. They now navigate only after a sign-out that went
    through; otherwise the provider shows a dialog (an alert) saying the session may still be
    active on this device, with "Try again". New strings: `signOutFailed.title`, `.message`,
    `.retry`, `.close`. `useTulaContext()` gains `signOut(redirectUrl?)`.
  - `@tula-tech/nextjs`: the server-side session refresh waits at most 8 seconds (it used the
    general 15-second timeout, longer than the 10-second floor of the refresh reuse grace
    window) and, like the browser's client, repeats once, at once, a refresh that got no answer;
    an HTTP answer is never repeated. `timeoutSeconds` smaller than 8 still applies.
  - `@tula-tech/nextjs`: `auth()` and `currentUser()` read the `__Host-` cookie names when the
    request carries one of them and neither `TULA_APP_URL` nor `X-Forwarded-Proto` says the
    scheme. Before, an app served over https without either was signed in for the middleware
    and signed out in every Server Component. Setting `TULA_APP_URL` remains the recommended way.
  - `@tula-tech/core`: `discard()` ends an attempt, and every flow has it (sign-up and password reset
    gain it). The attempt's secret is forgotten, later actions throw `flow.invalid_step`, and
    the answer to an action still in flight is dropped: it can no longer sign the client in
    through an attempt the user left. **Changed:** a `SignInFlow` could be waited on again
    after `discard()`; it now refuses with `flow.invalid_step`. To stop waiting and go on with
    the same attempt, abort the wait's `signal` instead.
  - `@tula-tech/core`: on a client that holds its own refresh token (every kind but `web`), a
    `signOut()` that could not reach the server can be repeated. The token had already been
    dropped, so a second call sent nothing and resolved while the session lived on. It is now
    kept in memory only (never storage) until a sign-out is delivered, the API says the session
    is over, or a new session is adopted. The client is signed out throughout.
  - `@tula-tech/react`: when a provider dialog closes and the control that opened it is gone (the
    "Sign out" item after a failed sign-out, a sign-in form after an enrolment), focus moves to
    the page's first focusable control instead of being left on the document. The
    failed-sign-out dialog also closes when the provider is given another `client`.
  - `@tula-tech/cli`: `tula dev` refuses anything at `.env.local` that is not a regular file (a
    named pipe there made it wait for ever).
  - `@tula-tech/cli`: `tula dev` writes `.env.local` through a temporary file created exclusively
    under a random name (it was the guessable `.env.local.<pid>.tmp`, written through a
    symbolic link if one was planted there), and refuses a symbolic link at `.env.local`
    instead of writing or changing a mode through it.
  - `@tula-tech/cli`: `tula doctor` also removes bidi overrides, zero-width characters, private-use
    and unassigned code points from text the server sent before printing it.
- b6e9ede: The MCP scaffold tools (`scaffold_provider`, `scaffold_protected_route`,
  `scaffold_sign_in_page`) answer `scaffold.not_released`, with no file, for `expo`: its
  scaffold needs `@tula-tech/expo`, which is not on npm yet, and the tools no longer tell an
  assistant to install it. The other four frameworks are unchanged.
  
  The READMEs and the docs name the `alpha` dist-tag in every install and scaffold command
  (`bunx create-tula@alpha`), and say that `bunx tula` is for a project that has
  `@tula-tech/cli` installed: elsewhere the name `tula` is an unrelated npm package, so a
  command run outside a project names the package
  (`bunx --package @tula-tech/cli@alpha tula mcp`).
- Updated dependencies [a036657]
- Updated dependencies [a34eb0e]
- Updated dependencies [a34eb0e]
- Updated dependencies [a34eb0e]
- Updated dependencies [b38efc0]
- Updated dependencies [1c76ead]
- Updated dependencies [55115bc]
- Updated dependencies [0a5e496]
- Updated dependencies [2d26c53]
- Updated dependencies [9166270]
- Updated dependencies [462aee1]
- Updated dependencies [d013691]
- Updated dependencies [f3216d0]
- Updated dependencies [75b1b36]
- Updated dependencies [7f204ac]
- Updated dependencies [ee1e737]
- Updated dependencies [9d2a864]
- Updated dependencies [9d2a864]
- Updated dependencies [35eab55]
- Updated dependencies [4e15bd1]
- Updated dependencies [bce497c]
- Updated dependencies [ac05f56]
- Updated dependencies [8a4734a]
- Updated dependencies [f686a47]
- Updated dependencies [48d9bea]
- Updated dependencies [2dce8af]
- Updated dependencies [2483914]
- Updated dependencies [c760b08]
- Updated dependencies [0de4f8d]
- Updated dependencies [5b2bcf0]
- Updated dependencies [8eb6b9b]
- Updated dependencies [ea7f074]
- Updated dependencies [784639a]
- Updated dependencies [095a866]
- Updated dependencies [1f189d8]
- Updated dependencies [1b61d3e]
- Updated dependencies [f968a57]
- Updated dependencies [c04622e]
- Updated dependencies [d72fb3d]
- Updated dependencies [07eff2f]
- Updated dependencies [82d87eb]
- Updated dependencies [fc7d990]
- Updated dependencies [596b4cd]
- Updated dependencies [894b927]
- Updated dependencies [751eae5]
- Updated dependencies [633d73b]
- Updated dependencies [59c2709]
- Updated dependencies [59c2709]
- Updated dependencies [99593eb]
- Updated dependencies [c97d084]
- Updated dependencies [b6e9ede]
- Updated dependencies [79bc411]
- Updated dependencies [190bb99]
- Updated dependencies [259f896]
- Updated dependencies [259f896]
- Updated dependencies [259f896]
- Updated dependencies [259f896]
- Updated dependencies [61af5e2]
- Updated dependencies [a0377de]
- Updated dependencies [73cadb2]
- Updated dependencies [9c90e25]
- Updated dependencies [0435d00]
- Updated dependencies [d615c72]
- Updated dependencies [e12e6d6]
- Updated dependencies [1df35b8]
- Updated dependencies [7d7600d]
- Updated dependencies [9178d46]
- Updated dependencies [5e51183]
- Updated dependencies [6bdf186]
  - @tula-tech/contract@0.1.0-alpha.0
  - @tula-tech/admin@0.1.0-alpha.0
  - @tula-tech/mcp@0.1.0-alpha.0
  - @tula-tech/config@0.1.0-alpha.0
