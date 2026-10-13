# @tula-tech/config

## 0.1.1

### Patch Changes

- @tula-tech/contract@0.1.1

## 0.1.0

### Minor Changes

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
- 59c2709: `settings.sms` in `tula.config.ts`: whether an environment sends text messages
  (`enabled`, default `false`) and the countries they may go to (`allowedCountries`, ISO 3166-1
  alpha-2 codes; empty means nothing is sent). See ADR 0037. An environment that leaves it at
  its default keeps the fingerprint it had.
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
- 259f896: `agents.testSignIn` in `tula.config.ts`: whether a sign-in test may run in the
  environment ([ADR 0058](../docs/adr/0058-test-signin.md)). Left out it is the server's
  default by the environment's kind and takes no part in the fingerprint; `true` is a
  weakening `tula apply --yes` refuses without `--allow-weaker`.
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
- 8a4734a: The first release to npm, as alphas under the `alpha` dist-tag. Each of the nine packages
  says where it comes from (`repository`, `homepage`, `bugs`, `keywords`), and its README says
  how to install it and that the API may change between alphas. `@tula-tech/contract` has a README.
  
  `@tula-tech/expo` and `@tula-tech/expo-screens` are held back until they have been run on a device.
  `create-tula --framework expo` therefore refuses, before anything is written, to scaffold a
  project that could not be installed, unless `--tula-packages` points it at tarballs from a
  checkout of the repository.
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
  - @tula-tech/contract@0.1.0

## 0.1.0-alpha.1

### Patch Changes

- @tula-tech/contract@0.1.0-alpha.1

## 0.1.0-alpha.0

### Minor Changes

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
- 59c2709: `settings.sms` in `tula.config.ts`: whether an environment sends text messages
  (`enabled`, default `false`) and the countries they may go to (`allowedCountries`, ISO 3166-1
  alpha-2 codes; empty means nothing is sent). See ADR 0037. An environment that leaves it at
  its default keeps the fingerprint it had.
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
- 259f896: `agents.testSignIn` in `tula.config.ts`: whether a sign-in test may run in the
  environment ([ADR 0058](../docs/adr/0058-test-signin.md)). Left out it is the server's
  default by the environment's kind and takes no part in the fingerprint; `true` is a
  weakening `tula apply --yes` refuses without `--allow-weaker`.
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
- 8a4734a: The first release to npm, as alphas under the `alpha` dist-tag. Each of the nine packages
  says where it comes from (`repository`, `homepage`, `bugs`, `keywords`), and its README says
  how to install it and that the API may change between alphas. `@tula-tech/contract` has a README.
  
  `@tula-tech/expo` and `@tula-tech/expo-screens` are held back until they have been run on a device.
  `create-tula --framework expo` therefore refuses, before anything is written, to scaffold a
  project that could not be installed, unless `--tula-packages` points it at tarballs from a
  checkout of the repository.
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
