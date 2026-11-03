# create-tula

## 0.2.0

### Patch Changes

- 9267647: The SwiftUI template's UI tests can take screenshots of every screen (`CaptureUITests`, skipped unless asked for), the same captures the documentation's native screen gallery shows.

## 0.1.1

### Patch Changes

- The first release without the `alpha` label is `0.1.1`, published under npm's `latest`
  dist-tag. `0.1.0` is skipped: the alphas were `0.1.0-alpha.N`, and a plain `0.1.0` beside
  them would read as the same thing. Install with `@latest` (or no tag) from here on; the
  `alpha` dist-tag stays on `0.1.0-alpha.1` and is no longer moved.

## 0.1.0

### Minor Changes

- c8c873d: A new project pulls the Tula API image instead of asking you to build it. `TULA_API_IMAGE`
  in the scaffolded `.env` now names the published image of `create-tula`'s own version,
  `ghcr.io/tula-solutions/tula-api:<version>` (amd64 and arm64), which `bunx tula dev` pulls
  the first time it starts the stack: no checkout of the Tula repository and no
  `docker build` is needed for a web project. `--api-image <ref>` still names another image,
  such as `tula-api:local` built from a checkout.
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
- f968a57: Three native templates beside the two web ones: `--framework expo`, `swiftui` and
  `compose`, copies of the repository's Expo, SwiftUI and Compose examples. A native app is
  a directory of its own in the project (`app`, `ios`, `android`), next to the Compose file,
  the `.env` and `tula.config.ts`, and holds no key.
  
  The Swift package and the Kotlin libraries are published nowhere yet, so a SwiftUI or a
  Compose project names its SDK by a relative path into a checkout of the Tula repository:
  `--tula-repo <dir>` is required for those two and refused for the others, and a path with
  a character an Xcode project, a Gradle file or a pasted command line cannot take as it is
  (a space among them) is refused before anything is written. `--tula-repo` must be a
  checkout you trust: building the project runs its build scripts. The Compose project ships no Gradle wrapper and is built with the
  checkout's.
  
  Nobody has run a scaffolded native project in a simulator, on an emulator or on a phone:
  the SwiftUI and the Compose one were compiled, the Expo one was written and not installed.

### Patch Changes

- b38efc0: Licensed under Apache-2.0. Every package has the `license` field and ships the repository's
  `LICENSE` file.
- e1af71f: A scaffolded project can try the provider buttons before it has real credentials: its Compose
  file passes `OAUTH_MOCK_PROVIDER` from `.env` to the API (off unless set; the API refuses it
  outside `ENVIRONMENT=local`), and `.env.example` documents the switch.
- 141a4f8: The scaffolded Compose file and `.env.example` pass `SMS_PROVIDER` and the six `TWILIO_*`
  variables to the API, so that a scaffolded deployment can send text messages through Twilio
  by setting them. Nothing is sent by default (`SMS_PROVIDER` stays `none`).
- 849ff94: `tula dev --tunnel` starts the local stack under a public https address (this machine's
  Tailscale Funnel name), so that a phone can reach it. The address is written into the
  command's own block of `.env.local`; the settings that name it are printed, not written;
  and the run refuses to start beside the mock provider or the development SMS inbox, which
  the API serves on a loopback address only. `tula dev down`, and `tula dev` without the
  flag, close the tunnel again, and so does a run that fails or is interrupted (Ctrl-C);
  where the tunnel is opened is recorded in the block before it is opened, so a run that
  was killed outright can still be closed by `tula dev down`. The scaffolded Compose file reads the API's `PUBLIC_URL`
  from `TULA_PUBLIC_URL`, which only that command sets.
- 9209cea: The Expo scaffold's README (`create-tula --framework expo`) says in one paragraph that the
  app draws its own screens on `@tula-tech/expo`'s headless client, and that Tula's native screens
  are a separate package, `@tula-tech/expo-screens`, which the scaffold does not install and whose
  iOS module has not been compiled. The scaffolded app itself is unchanged.
- 8a4734a: The first release to npm, as alphas under the `alpha` dist-tag. Each of the nine packages
  says where it comes from (`repository`, `homepage`, `bugs`, `keywords`), and its README says
  how to install it and that the API may change between alphas. `@tula-tech/contract` has a README.
  
  `@tula-tech/expo` and `@tula-tech/expo-screens` are held back until they have been run on a device.
  `create-tula --framework expo` therefore refuses, before anything is written, to scaffold a
  project that could not be installed, unless `--tula-packages` points it at tarballs from a
  checkout of the repository.
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
- b6e9ede: The MCP scaffold tools (`scaffold_provider`, `scaffold_protected_route`,
  `scaffold_sign_in_page`) answer `scaffold.not_released`, with no file, for `expo`: its
  scaffold needs `@tula-tech/expo`, which is not on npm yet, and the tools no longer tell an
  assistant to install it. The other four frameworks are unchanged.
  
  The READMEs and the docs name the `alpha` dist-tag in every install and scaffold command
  (`bunx create-tula@alpha`), and say that `bunx tula` is for a project that has
  `@tula-tech/cli` installed: elsewhere the name `tula` is an unrelated npm package, so a
  command run outside a project names the package
  (`bunx --package @tula-tech/cli@alpha tula mcp`).
