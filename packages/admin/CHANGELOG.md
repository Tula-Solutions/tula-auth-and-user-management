# @tula-tech/admin

## 0.1.0-alpha.1

### Patch Changes

- @tula-tech/contract@0.1.0-alpha.1

## 0.1.0-alpha.0

### Minor Changes

- a036657: How a user signs in, for a server or the dashboard.
  
  - `@tula-tech/contract`: `UserAuthenticationSchema` / `UserAuthentication`, the answer of
    `GET /v1/admin/users/{userId}/authentication`: whether the account has a password and a
    verified address, its linked provider accounts, its confirmed second factors with the number
    of unused backup codes, its passkeys, and `canSignInWithoutPasskeys` (whether a reset of
    two-step verification would leave the user a way in). Never a secret or a credential id.
  - `@tula-tech/admin`: the admin client gains `getUserAuthentication`.
- a34eb0e: `createAgentClient` makes a client that holds an agent key (`tula_ak_…`): it reads what a
  secret key reads and records proposals, and can change nothing. `createAdminClient`
  refuses an agent key (`client.agent_key`) and `createAgentClient` refuses any other key
  (`client.invalid_agent_key`). The generated operations gain the proposal routes
  (`createProposal`, `listProposals`, `getProposal`, `approveProposal`).
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
- d013691: The server side of the dashboard (ADR 0032).
  
  - `@tula-tech/contract`: the dashboard's header names (`DASHBOARD_HEADER`, `DASHBOARD_HEADER_VALUE`,
    `ENVIRONMENT_HEADER`) and cookie name (`DASHBOARD_SESSION_COOKIE`) in `@tula-tech/contract/headers`;
    the `instance_admin` audit actor; `INSTANCE_ACTIVITY_TYPES` and `INSTANCE_AUDIT_TARGET_TYPES`
    for the instance audit log.
  - `@tula-tech/admin`: the admin client gains `listUserSessions` and `revokeUserSession`, and the
    audit log's `actorType`, `from` and `to`; the instance client gains workspaces, projects,
    environments and the instance audit log. Both still take the secret key and the instance
    admin token: the dashboard's cookie session is a browser's and is not part of this package.
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
- 75b1b36: Device binding on refresh ([docs/device-binding.md](../docs/device-binding.md), ADR 0043): a
  session of a client that is not a browser can be bound, when its sign-in starts, to a key
  the client holds. Every refresh of such a session then needs a DPoP proof (RFC 9449) signed
  by that key. A refresh without one is refused and changes nothing: the session is not ended
  and no token is rotated. A session that is not bound behaves as before.
  
  - `@tula-tech/contract`: a new Zod-free entry point, `@tula-tech/contract/device-binding`
    (`DPOP_HEADER`, `DPOP_NONCE_HEADER`, `DPOP_PROOF_TYPE`, `DPOP_ALGORITHMS`,
    `MAX_DPOP_PROOF_LENGTH`, `DeviceKey`, `DevicePublicJwk`, `createDpopProof`,
    `jwkThumbprint`, `isDevicePublicJwk`, `isKeyThumbprint`, `generateSoftwareDeviceKey`);
    the error codes `device.proof_invalid` (401), `device.nonce_required` (400) and
    `device.binding_not_supported` (400); the optional `cnf: { jkt }` on
    `AccessTokenClaimsSchema`; the event type `session.refresh_proof_refused`; and the
    optional `deviceBound` on `session.created`.
  - `@tula-tech/core`: `createTulaClient({ deviceKey })` binds the client's sessions. The client
    sends a proof when it starts a sign-up, a sign-in or a reset and at every refresh, keeps
    the server's nonce and repeats a request once when asked for a fresh one, inside the same
    deadline. A refresh refused for its proof does not sign the client out. `DeviceKey`,
    `DevicePublicJwk` and `generateSoftwareDeviceKey` are exported; a key whose `sign` throws
    is the client-side code `device.key_failed`. A `web` client cannot be given a key.
  - `@tula-tech/admin`: the generated types carry the new event type, `deviceBound` and `cnf`.
