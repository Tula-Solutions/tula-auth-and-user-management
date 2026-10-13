# @tula-tech/mcp

## 0.1.0-alpha.2

### Patch Changes

- @tula-tech/admin@0.1.0-alpha.2
  - @tula-tech/config@0.1.0-alpha.2
  - @tula-tech/contract@0.1.0-alpha.2

## 0.1.0-alpha.1

### Patch Changes

- @tula-tech/admin@0.1.0-alpha.1
  - @tula-tech/config@0.1.0-alpha.1
  - @tula-tech/contract@0.1.0-alpha.1

## 0.1.0-alpha.0

### Minor Changes

- a34eb0e: The first propose tool, `propose_ban_user`: with an agent key the server can ask for a
  user to be banned. It records a proposal and changes nothing; a person approves it
  elsewhere, with a credential the server is not given. Propose tools reach the API through
  a facade of their own (`ProposingAdmin`), beside the unchanged read-only one. The server
  takes an `agent` client; with one, its reads go through it and it needs no secret key.
  Agent keys are redacted from every result like secret keys.
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
- 5b2bcf0: A draft tool, `draft_settings_change`: an assistant names the settings and OAuth providers
  that should change and gets the change back as an edit to the environment's entry in
  `tula.config.ts` ([ADR 0056](../docs/adr/0056-mcp-settings-config-diff.md)). It reads
  through the unchanged read-only facade, writes no file and calls no route that writes; a
  person applies the edit with `tula diff` and `tula apply`. A provider's secret is only
  ever `{ $env: 'NAME' }` (the tool takes a variable's name and no secret), what the change
  weakens is listed under the names `tula diff` prints, and a change no config file could
  hold is refused with the paths of its problems. `tula mcp` now serves 13 tools.
  `@tula-tech/mcp` depends on `@tula-tech/config` and `@tula-tech/contract`, and exports `DRAFT_TOOL_NAMES`.
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
- f968a57: The scaffold tools return three more frameworks, `expo`, `swiftui` and `compose`, from the
  same templates `create-tula` writes. A SwiftUI or a Compose answer names its SDK by a path
  into a checkout of the Tula repository and says so in its notes, with the note that nobody
  has run such a project on a phone; no registry, Maven coordinate or Swift package address
  is named. `detect_framework` answers `expo` for a `package.json` that depends on `expo`
  and `react-native`, and never `swiftui` or `compose`: it reads one `package.json`, and an
  Xcode project and a Gradle build have none.
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

### Patch Changes

- b38efc0: Licensed under Apache-2.0. Every package has the `license` field and ships the repository's
  `LICENSE` file.
- 35eab55: `draft_settings_change` says, in one more fixed entry of `notes`, that it does not judge
  whether accounts can sign in only with a provider a draft switches off (ADR 0059): the tool
  never reads that count, so `weakens: false` for such a draft is not "nobody is locked out".
  `tula diff` counts them. No request was added.
- 8a4734a: The first release to npm, as alphas under the `alpha` dist-tag. Each of the nine packages
  says where it comes from (`repository`, `homepage`, `bugs`, `keywords`), and its README says
  how to install it and that the API may change between alphas. `@tula-tech/contract` has a README.
  
  `@tula-tech/expo` and `@tula-tech/expo-screens` are held back until they have been run on a device.
  `create-tula --framework expo` therefore refuses, before anything is written, to scaffold a
  project that could not be installed, unless `--tula-packages` points it at tarballs from a
  checkout of the repository.
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
- Updated dependencies [a036657]
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
- Updated dependencies [8eb6b9b]
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
- Updated dependencies [59c2709]
- Updated dependencies [99593eb]
- Updated dependencies [c97d084]
- Updated dependencies [79bc411]
- Updated dependencies [190bb99]
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
  - @tula-tech/config@0.1.0-alpha.0
