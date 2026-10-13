# @tula-tech/react

## 0.1.0-alpha.2

### Patch Changes

- @tula-tech/contract@0.1.0-alpha.2
  - @tula-tech/core@0.1.0-alpha.2

## 0.1.0-alpha.1

### Patch Changes

- @tula-tech/contract@0.1.0-alpha.1
  - @tula-tech/core@0.1.0-alpha.1

## 0.1.0-alpha.0

### Minor Changes

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
- 191d835: `<UserProfile>` has an "Email address" section for an account that has none (one made with
  X or Facebook): the user types an address, is emailed a code and confirms it (ADR 0059). A
  user with nothing to step up with is told to sign out and sign in again. An account that
  has an address shows no such section: nothing here changes one. Ten strings are new under
  `emailAddress` in the localization.
- 4e15bd1: Signing in by email: a 6-digit code, a link that works only in the browser that asked for it,
  and sign-up without a password.
  
  - `@tula-tech/contract`: `EnvironmentSettings` gains `signIn.methods.emailCode` and
    `signIn.methods.emailLink` (both off by default; `emailLink` needs `emailCode`) and
    `signUp.password` (`required` by default, or `optional`, which needs `emailCode`).
    `ClientConfig` gains `signUp.password`. The `needs_first_factor` step gains an optional
    `prepared: { strategy, destination }`, `FlowAttempt` an optional `linkBinding`, and
    `SignUpRequest.password` becomes optional. New request shapes `FirstFactorPrepareRequest`,
    `FirstFactorAttemptRequest`, `EmailLinkRequest` and `EmailLinkResult`; new error codes
    `verification.different_browser` (409) and `request.redirect_not_allowed` (400); and
    `EMAIL_LINK_TOKEN_PARAM` / `EMAIL_LINK_ATTEMPT_PARAM` in the Zod-free `/headers` entry point.
    All additive: documents saved earlier read with the new methods off.
  - `@tula-tech/core`: sign-in flows gain `prepareFirstFactor`, `attemptFirstFactor`,
    `waitForEmailLink` (polling with cancellation, nudged across tabs, obeys `Retry-After`) and
    `discard`; `signIn.canUseEmailLink()` and `signIn.handleEmailLink()` for the page a link
    leads to; `signUp.start` takes an optional password. An emailed link's binding is kept in
    `localStorage` (it is not a token; see the README's security notes), and the link's token is
    read from the URL fragment and removed from the address before anything is sent. A link's
    page must be on the origin that asks: another origin is refused locally with the new client
    code `link.cross_origin`.
  - `@tula-tech/react`: `<SignIn>` draws the emailed code and link and lets the user switch between
    the methods on offer (new prop `emailLinkUrl`, also on the provider); `<SignUp>` marks the
    password optional where the environment says so; new `<EmailLinkCallback>` and
    `useEmailLinkCallback()` for the landing page; `useSignIn` gains the matching actions. New
    element names `alternatives` and `waiting`, and new localization keys under `signIn`,
    `signUp` and `emailLink`.
- ea7f074: Two-step verification: an authenticator app (TOTP), backup codes, step-up and a policy per
  environment.
  
  - `@tula-tech/contract`: new flow step `needs_factor_enrolment { methods }` and request shape
    `SecondFactorRequest`; `FlowAttempt` gains the optional `backupCodes` and
    `backupCodesRemaining`. New `Factors`, `TotpEnrolment`, `TotpConfirmRequest`, `BackupCodes`,
    `StepUpRequest` and `StepUpMethod`. Access-token claims gain `auth_time` (when the user last
    proved a factor for the session; refreshing does not move it) and `amr` (what they proved:
    a set, whose order is not part of the contract), with `AUTHENTICATION_METHODS` and
    `STEP_UP_MAX_AGE_SECONDS`. `EnvironmentSettings` gains `mfa.policy` (`off`, `optional` by
    default, `required`) and `notifications.mfaChanged`; `ClientConfig` gains the optional
    `mfa.policy`. New error codes `mfa.invalid_code`, `mfa.already_enabled`, `mfa.not_enabled`,
    `mfa.enrolment_expired`, `mfa.not_available`, `mfa.required_by_policy` and
    `auth.step_up_required` (its `params.methods` is a comma-separated list). New activity types
    `user.mfa_enabled`, `user.mfa_disabled`, `user.backup_codes_regenerated`,
    `user.backup_code_used` and `session.stepped_up`. All additive.
  - `@tula-tech/react`: `<SignIn>` (also after a password reset) and `<SignUp>` draw the second
    factor (authenticator code or a backup code) and, where the environment requires it, the
    enrolment inside the flow. `<UserProfile>` gains a "Two-step verification" section: turn on
    with a QR code and the setup key, backup codes with copy, download and an explicit
    confirmation, new codes, turn off. New hook `useStepUp()` runs a sensitive action and, when
    the API asks, opens the provider's step-up dialog and retries. `useSignIn`, `useSignUp` and
    `useResetPassword` gain `submitSecondFactor`, `startTotpEnrolment` and
    `confirmTotpEnrolment`. New element names (`modal`, `qrCode`, `secret`, `backupCodes`,
    `backupCode`, `checkbox`) and strings (`mfa`, `stepUp`). The QR code is drawn by the package
    itself, in a chunk loaded on demand; the build now emits that chunk beside `index.js`.
- c04622e: `@tula-tech/nextjs`: Tula for the Next.js App Router (ADR 0029).
  
  - `@tula-tech/nextjs/handlers`: `createTulaHandlers()`, a catch-all route handler that stands in
    for the API's `/v1/client/*` on the app's own origin. The browser's client talks to it and
    never to the API's host, so the refresh cookie, a `stateful` session's cookie and a new
    access-token cookie are first-party, `HttpOnly` cookies of the app. It forwards the
    browser's `Origin` unchanged, refuses requests that do not come from the app's own pages,
    never forwards the admin API and never follows a redirect. It trusts no forwarding header
    by default: the visitor's address reaches the API only with `trustedProxyHops`
    (`TULA_TRUSTED_PROXY_HOPS`) or `clientIp`. A sign-in replaces the browser's session
    whatever its kind, and request bodies and JSON answers are capped at 1 MiB.
  - `@tula-tech/nextjs/middleware`: `tulaMiddleware()` for `proxy.ts` (Next.js 16) or `middleware.ts`
    (Next.js 15). Verifies the access token offline against the environment's JWKS, refreshes it
    once through the API when it is missing or expiring, protects routes by matcher and
    redirects to sign-in with a same-origin `redirect_url` (`safeRedirectPath`). It clears the
    cookies only when the API says the session is over; a refusal caused by the app's own
    configuration (origin, key) keeps them and is reported once (`onWarning`).
  - `@tula-tech/nextjs` refuses a configuration that would send the secret key (`stateful` session
    profiles) to a plain `http:` `apiUrl` that is not this machine; `allowInsecureHttp`
    (`TULA_ALLOW_INSECURE_HTTP=true`) allows it on a private network you trust.
  - `@tula-tech/nextjs/server`: `auth()`, `currentUser()` and `getToken()` for Server Components,
    Route Handlers and Server Actions.
  - `@tula-tech/nextjs`: `<TulaProvider>` for the App Router (takes the server's `initialState`, so
    the first paint is right) and every `@tula-tech/react` component and hook, marked `'use client'`.
  - `@tula-tech/contract/issuer`: `environmentIssuer` and `jwksUrl` as a Zod-free entry point (still
    exported from the index).
  - `@tula-tech/core`: `TulaClient` has an optional `serverState`, set by a framework integration.
    `@tula-tech/react` renders it during server rendering and hydration instead of `loading`.
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
- 9c6253e: An OAuth sign-in is no longer lost when the ticket exchange gets no answer.
  
  - `@tula-tech/core`: when `signIn.handleOAuthCallback()` fails with `network.failed`,
    `network.timeout` or `rate_limited`, the round trip is kept (the binding in `sessionStorage`,
    the ticket in memory only, for 60 seconds) and calling it again retries the exchange. Any
    answer from the API, success or refusal, ends the round trip as before. New:
    `signIn.discardOAuthCallback()` to give up on a held round trip (sign-out and a new round trip
    do the same), and `isRetryableOAuthError(error)`.
  - `@tula-tech/react`: `useOAuthCallback()` returns `canRetry` and `retry()`, and `<OAuthCallback>`
    shows a "Try again" button after such a failure. New localization string `oauth.tryAgain`.
  - `@tula-tech/react`: the step-up dialog no longer says a code was emailed when its first send was
    refused (`rate_limited`): it shows the error with the wait counted down and "Send code", and
    the code field only after a send succeeded. Going to the password form and back keeps the
    code already sent instead of asking for another. The localization string
    `stepUp.emailSubtitleSent` is gone.
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
- fc7d990: Sign in with Google, GitHub and Apple, with an environment's own OAuth credentials.
  
  - `@tula-tech/contract`: new `OAuthProvider`, `OAuthStartRequest`, `OAuthStart`,
    `OAuthExchangeRequest`, `Identity`, `IdentityList`, `IdentityLinkStart`,
    `OAuthProviderSettings` and `OAuthProviderUpdate`; error codes `oauth.access_denied`,
    `oauth.provider_error`, `oauth.state_invalid`, `oauth.ticket_invalid`,
    `oauth.different_browser`, `oauth.email_missing`, `oauth.email_unverified`,
    `oauth.account_exists`, `oauth.identity_in_use`, `oauth.already_linked` and
    `identity.last_sign_in_method`; `ClientConfig.signIn.oauth`; the setting
    `notifications.identityChanged`; the fragment parameters `OAUTH_TICKET_PARAM` and
    `OAUTH_ERROR_PARAM`. **Changed:** the settings schema no longer refuses a document with
    every sign-in method off (the server does, unless an OAuth provider is enabled);
    `hasEnabledSignInMethod` and `AT_LEAST_ONE_SIGN_IN_METHOD` are exported for that check.
  - `@tula-tech/core`: `signIn.withOAuth`, `signIn.handleOAuthCallback`, `signIn.canUseOAuth` and
    `user.identities.{list, link, unlink}`. The round trip's binding is kept in
    `sessionStorage` for the tab; no token is.
  - `@tula-tech/react`: "Continue with …" buttons on `<SignIn>` and `<SignUp>`, `<OAuthCallback>` and
    `useOAuthCallback()`, "Connected accounts" in `<UserProfile>`, the `oauthCallbackUrl` option,
    new localization strings (`oauth`, and seven under `userProfile`) and element names
    (`oauthButtons`, `oauthIcon`, `divider`, `identityList`, `identityItem`).
- 4edac20: Passkeys in the prebuilt components (ADR 0027).
  
  - `<SignIn>`: "Sign in with a passkey" on the first screen (no address needed) where the
    environment has passkeys on and the browser has WebAuthn; the address field carries
    `autocomplete="username webauthn"` and, where the browser supports it, offers the user's
    passkeys in its autofill. After an address, `passkey` is one of the ways to sign in. A
    dismissed dialog is said quietly, in a neutral tone (not the success colour: nothing was
    done), and the button works again. After any try with the button that did not sign in
    (dismissed, refused, failed) the address field offers passkeys in its autofill again.
  - The second-factor screen and the step-up dialog ask for the user's passkey where the server
    offers it ("Use your passkey"), next to the other ways or alone.
  - `<UserProfile>`: a "Passkeys" section (list with name, synced or on one device, added and
    last used; add, rename, remove after a confirmation). The list is always loaded: where the
    environment has passkeys off, a user who still has passkeys sees them and can rename and
    remove them, with a line in place of "Add a passkey" (`passkey.addUnavailable`); a user who
    has none sees no section.
  - `useSignIn()`: `withPasskey()`, `canUsePasskey()` and `submitSecondFactorWithPasskey()`;
    `useResetPassword()`: `submitSecondFactorWithPasskey()`. `adopt()` now discards the attempt
    it replaces.
  - New localization group `passkey`, and element names `passkeyIcon`, `passkeyList`,
    `passkeyItem` and `confirmation`.
  - A passkey sign-in signs the client in before its flow comes back. `<SignIn>` holds its
    "already signed in" redirect for exactly as long as a passkey request of its own (the button
    or the autofill one) is in flight, so the app's `onComplete` is always what completes such a
    sign-in. Nothing depends on timing, and a user who was signed in when `<SignIn>` or
    `<SignUp>` mounted is sent to `afterSignInUrl` as before.
  - `Status` messages have a neutral tone (class `tula-is-neutral` on the `status` element, the
    muted text colour) beside the success one.
- 894b927: `password.expiryDays` takes effect: where it is set, a user who signs in with a password
  that was set that many days ago or longer has to choose a new one before the sign-in
  completes.
  
  **Check the setting in every environment, and `PASSWORD_POLICY`, before you upgrade the
  server.** Until now the number was stored and did nothing, and the `legacy` preset has it at
  90. Age is counted from when a password was last set; for the passwords that already exist
  that is the last time their row was written (migration `0029`). A user whose password is
  older than the period is asked for a new one at their next sign-in with it. Nobody is signed
  out and no email is sent. Only a sign-in with the password is affected: an emailed or texted
  code, a link, a passkey and a provider sign in whatever the password's age.
  
  **Upgrade clients before the server.** An app built on a `@tula-tech/react` or `@tula-tech/core` older
  than this release shows "This step is not supported" where the new password is asked for,
  so a user with an expired password cannot sign in through it. Or set `expiryDays` to `null`
  until every client is upgraded.
  
  - `@tula-tech/contract`: the `needs_new_password` step gains an optional `reason`
    (`NewPasswordReasonSchema`: `expired`). With a reason its `strategies` is empty; a
    password reset's step is unchanged. A new operation,
    `POST /v1/client/sign-ins/{attemptId}/new-password` (`submitSignInNewPassword`).
  - `@tula-tech/core`: a sign-in flow gains `submitNewPassword({ password })`, for the step
    `needs_new_password` with `reason: 'expired'`. A refused password (`password.*`) leaves the
    flow on the step.
  - `@tula-tech/react`: `<SignIn>` draws a "Your password has expired" screen for that step, with
    the policy's checklist. Four new strings, under `expiredPassword` in the localization
    table (`title`, `subtitle`, `newPasswordLabel`, `submit`): an app with a complete
    localization of its own adds them.
  - `@tula-tech/nextjs`: its `<SignIn>` is `@tula-tech/react`'s and gains the screen; the route handler
    forwards the new operation like every `/v1/client/*` call.
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
- c97d084: First prerelease of the React SDK.
  
  - `@tula-tech/react`: `TulaProvider`, the hooks (`useAuth`, `useUser`, `useSession`, `useSignIn`,
    `useSignUp`, `useResetPassword`, `usePasswordChecklist`, `useClientConfig`, `useTula`),
    `SignedIn` / `SignedOut` / `TulaLoading`, and the prebuilt `SignIn` (with forgotten
    password), `SignUp`, `UserButton` and `UserProfile`, with one themeable stylesheet
    (`@tula-tech/react/styles.css`), an `appearance` prop and a typed localization table.
  - `@tula-tech/contract`: a Zod-free `/theme` entry point: the theme tokens shared by every front
    end, their light and dark defaults, `themeToCssVariables`, `isValidThemeValue` (theme values
    are validated against a strict grammar and dropped when they do not match) and
    `contrastRatio`.
  - `@tula-tech/core`: a tab waiting for the cross-tab lock now waits for as long as a refresh can
    take with its one retry, so an app with a small `timeoutMs` no longer has two tabs refresh at
    once; `user.get()` no longer installs a user fetched for an earlier session; and a 204's
    empty body is read, so browsers stop listing successful sign-outs as cancelled requests.
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
- d615c72: Step-up by emailed code, `hasPassword` on the signed-in user, and a colour-scheme fix.
  
  - `@tula-tech/contract`: `StepUpMethod` gains `email_code`, `StepUpRequest` accepts
    `{ method: 'email_code', code }`, and `StepUpEmailCode` is the receipt of
    `POST /v1/client/sessions/step-up/email-code`. `GET /v1/client/me` answers `CurrentUser`: a
    `User` plus `hasPassword`. All additive.
  - `@tula-tech/core`: `session.prepareStepUp({ method: 'email_code' })` emails the signed-in user a
    code (for a user with a verified address and no two-step verification) and
    `session.stepUp({ method: 'email_code', code })` proves it. `stepUpMethods(error)` now
    returns `email_code` when the server lists it. New type `StepUpPrepared`; `User` now has
    `hasPassword`.
  - `@tula-tech/react`: the step-up dialog offers the emailed code: next to the password as "Email
    me a code instead" (sent only when chosen), and at once when it is the user's only method,
    with resend and the server's cooldown. `<UserProfile>` tells a user without a password how
    to add one instead of showing the change-password form. Buttons no longer fade their
    background: when the colour scheme changed under an open page the label was unreadable for
    a few frames. New localization strings: `stepUp.emailSubtitle`, `stepUp.emailSubtitleSent`,
    `stepUp.emailSending`, `stepUp.emailSend`, `stepUp.emailInstead`, `stepUp.passwordInstead`
    and `userProfile.passwordNotSet`.

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
- f226695: `<SignIn>`: "Sign in with a passkey" is listed among the other ways to sign in only once the
  browser is known to have WebAuthn.
  
  After an address, where the server offered a passkey next to another method, the link was
  drawn before the browser had been asked and taken away one render later in a browser without
  WebAuthn: a control that showed and could not work. It now arrives with the answer, as it
  already did on the second-factor and step-up screens. A sign-in whose only method is a passkey
  is unchanged: it does not open on "not supported" before the browser has been asked.
  
  The trade-off, chosen on purpose: the browser is asked after mount, so in a browser that has
  WebAuthn the link is drawn one frame after the rest of the screen, and where it is the only
  other way the whole "Other ways to sign in" list arrives with it (a small layout shift, and
  the list joins the page after the title has taken the focus). A link that appears a frame late
  was preferred to one that is shown and then removed.
- 79bc411: Security notice emails, and a loading-state fix.
  
  - `@tula-tech/contract`: `EnvironmentSettings` gains `notifications: { passwordChanged, newSignIn }`
    (both `true` by default): whether an account's owner is emailed when their password changes
    and when the account is signed in to from a new device. Additive; documents saved earlier
    read as "on".
  - `@tula-tech/react`: `useSession` reports `isLoading: true` for the whole first fetch under
    React's StrictMode. The effect runs twice in development; its second run cleared the flag and
    then joined the first run's request without setting it again.
- Updated dependencies [a036657]
- Updated dependencies [a34eb0e]
- Updated dependencies [b38efc0]
- Updated dependencies [1c76ead]
- Updated dependencies [55115bc]
- Updated dependencies [0a5e496]
- Updated dependencies [9166270]
- Updated dependencies [ac15d68]
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
- Updated dependencies [bb0da88]
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
- Updated dependencies [9c6253e]
- Updated dependencies [82d87eb]
- Updated dependencies [fc7d990]
- Updated dependencies [596b4cd]
- Updated dependencies [894b927]
- Updated dependencies [751eae5]
- Updated dependencies [633d73b]
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
  - @tula-tech/core@0.1.0-alpha.0