- 2d94881: The first published version is `0.1.0-alpha.1`. `0.1.0-alpha.0` is skipped on purpose, in
  case the unscoped name `create-tula` once carried it: npm never accepts a version a second
  time, also after it was unpublished, and the registry does not say whether one existed.
- 9bb642d: The scaffolded Compose file pins Mailpit v1.31.4, as the repository's own does.
- 577498d: The scaffolded apps start from newer patch releases of Vite and `@types/node`.

## 0.1.0-alpha.1

### Patch Changes

- The first published version is `0.1.0-alpha.1`. `0.1.0-alpha.0` is skipped on purpose, in
  case the unscoped name `create-tula` once carried it: npm never accepts a version a second
  time, also after it was unpublished, and the registry does not say whether one existed.

## 0.1.0-alpha.0

### Minor Changes

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
- f968a57: Three native templates beside the two web ones: `--framework expo`, `swiftui` and
  `compose`, copies of the repository's Expo, SwiftUI and Compose examples. A native app is
  a directory of its own in the project (`app`, `ios`, `android`), next to the Compose file,
  the `.env` and `tula.config.ts`, and holds no key.
  
  The Swift package and the Kotlin libraries are published nowhere yet, so a SwiftUI or a
  Compose project names its SDK by a relative path into a checkout of the Tula repository:
  `--tula-repo <dir>` is required for those two and refused for the others, and a path with
  a character an Xcode project, a Gradle file or a pasted command line cannot take as it is
  (a space among them) is refused before anything is written. `--tula-repo` must be a
  checkout you trust: building the project runs its build scripts. The Compose project ships no Gradle wrapper and is built with the
  checkout's.
  
  Nobody has run a scaffolded native project in a simulator, on an emulator or on a phone:
  the SwiftUI and the Compose one were compiled, the Expo one was written and not installed.

### Patch Changes

- b38efc0: Licensed under Apache-2.0. Every package has the `license` field and ships the repository's
  `LICENSE` file.
- e1af71f: A scaffolded project can try the provider buttons before it has real credentials: its Compose
  file passes `OAUTH_MOCK_PROVIDER` from `.env` to the API (off unless set; the API refuses it
  outside `ENVIRONMENT=local`), and `.env.example` documents the switch.
- 141a4f8: The scaffolded Compose file and `.env.example` pass `SMS_PROVIDER` and the six `TWILIO_*`
  variables to the API, so that a scaffolded deployment can send text messages through Twilio
  by setting them. Nothing is sent by default (`SMS_PROVIDER` stays `none`).
- 849ff94: `tula dev --tunnel` starts the local stack under a public https address (this machine's
  Tailscale Funnel name), so that a phone can reach it. The address is written into the
  command's own block of `.env.local`; the settings that name it are printed, not written;
  and the run refuses to start beside the mock provider or the development SMS inbox, which
  the API serves on a loopback address only. `tula dev down`, and `tula dev` without the
  flag, close the tunnel again, and so does a run that fails or is interrupted (Ctrl-C);
  where the tunnel is opened is recorded in the block before it is opened, so a run that
  was killed outright can still be closed by `tula dev down`. The scaffolded Compose file reads the API's `PUBLIC_URL`
  from `TULA_PUBLIC_URL`, which only that command sets.
- 9209cea: The Expo scaffold's README (`create-tula --framework expo`) says in one paragraph that the
  app draws its own screens on `@tula-tech/expo`'s headless client, and that Tula's native screens
  are a separate package, `@tula-tech/expo-screens`, which the scaffold does not install and whose
  iOS module has not been compiled. The scaffolded app itself is unchanged.
- 8a4734a: The first release to npm, as alphas under the `alpha` dist-tag. Each of the nine packages
  says where it comes from (`repository`, `homepage`, `bugs`, `keywords`), and its README says
  how to install it and that the API may change between alphas. `@tula-tech/contract` has a README.
  
  `@tula-tech/expo` and `@tula-tech/expo-screens` are held back until they have been run on a device.
  `create-tula --framework expo` therefore refuses, before anything is written, to scaffold a
  project that could not be installed, unless `--tula-packages` points it at tarballs from a
  checkout of the repository.
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
- b6e9ede: The MCP scaffold tools (`scaffold_provider`, `scaffold_protected_route`,
  `scaffold_sign_in_page`) answer `scaffold.not_released`, with no file, for `expo`: its
  scaffold needs `@tula-tech/expo`, which is not on npm yet, and the tools no longer tell an
  assistant to install it. The other four frameworks are unchanged.
  
  The READMEs and the docs name the `alpha` dist-tag in every install and scaffold command
  (`bunx create-tula@alpha`), and say that `bunx tula` is for a project that has
  `@tula-tech/cli` installed: elsewhere the name `tula` is an unrelated npm package, so a
  command run outside a project names the package
  (`bunx --package @tula-tech/cli@alpha tula mcp`).
- 9bb642d: The scaffolded Compose file pins Mailpit v1.31.4, as the repository's own does.
- 577498d: The scaffolded apps start from newer patch releases of Vite and `@types/node`.