- 9d2a864: Two operations (ADR 0059): `setUserEmail` gives an account with no email address one,
  stored unverified and never replacing an address, and `getOAuthProviderDependents` answers
  how many accounts could not sign in without a provider (`{ provider, accounts, more }`).
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
- 48d9bea: Hooks: an environment can register an endpoint the server asks before a sign-up creates an
  account (`/v1/admin/hooks`, [docs/hooks.md](../docs/hooks.md)). The contract gains the hook's
  schemas, its question (`HOOK_QUESTION_SCHEMAS`, `HOOK_QUESTION_FIXTURES`) and answer
  (`HookAnswerSchema`), `hookWeakenings`, the event types `hook.created`, `hook.updated` and
  `hook.deleted`, the optional `hookBypassed` on `user.created`, and the error codes
  `hook.denied`, `hook.unavailable` and `hook.url_not_allowed`. `@tula-tech/admin` gains
  `verifyHook`, `TulaHookQuestion` and `TulaHookAnswer`, and the typed operations
  `createHook`, `listHooks`, `getHook`, `updateHook` and `deleteHook`. `@tula-tech/core` carries the
  three new codes and their messages: 50 bytes gzipped, and its bundle budget moved from 15,500
  to 15,550 bytes with them.
- 2dce8af: A hook's read answer says what its recent calls came to
  ([ADR 0035](../docs/adr/0035-hooks.md#2026-10-12-recent-outcomes-tula-67),
  [docs/hooks.md](../docs/hooks.md)). The server counts every call of a hook, by the hour,
  as `allowed`, `denied`, `failed` or `timed_out`, and `GET /v1/admin/hooks` (and every other
  answer that carries a hook) has `recentOutcomes`: the four counts of the current hour and
  the 23 before it, where the window starts, when the hook was last asked and what that call
  came to. A count is written after the sign-in was answered and is not waited for, so it
  may land a moment later, and a server killed hard loses the ones on their way.
  `lastCallAt` is the time of the latest sign-in or sign-up that asked the hook, to the
  millisecond, and is answered by the admin API only. Counts
  only: no call is kept by itself, and nothing of a question or of an answer but which of
  the four it was. `lastFailedAt` and `lastFailureReason` are unchanged.
  
  **`@tula-tech/contract`**: `HOOK_OUTCOMES`, `HookOutcome`, `HOOK_OUTCOME_WINDOW_HOURS`,
  `hookFailureOutcome(reason)`, `hookLastCallFailed(lastOutcome)` (whether the most recent
  call failed or timed out; it does not say a hook is failing now, the call may be up to a
  day old), `HookRecentOutcomesSchema`, and the
  required `recentOutcomes` of `HookSchema`.
  
  **`@tula-tech/admin`**: the generated type of a hook has `recentOutcomes`. A server from before
  this change does not send it.
  
  The dashboard's Hooks screen shows the counts and what the most recent call came to, with
  when it was ("Last call failed", never "failing now"). `@tula-tech/cli` and `@tula-tech/mcp` are unchanged: neither reads the field.
- c760b08: Hooks before a session and before a token ([docs/hooks.md](../docs/hooks.md)). An
  environment can register two more hooks: `before_session`, asked once every factor of a
  sign-in is proven and able to refuse it, and `before_token`, which answers with claims that
  are issued under `ext` of the session's access tokens. The contract gains the two points
  (`HOOK_POINTS`), their questions (`HookBeforeSessionDataSchema`,
  `HookBeforeTokenDataSchema`, in `HOOK_QUESTION_SCHEMAS` and `HOOK_QUESTION_FIXTURES`), the
  claims answer (`HookClaimsAnswerSchema`, `readHookClaimsAnswer`), the failure reasons
  `claims_invalid` and `claims_too_large`, `checkCustomClaims` in `@tula-tech/contract/custom-claims`,
  and the optional `hookBypassed` and `claimsHookBypassed` on `session.created` and
  `claimsHookBypassed` on `session.stepped_up`. `@tula-tech/admin`'s `verifyHook` accepts the two new
  questions, `TulaHookQuestion` is a union to narrow on `type`, and `TulaHookClaimsAnswer` is
  the answer of a claims hook. No error code is added: `hook.denied` and `hook.unavailable`
  now answer a refused sign-in too, and their messages no longer say "sign-up" ("This was not
  allowed.", "This is unavailable right now. Try again later."), which is the whole change to
  `@tula-tech/core`.
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
- 751eae5: `password.history` takes effect: where it is 1 or more, the server refuses, as a user's new
  password, their current password and the ones before it, as many as the number says, in a
  password change and in a reset.
  
  **Check the setting in every environment before you upgrade the server.** Until now the
  number was stored and did nothing, and the `strict` preset has it at 5. The history starts
  empty (migration `0026`): only passwords changed after the upgrade are remembered. Lowering
  the number deletes the stored hashes it no longer covers; raising it brings nothing back.
  
  - `@tula-tech/contract`: the error code `password.reused` (422, `params.history`), and
    `MAX_PASSWORD_HISTORY` (24), the ceiling `history` already had.
  - `@tula-tech/core`: the message of `password.reused`. `user.changePassword` and a reset's
    `submit` can now throw it.
  - `@tula-tech/react` (and `@tula-tech/nextjs`, which has the same components): the checklist under a
    new password on `<UserProfile>` and in the reset of `<SignIn>` lists the rule where the
    policy remembers passwords, as "checked when you save" and, once the server refuses the
    password, as not met; it is never drawn as met. New strings in the localization:
    `password.history`, `password.historyCurrent`, `password.checkedOnSave`. A custom
    localization that is a complete `Localization` object has to add them.
  - `@tula-tech/admin`: the generated types name the new error code. A password an administrator
    sets (`setUserPassword`) is remembered and is not compared with the history.
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
- 259f896: Two operations, `runSignInTest` (an agent key, `POST /v1/agent/sign-in-tests`) and
  `runSignInTestAsAdmin` (a secret key, `POST /v1/admin/sign-in-tests`): the server signs a
  throwaway user up and in through the environment's real flow, deletes it and answers a
  report of each step ([ADR 0058](../docs/adr/0058-test-signin.md)). Refused with
  `auth.forbidden` where the environment's `agents.testSignIn` does not allow it.
- a0377de: A code texted to the account's proven phone number as the second step of a sign-in
  (ADR 0025, "a texted code as the second factor"). Off by default. **Upgrade `@tula-tech/core`
  and `@tula-tech/react` before switching it on**: an older client shows "not supported" at a
  second step whose only option is a texted code.
  
  - `@tula-tech/contract`: the second-factor method `sms_code` (in `SecondFactorMethod`, in a
    step's `options` and its new `prepared` part, and among the step-up methods), the setting
    `mfa.smsCode.enabled` (default off) and `mfa.smsCode` in the client configuration,
    `Factors.sms` (`enabled`, `enabledAt`, `inUse`, `available`), the event types
    `user.sms_factor_enabled` and `user.sms_factor_removed`, the email template kinds
    `sms_factor_enabled` and `sms_factor_removed`, the text message template kind
    `second_factor` (one wording for the three texted second-step codes), and the error codes
    `mfa.needs_other_sign_in` (403), `mfa.sms_not_allowed` (409) and
    `mfa.phone_number_required` (409). `settingsWeakenings` lists `mfa.smsCode` when it is
    switched on where the policy is `required` after the change. A texted code records `sms`
    in `amr` and never `mfa`.
  - `@tula-tech/core`: `tula.mfa.startSms()`, `tula.mfa.confirmSms({ code })` and
    `tula.mfa.disableSms()`; `flow.prepareSecondFactor({ method: 'sms_code' })` on the
    sign-in and password-reset flows, and `submitSecondFactor({ method: 'sms_code', code })`;
    `session.prepareStepUp({ method: 'sms_code' })` and
    `session.stepUp({ method: 'sms_code', code })`. Three more messages in the error table.
  - `@tula-tech/react`: the second-step screen and the step-up dialog gain "Text me a code" (the
    message is asked for with a button, never sent on arrival), and `<UserProfile>` offers,
    confirms and turns off a texted code as the second step. New strings under `mfa`
    (`smsSubtitle`, `smsSend`, `smsOffer`, `smsTurnOn`, `smsStatusOn`, `smsNotInUse`,
    `smsWeaker`, `smsTurnOff`, `smsTurnedOn`, `smsTurnedOff`), `stepUp` (`smsSubtitle`) and
    `passkey` (`replacesTextedCode`: shown above "Add a passkey" to a user whose second step
    is a texted code, which the passkey replaces and which has no backup codes; `addChecking`
    and `addUnchecked`: read with that button, which is unavailable until the account's
    second step has been read, and stays so when the read fails). A texted
    code set aside by a stronger factor is said to come back when that factor is removed.
    Where the app has switched texted codes, text messages or the number's country off, the
    texted-code form shows the message of that refusal (`auth.method_disabled`,
    `sms.disabled`, `sms.country_not_allowed`) and removes its buttons.
  - `@tula-tech/admin`: the generated types know the routes, the setting, the method and the
    codes; a user's `authentication.factors` may hold `{ type: 'sms' }`.
  - `@tula-tech/mcp`: `get_settings` returns `mfa.smsCode`.
  - `@tula-tech/config`: a config accepts `mfa.smsCode`. An environment that leaves it off keeps
    the fingerprint it had: the key is hashed only when it is on.
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
- 9c90e25: Signing in with a code texted to a phone number an account has proven (ADR 0037). Off by
  default.
  
  - `@tula-tech/contract`: the first-factor strategy `sms_code` (in `FirstFactorStrategy`, in the
    prepare and attempt requests, and as a step's `prepared.strategy`), the setting
    `signIn.methods.smsCode` (default off; never the only method, see
    `SIGN_IN_METHODS_WITHOUT_SIGN_UP`), the authentication method `sms` in `amr`, and the
    error code `mfa.enrolment_needs_other_sign_in` (403). `settingsWeakenings` lists
    `signIn.methods.smsCode` when a texted code can sign someone in after a change and could
    not before, and `sms.allowedCountries` when a country is added while one does. The client
    configuration lists `smsCode` among `signIn.methods` where it is offered.
  - `@tula-tech/core`: `flow.prepareFirstFactor({ strategy: 'sms_code' })` and
    `flow.attemptFirstFactor({ strategy: 'sms_code', code })`, for a sign-in started with a
    phone number as its identifier. One more message in the error table.
  - `@tula-tech/react`: `<SignIn>` takes a phone number in its first field where the environment
    lists the method, and gains the "Text me a code" and "Check your phone" screens. New
    strings under `signIn` in the localization table (`identifierLabel`, `identifierHint`,
    `smsCode`, `smsCodePrompt`, `smsTitle`, `smsCodeSubtitle`, `smsResend`, `smsResendIn`,
    `smsResent`, `smsCodeWrong`). A version from before this one leaves the strategy out.
  - `@tula-tech/admin`: the generated types know the setting, the strategy and the error code.
  - `@tula-tech/mcp`: `get_settings` returns `signIn.methods.smsCode`.
  - `@tula-tech/config`: a config accepts `signIn.methods.smsCode`. An environment that leaves it
    off keeps the fingerprint it had: the key is hashed only when it is on.
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
- 1df35b8: Webhook retries, the delivery log, test events and sending a delivery again.
  
  - `@tula-tech/contract`:
    - A webhook endpoint gains `disabledReason` (`failing`, `gone`, or `null`), `failingSince`
      and `lastFailedAt`.
    - A new event type, `webhook_endpoint.disabled`, with `data.reason`
      (`WEBHOOK_DISABLED_REASONS`): the server switched an endpoint off because every request to
      it failed for five days with no silence longer than the retry schedule, or because it
      answered `410 Gone`.
    - Every event envelope gains an optional `test`, which is `true` on a test event and absent
      on a real one. `EVENT_SCHEMA_VERSION` stays 1.
    - `WebhookDeliverySchema`, `WebhookDeliveryDetailSchema`, `WebhookDeliveryAttemptSchema`,
      `WebhookDeliveryListSchema`, `SendTestWebhookRequestSchema`, `WebhookSendResultSchema`,
      `WEBHOOK_DELIVERY_STATES` and `WEBHOOK_REDELIVER_REFUSALS`.
    - A new error code, `webhook.cannot_redeliver` (409), whose `params.reason` is
      `delivery_pending`, `endpoint_disabled`, `event_gone` or `attempt_limit`.
  - `@tula-tech/admin`: the admin client gains `listWebhookDeliveries`, `getWebhookDelivery`,
    `sendTestWebhook` and `redeliverWebhook`. `verifyWebhook` returns a test event with
    `event.test === true` and refuses a `test` that is anything else; its documentation now says
    that a delivery is retried, that order is not guaranteed, and to check `test` before acting.
  - `@tula-tech/core`: the generated types and the error-message table follow the contract (one new
    code).
- 7d7600d: Webhook secret rotation: an endpoint's signing secret is replaced without dropping a delivery.
  
  - `@tula-tech/contract`:
    - A webhook endpoint gains `rotationOverlapEndsAt`: when the previous secret stops signing,
      or `null` when one secret signs. Until then every delivery carries two signatures in
      `webhook-signature`, the new secret's first.
    - `RotatedWebhookSecretSchema`: the answer of a rotation, the endpoint with its new secret
      (shown once) and `rotationOverlapEndsAt`.
    - Two new event types: `webhook_endpoint.secret_rotated` (`data.rotationOverlapEndsAt`) and
      `webhook_endpoint.previous_secret_revoked` (no data). Neither carries anything of a
      secret. `EVENT_SCHEMA_VERSION` stays 1.
    - A new error code, `webhook.rotation_refused` (409), whose `params.reason` is one of
      `WEBHOOK_ROTATION_REFUSALS`: `rotation_in_progress`, `no_rotation_in_progress` or
      `secret_unreadable`.
  - `@tula-tech/admin`:
    - The admin client gains `rotateWebhookSecret` and `revokePreviousWebhookSecret`.
    - `verifyWebhook` takes one secret **or a list of at most two** (`WEBHOOK_MAX_SECRETS`,
      `WebhookSecrets`): the delivery is accepted when any signature is right for any secret
      given. Every secret listed must be a signing secret; an empty list, a third secret or a
      malformed entry is `webhook.invalid_secret`. A single secret behaves as before.
  - `@tula-tech/core`: the generated types and the error-message table follow the contract (one new
    code).
- 5e51183: Webhooks, first step: an environment's events are delivered, signed, to an endpoint an
  operator registers (`/v1/admin/webhook-endpoints`; [ADR 0034](../docs/adr/0034-webhooks.md),
  [docs/webhooks.md](../docs/webhooks.md)). One attempt per endpoint and event for now: a
  failed delivery is recorded and not repeated.
  
  **`@tula-tech/contract`**
  
  - A new Zod-free entry point, `@tula-tech/contract/webhook-signature`: the Standard Webhooks header
    names (`WEBHOOK_ID_HEADER`, `WEBHOOK_TIMESTAMP_HEADER`, `WEBHOOK_SIGNATURE_HEADER`), the
    secret prefix, the five-minute tolerance, and `signWebhook`, `webhookSecretBytes` and
    `formatWebhookSecret`.
  - The webhook endpoint schemas of the admin API (`WebhookEndpointSchema`,
    `CreatedWebhookEndpointSchema`, the create and update requests, `MAX_WEBHOOK_ENDPOINTS`).
  - Three event types, each with a `data` schema and a fixture: `webhook_endpoint.created`,
    `webhook_endpoint.updated` and `webhook_endpoint.deleted`. Their target is a new target
    type, `webhook_endpoint`. An event never carries an endpoint's address or its secret.
  - A new error code, `webhook.url_not_allowed` (422): the server may not call the address.
    `params.reason` is a fixed word, never the address.
  
  A receiver or an SDK that switches on `type` or on `target.type` sees values it did not list
  before; both lists only grow within `schemaVersion` 1, as documented.
  
  **`@tula-tech/admin`**
  
  - `verifyWebhook(body, headers, secret, options?)`: verifies a delivery (the signature, in
    constant time, accepting any one of several; the headers; a timestamp within five minutes
    either way) and returns the typed event, `TulaWebhookEvent`. It throws `TulaAdminError`
    with one of five new client codes (`webhook.invalid_secret`, `webhook.invalid_headers`,
    `webhook.timestamp_out_of_tolerance`, `webhook.invalid_signature`,
    `webhook.invalid_payload`), never with the secret, a signature or the body in it. Zod-free,
    web platform APIs only.
  - The five webhook endpoint operations (`createWebhookEndpoint`, `listWebhookEndpoints`,
    `getWebhookEndpoint`, `updateWebhookEndpoint`, `deleteWebhookEndpoint`), and the event
    types under `AdminSchemas['TulaEvent']`.
  
  **`@tula-tech/core`**: the generated `ErrorCode` type lists `webhook.url_not_allowed`. Nothing a
  client calls changed.
  
  **`@tula-tech/mcp`**: a webhook signing secret (`whsec_…`) is redacted wherever it turns up in a
  result, like the other secret shapes. There is no webhook tool.
  
  **Before you upgrade the server**: migration `0018` adds a unique key and an index to the
  outbox table (`events`), which locks it for writes while they build; and the first start of
  the new version marks every event recorded so far as settled, without sending any
  ([docs/self-host.md](../docs/self-host.md#upgrading)).

### Patch Changes

- b38efc0: Licensed under Apache-2.0. Every package has the `license` field and ships the repository's
  `LICENSE` file.
- 8a4734a: The first release to npm, as alphas under the `alpha` dist-tag. Each of the nine packages
  says where it comes from (`repository`, `homepage`, `bugs`, `keywords`), and its README says
  how to install it and that the API may change between alphas. `@tula-tech/contract` has a README.
  
  `@tula-tech/expo` and `@tula-tech/expo-screens` are held back until they have been run on a device.
  `create-tula --framework expo` therefore refuses, before anything is written, to scaffold a
  project that could not be installed, unless `--tula-packages` points it at tarballs from a
  checkout of the repository.
- Updated dependencies [a036657]
- Updated dependencies [a34eb0e]
- Updated dependencies [b38efc0]
- Updated dependencies [1c76ead]
- Updated dependencies [55115bc]
- Updated dependencies [0a5e496]
- Updated dependencies [9166270]
- Updated dependencies [462aee1]
- Updated dependencies [d013691]
- Updated dependencies [f3216d0]
- Updated dependencies [75b1b36]
- Updated dependencies [7f204ac]
- Updated dependencies [ee1e737]
- Updated dependencies [9d2a864]
- Updated dependencies [4e15bd1]
- Updated dependencies [bce497c]
- Updated dependencies [ac05f56]
- Updated dependencies [8a4734a]
- Updated dependencies [f686a47]
- Updated dependencies [48d9bea]
- Updated dependencies [2dce8af]
- Updated dependencies [c760b08]
- Updated dependencies [0de4f8d]
- Updated dependencies [ea7f074]
- Updated dependencies [784639a]
- Updated dependencies [095a866]
- Updated dependencies [1f189d8]
- Updated dependencies [1b61d3e]
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
- Updated dependencies [99593eb]
- Updated dependencies [c97d084]
- Updated dependencies [79bc411]
- Updated dependencies [190bb99]
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
  - @tula-tech/contract@0.1.0-alpha.0
