# Texted code

A 6-digit code sent by text message (SMS) to a phone number an account has already proven:
a way to **sign in** beside the password or the emailed code. Off by default, and the
weakest of the methods: read "Security properties and limits" before switching it on. The
reasoning is in [ADR 0037](../adr/0037-phone-numbers-and-sms.md).

It does not sign anyone **up**. A user adds a phone number to their account while signed in
([phone numbers](../phone-numbers.md)); from then on they can sign in with it. It is not a
second step and not a way to step up.

## Switch it on

Three things must all be true before a sign-in is offered a texted code:

| What | Where |
| --- | --- |
| The deployment can send text messages. | `SMS_PROVIDER` ([phone numbers](../phone-numbers.md#switch-it-on)). |
| The environment sends them, to at least one country. | `sms.enabled` and `sms.allowedCountries`. |
| The method is on. | `signIn.methods.smsCode`. |

Through the admin API:

<!-- snippet: examples/docs-snippets/admin.ts#settings-sms-sign-in -->
```ts
const { data } = await admin.call('getEnvironmentSettings')
await admin.call('replaceEnvironmentSettings', {
  headers: { 'If-Match': ifMatch(data.revision) },
  body: {
    ...data.settings,
    signIn: {
      methods: { ...data.settings.signIn?.methods, smsCode: { enabled: true } },
    },
    sms: { ...data.settings.sms, enabled: true, allowedCountries: ['US'] },
  },
})
```
<!-- /snippet -->

- The texted code cannot be the **only** method: nobody signs up with it, so an environment
  with nothing else could never gain a user. Keep the password, the emailed code, an OAuth
  provider or passkeys on.
- Switching it on is recorded as a **weakening** (`weakened: true` in the audit log): the
  dashboard asks first, and `tula apply --yes` needs `--allow-weaker`. So is adding a
  country while it is on.
- The dashboard has no switch for it yet and `tula.config.ts` no words of its own: it is
  the `signIn.methods.smsCode` key of the settings in both.
- `tula doctor` **fails** (`sms_sender`) when an environment has the method and text
  messages on in a deployment with no sender: the method is then offered to nobody.

## What the user sees

In `<SignIn>` (`@tula/react`), where the environment lists the method:

1. The first field reads **Email address or phone number**. A number is typed with its
   country code (`+1 415 555 0142`); a number without one is taken for an address.
2. For a number: **Text me a code**. Nothing is sent before the button is pressed, because
   a message costs money.
3. **Check your phone**: the code, valid for ten minutes. The words are "if you can sign in
   with the number ending in 42, we texted it a code": the screen is the same for a number
   no account has, and so cannot say that a message went. **Text a new code** works again
   after a minute.
4. A second step, where the account has one.

A number is offered the texted code and nothing else (a password typed for a phone number
signs nobody in); "Change" leads back to the first field for an address. An address is
never offered the texted code.

**An older client** (a version of `@tula/react` from before this method, or a native app
not updated yet) has no form for `sms_code`. It leaves out a strategy it does not know, and
shows "This step is not supported" where that is the only one. Since the texted code is
never the only method, its users sign in another way and are simply never offered a text
message; its first field stays an email field.

## Security properties and limits

- **Whoever receives a number's messages can enter the account**: a swapped SIM, a number
  the carrier gave to someone else, a forwarded line, a shared phone. No password and no
  inbox is needed. This is why the method is off by default.
- **What such a session can do is limited.** It is not a recent authentication, however new:
  changing the password, the phone number, passkeys or two-step verification asks for a
  step-up, and a texted code is not a way to step up. Its token says `amr: ["sms"]`: your
  backend can refuse what it would not allow on a phone number alone.
- **A user with two-step verification still gets the second step.** Where two-step
  verification is `required` and the account has none yet, a texted code is refused
  (`mfa.enrolment_needs_other_sign_in`): whoever holds the phone must not be the one to
  enrol the account's factor. The user signs in another way first.
- **A number signs in only when exactly one account holds it**, and only when it was proven
  in the last 365 days (each sign-in with a texted code renews that). A number two accounts
  have proven signs in neither; a number unused for a year stops working until its owner
  removes and adds it again. Neither user is told.
- **Asking for a code answers the same for every number.** A number no account can sign in
  with gets the same screens, the same limits and no message. Whether a message could be
  sent is not reported either: a failed send is in the API's log, not on the screen.
- A code works once, for the attempt and the number it was asked for, and counts against
  the number's lockout. Every failure is the same `auth.invalid_credentials`.
- **A locked-out number is told "wrong code", not "wait".** Guesses for a number are
  counted whoever makes them: five are free, then each failure makes the number wait,
  from 30 seconds, doubling, up to 15 minutes at a time; the count is forgotten after an
  hour without a failure and cleared by a success. While the number waits, every code is
  answered `auth.invalid_credentials`, the right one included. This differs from the
  password and the emailed code, which answer `rate_limited` with `Retry-After` while
  locked. The reason is uniformity only (every failure of this step is the one generic
  answer); it hides nothing, since a number nobody holds locks at the same count. The cost
  is that the person is not told to wait, nor for how long;
  a new code does not help until the wait is over.
- **A code is kept only once the message was taken by the provider.** When the send fails,
  or nothing says whether it went, no code is stored: there is nothing to guess against,
  and a code texted earlier in the same attempt keeps working.
- A number is texted at most once a minute and five times an hour, whoever asks; an address
  asks at most twenty times an hour; the [send limits and the daily
  limit](../phone-numbers.md#send-limits-and-the-daily-limit) apply as to every message.
- **Anyone who knows a number can stop it signing in by SMS** for a while: its guesses and
  its five messages an hour are the number's, not the asker's. **Anyone at all can stop
  texted codes for a destination or the whole environment for an hour** by asking for codes
  to made-up numbers: no message is sent and nothing is paid, and the hourly shares are
  used up all the same. Your users' other methods keep working.
- The phone number is in no log line, event, webhook or audit entry.

## SDK calls

`<SignIn>` needs no prop for this: it draws what the environment enables.

`@tula/core`:

<!-- snippet: examples/docs-snippets/core.ts#sms-code -->
```ts
// The identifier is the number with its country code: '+1 415 555 0142'.
const flow = await tula.signIn.start({ identifier: phoneNumber })
// flow.step.strategies includes 'sms_code' where the method is on, whatever the number
await flow.prepareFirstFactor({ strategy: 'sms_code' })
// The same answer for every number; a message goes only to one that signs in.
const step = await flow.attemptFirstFactor({ strategy: 'sms_code', code })
// A wrong code, and a number that cannot sign in, are both `auth.invalid_credentials`.
```
<!-- /snippet -->

Reference: [`@tula/core`](../reference/core.md), [`@tula/react`](../reference/react.md).

## Troubleshooting

| Code | What it means and what to do |
| --- | --- |
| `auth.method_disabled` | The texted code is off, or was switched off while the attempt was open. A change takes up to 5 seconds to reach every API instance. |
| `sms.disabled` | Text messages are off for the environment, or its country list is empty. |
| `sms.country_not_allowed` | The number's country is not on the environment's list. This is answered for any number of that country, with or without an account. |
| `sms.unavailable` | The deployment has no way to send a text message (`SMS_PROVIDER=none`). |
| `auth.invalid_credentials` | The code did not sign in: wrong, expired, replaced by a newer one, too many guesses, the number is locked out for now (up to 15 minutes; unlike the password and the emailed code, which say `rate_limited`), the message was never sent, or the number cannot sign in at all (no account, two accounts, proven more than a year ago). The answer never says which. |
| `mfa.enrolment_needs_other_sign_in` | Two-step verification is required and the account has not set it up. Sign in with another method. |
| `auth.user_banned` | The account is banned. Said only after the right code. |
| `rate_limited` | A code was asked for too soon or too often (for this number, from this address, to this destination, by the whole environment), or the daily limit is reached. Wait for `Retry-After`; the server's log names the limit. |
| `flow.not_found` | The attempt expired (ten minutes) or the call came from another client. Start again. |

No message arriving is not an error code. The number may not be one that signs in; the
send may have failed (the API's log: `twilio did not take a text message`); or a carrier
dropped it. In development the message is in the [development SMS
inbox](../phone-numbers.md#the-development-sms-inbox).
