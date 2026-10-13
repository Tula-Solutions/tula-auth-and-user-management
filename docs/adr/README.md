# Architecture decisions

One record per decision, numbered in the order they were taken. This page lists the ones the
security rules of [`AGENTS.md`](../../AGENTS.md) rest on, by topic; the directory holds every
record.

- [ADR 0004](0004-signing-keys-and-issuer.md): signing keys and the issuer.
- [ADR 0005](0005-api-keys.md): API keys.
- [ADR 0006](0006-passwords.md): passwords.
- [ADR 0007](0007-verification-codes.md): verification codes.
- [ADR 0008](0008-sessions.md): sessions.
- [ADR 0009](0009-flows.md): flows.
- [ADR 0010](0010-user-management.md): users.
- [ADR 0011](0011-rate-limits-and-lockout.md): rate limits and lockout.
- [ADR 0012](0012-events-and-audit-log.md): events and the audit log.
- [ADR 0015](0015-password-reset.md): password reset.
- [ADR 0016](0016-redis-and-multiple-instances.md): Redis and several instances.
- [ADR 0017](0017-retention.md): retention.
- [ADR 0018](0018-environment-settings.md): per-environment settings and CORS.
- [ADR 0019](0019-flow-engine-v2.md): attempt binding, first-factor choice and second factors.
- [ADR 0020](0020-packaging-and-release.md): packaging and releases.
- [ADR 0021](0021-core-sdk.md): the client SDK and where it keeps tokens.
- [ADR 0022](0022-react-sdk.md): the React components, theming and browser tests.
- [ADR 0023](0023-security-notices.md): security notice emails and what "a new device" means.
- [ADR 0024](0024-email-sign-in.md): signing in by email (codes, same-browser links, passwordless sign-up).
- [ADR 0025](0025-mfa.md): two-step verification (TOTP, backup codes, step-up, the MFA policy).
- [ADR 0026](0026-oauth.md): OAuth sign-in and account linking.
- [ADR 0027](0027-passkeys.md): passkeys.
- [ADR 0028](0028-session-profiles.md): session profiles, the stateful session type and its CSRF argument, and the concurrent-session rule.
- [ADR 0029](0029-nextjs-sdk.md): the Next.js SDK (the same-origin route handler, its cookies, offline verification and the header that carries a stateful session's claims).
- [ADR 0030](0030-config-and-apply.md): settings as code, the admin client and the "managed by" record.
- [ADR 0031](0031-instance-admin-and-cli.md): the instance admin token, diagnostics and the CLI.
- [ADR 0032](0032-dashboard.md): the dashboard's session, its CSRF rules, the control plane and how the app is served.
- [ADR 0033](0033-mcp-server.md): the MCP server, what it may return and why it has no write tools.
- [ADR 0056](0056-mcp-settings-config-diff.md): a settings change drafted by an assistant as an edit to the config file.
- [ADR 0034](0034-webhooks.md): webhooks.
- [ADR 0035](0035-hooks.md): hooks, where one is asked and what it cannot do.
- [ADR 0036](0036-jwt-templates.md): JWT templates, the `ext` namespace, reserved claims and the size cap.
- [ADR 0037](0037-phone-numbers-and-sms.md): a phone number on an account, the SMS sender and its development inbox, and the `sms` settings.
- [ADR 0038](0038-password-history.md): the password history, what is compared with it and what it costs.
- [ADR 0039](0039-email-templates.md): email templates, what one can never be and what a notice keeps.
- [ADR 0040](0040-native-app-identity.md): native apps, the two association files, where they are served and what registering an app is taken to be.
- [ADR 0041](0041-password-expiry.md): password expiry, where it is decided and what a sign-in with an expired password can do.
- [ADR 0042](0042-message-wording-editor.md): the wording of a text message, the message preview and the dashboard's Messages screen.
- [ADR 0043](0043-device-binding.md): device binding (the proof, the nonce, the order of a bound refresh's checks, what binding proves and does not).
- [ADR 0044](0044-app-link-and-custom-scheme-redirects.md): app links, custom-scheme redirect URLs and which providers may return to one.
- [ADR 0045](0045-native-id-token-exchange.md): a native app's sign-in with a provider's ID token, the server's nonce and the accepted client ids.
- [ADR 0047](0047-native-apple-sign-in.md): native Sign in with Apple (the bundle ID as the audience, the hashed nonce, the name beside the token).
- [ADR 0048](0048-expo-passkeys-and-providers.md): passkeys and provider sign-in in an Expo app (the passkey provider, the browser session, what is refused without a request).
- [ADR 0050](0050-native-type-generation.md): the generated Swift and Kotlin types (data only, which enumerations and unions keep a value they do not know, what stops a generation).
- [ADR 0051](0051-swift-client.md): the Swift client (the session by `@tula/core`'s rules, the Keychain, what a step with no call is, how its journeys are held to the list).
- [ADR 0057](0057-swiftui-screens.md): the SwiftUI screens (the model that decides and the views that draw, how a theme value becomes a colour or a length, the slots, the simulator UI tests and what they did not show).
- [ADR 0060](0060-swiftui-second-step-and-account.md): the SwiftUI screens for the second step, the other ways to sign in and the account (what is drawn only where its sheet was given, backup codes before the sign-in is reported, the step-up that owes what was asked for).
- [ADR 0061](0061-compose-screens.md): the Compose screens (the module that decides and the one that draws, why the strings are a Kotlin table, what a rotation costs, the emulator UI tests and what they did not show).
- [ADR 0062](0062-compose-second-step-and-account.md): the Compose screens of the second step, a passkey, the providers, a texted code and the account (when a way is drawn, what is kept of a setup key and backup codes, the copy, the step-up form, which callback an app leaves a screen on).
- [ADR 0055](0055-expo-emailed-link.md): an emailed sign-in link opened in an Expo app (the binding in memory, the one app link that is read, what is refused without a request, what an ended app costs).
- [ADR 0034](0034-webhooks.md): webhooks (endpoints, the signing secret, the signature, the delivery worker and what is kept of a receiver's answer).
