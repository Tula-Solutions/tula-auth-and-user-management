# Text messages with Twilio: setup checklist

> **Not verified against Twilio.** Nothing in this repository has a Twilio account, and no
> request has ever been made to Twilio from it: the adapter is tested against a stubbed
> network, and **no message has been delivered to a real handset**. The request below is what
> the code sends. Twilio's rules are written from Twilio's documentation as read on
> 2026-10-09 (the pages are linked where they are used) and the Console steps have not been
> clicked through. What could not be confirmed is listed in
> [the unverified list](../plans/phase-2-unverified.md).

Twilio is the one sender that really sends ([ADR 0037](../adr/0037-phone-numbers-and-sms.md),
"Twilio"). It is a setting of the **deployment** (environment variables of the API), not of
an environment: every environment that has text messages switched on sends through the same
Twilio account. What a number is for, and how an environment switches text messages on, is
in [Phone numbers](../phone-numbers.md).

## Before anything else: sender registration

Twilio accepting a message is not the message arriving. In several countries a carrier
delivers only what comes from a **registered** sender, and registration takes days to
weeks. Start it before you need it.

| Sending to | From | What Twilio's documentation says |
| --- | --- | --- |
| United States | A 10-digit long code (`+1` and ten digits, "10DLC") | "Anyone sending SMS/MMS messages over a 10DLC number from an application to the US must register for A2P 10DLC", individuals and hobbyists included ([A2P 10DLC](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc)). Registration is a **Brand** (who you are) and a **Campaign** (what you send), and a Campaign needs "an associated Messaging Service with at least one Twilio 10DLC Phone Number in its Sender Pool" ([direct standard onboarding](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/direct-standard-onboarding)). Messages from a number tied to no approved Campaign are blocked, as [error 30034](https://www.twilio.com/docs/api/errors/30034). The onboarding page gives a Customer Profile "72 hours or more", a Brand's manual review "seven business days or more", and a Campaign review 10 to 15 days in one place and two to three weeks in another. Brand tiers cap daily volume (a Sole Proprietor Brand: about 3,000 message segments a day across US carriers). Fees: the pages name none and link to a support article. |
| United States and Canada | A toll-free number | It "can't send SMS messages to the United States and Canada until you've completed toll-free verification" and Twilio has approved it ([toll-free verification](https://www.twilio.com/docs/messaging/compliance/toll-free/console-onboarding)). Until then traffic is blocked, as [error 30032](https://www.twilio.com/docs/api/errors/30032). It needs a paid account (not a trial) and a compliance profile. The page gives no time. |
| Other countries | A number, a short code or an alphanumeric sender | Each country has its own rules (sender registration, alphanumeric senders, templates). Twilio's geo permissions page says the account holder is responsible for them and points to the country's SMS guidelines. **Not read for any country here.** |

Two things follow for Tula:

- **For US long codes, use `TWILIO_MESSAGING_SERVICE_SID`**, not `TWILIO_FROM_NUMBER`: the
  Campaign belongs to a Messaging Service, and the number has to be in its pool.
- **A message Twilio accepts and a carrier then blocks looks sent to Tula.** The user is told
  a code is on its way and none arrives. Errors 30034 and 30032 appear in Twilio's own
  message log, not in an answer to Tula (below, "Accepted is not delivered").

Twilio suggests its Verify product for one-time codes ("Verify does not require A2P
registration or sender provisioning"). Tula does not use it: Tula makes, stores and checks
its own codes, and sends them as ordinary messages.

## Checklist

1. **Upgrade the Twilio account.** A trial account can only send to verified numbers ("up to
   5 per account"), only in the sign-up country, and, as read, only Twilio's own message
   templates ("You must use Twilio-provided templates"), which would rule out Tula's text
   altogether; trials "expire after 30 days"
   ([free trial](https://www.twilio.com/docs/messaging/guides/how-to-use-your-free-trial-account)).
   A message to a number that is not verified is refused with
   [error 21608](https://www.twilio.com/docs/api/errors/21608), which also applies to an
   upgraded account without an approved primary compliance profile.
2. **Get a sender and register it** (the table above): a number, and for the United States
   its Brand and Campaign, or toll-free verification.
3. **Create a Messaging Service and put the sender in its pool** (Twilio Console →
   Messaging → Services). Copy its SID (`MG` and 32 hexadecimal characters). Look at two of
   its settings, because both change what a subscriber gets:
   - *Smart Encoding* "replaces hidden Unicode characters with a similar GSM-encoded
     character" ([Messaging Services](https://www.twilio.com/docs/messaging/services)). Tula
     sends the text as written; with this on, Twilio may alter it. Whether it is on for a
     new service is not stated on that page.
   - *Sticky Sender* and geomatch choose which number of the pool a message comes from.
   One number and no service also works (`TWILIO_FROM_NUMBER`), where no registration needs
   a service.
4. **Set the countries Twilio may send to** (Console → Messaging → Settings → Geo
   Permissions). "By default a newly created account allows messages to be sent to your home
   country", and nowhere else; a message to a country that is not enabled is refused with
   [error 21408](https://www.twilio.com/docs/api/errors/21408)
   ([geo permissions](https://www.twilio.com/docs/messaging/guides/sms-geo-permissions)).
   **Enable exactly the countries your environments list in `sms.allowedCountries`, and no
   other.** The two lists are separate and both must allow a number:

   | Tula's `sms.allowedCountries` | Twilio's geo permissions | What happens |
   | --- | --- | --- |
   | lists the country | enabled | Sent. |
   | does not list it | either | Refused by Tula (`sms.country_not_allowed`). Twilio is never asked, and nothing is counted. |
   | lists it | **not** enabled | Twilio refuses (21408). The user gets `sms.unavailable`; the message is counted against the send limits and, because Twilio said no, taken back out of the day's count. The API's log has `twilio did not take a text message` with `twilioCode: 21408`. |

   Tula's list is per environment and Twilio's is per account, so Twilio's must be the union
   of every environment's. Twilio's cannot be changed through its API, on purpose.
5. **Turn on Twilio's SMS pumping protection** (Console → Messaging → Settings). It "uses
   automatic fraud detection to block messages flagged as being suspicious for SMS pumping
   fraud", must be enabled, and is "provided at no additional cost" for the United States
   and Canada; for other countries see Twilio's pricing
   ([SMS pumping protection](https://www.twilio.com/docs/messaging/features/sms-pumping-protection-programmable-messaging)).
   Tula never switches it off for a message (it sends no `RiskCheck` parameter, whose
   default is `enable`). A message it blocks is error 30450 in Twilio's log. It is a second
   net under [Tula's own limits](../phone-numbers.md#send-limits-and-the-daily-limit), not
   instead of them: Twilio says "No provider-side solution can guarantee 100% protection".
6. **Create an API key** (Console → Account → API keys & tokens). "API keys are the
   preferred way to authenticate with Twilio's REST APIs"
   ([API keys](https://www.twilio.com/docs/iam/api-keys)): a key is revoked by itself, and a
   *Standard* key cannot manage the account or other keys. Copy the key's SID (`SK…`) and
   its secret; the secret is shown once. A *Restricted* key limited to sending messages
   would be narrower still: whether one can be made so is **not confirmed**. The account's
   auth token works too (`TWILIO_AUTH_TOKEN`), and is the account's master credential:
   prefer the key.
7. **Give the API the variables**, on every API instance, and restart them:

   ```sh
   SMS_PROVIDER=twilio
   TWILIO_ACCOUNT_SID=AC…              # the account
   TWILIO_API_KEY_SID=SK…              # an API key …
   TWILIO_API_KEY_SECRET=…             # … and its secret   (or TWILIO_AUTH_TOKEN, never both)
   TWILIO_MESSAGING_SERVICE_SID=MG…    # a Messaging Service (or TWILIO_FROM_NUMBER, never both)
   ```

   The API refuses to start when a value is missing, is not of Twilio's shape, or when both
   ways to authenticate or both senders are set; the message names the variable and never
   repeats a value. Keep the secret where the other secrets of the deployment are. The
   webhook worker needs none of these: it sends no text message
   ([self-hosting](../self-host.md#the-webhook-worker-as-its-own-service)).
8. **Switch text messages on in the environment**: `sms.enabled`, the countries, and a
   `sms.dailyMessageLimit` you can afford at your dearest allowed destination
   ([Phone numbers](../phone-numbers.md#the-environment-the-sms-setting)).
9. **Run `tula doctor`.** Its `sms_sender` line says the deployment has a sender. It sends
   nothing and does not ask Twilio, so it does not show the credentials work.
10. **Send one message to your own phone** (add a phone number to a test account) and read
    it. Check the sender, the app name, the code, and that the last line (`@host #code`)
    arrived unchanged. Nothing in this repository has done this.

## What Tula sends

One request per message, and never a second:

```text
POST https://api.twilio.com/2010-04-01/Accounts/<TWILIO_ACCOUNT_SID>/Messages.json
Authorization: Basic <API key SID : secret, or account SID : auth token>
Content-Type: application/x-www-form-urlencoded;charset=UTF-8

To=<the number, E.164>&MessagingServiceSid=<MG…>&Body=<the text>
```

(`From=<number>` in place of `MessagingServiceSid` with `TWILIO_FROM_NUMBER`.) Three fields
and no other: no status callback, no scheduling, no link shortening, no validity period, no
`RiskCheck`. The text is the one Tula writes
([Phone numbers](../phone-numbers.md#what-the-user-sees)), unchanged.

- The host is fixed (`api.twilio.com`, Twilio's default region, US1). **An account or an API
  key of another Twilio region (IE1, AU1) is not supported**: Twilio's keys are "specific to
  the region in which they were created".
- The request has ten seconds, follows no redirect, and its certificate is checked whatever
  `NODE_TLS_REJECT_UNAUTHORIZED` says. If the API's environment sets `HTTPS_PROXY`, the
  runtime sends the request through that proxy, as it does the requests to OAuth providers
  and to the breach check. For an https address that is a tunnel: the proxy learns the
  host, not the credentials or the text. (How a proxy carries https, not something run
  here: no test of this repository goes through a proxy.)
- Tula stores nothing of Twilio's answer. Twilio keeps the message, its text included, in
  its own log; how long, and how to redact it there, is Twilio's setting.

## Accepted is not delivered

A message counts as **sent** when Twilio answers the request with any 2xx:
Twilio has taken it into its queue (`queued`, or `accepted` through a Messaging Service).
Whether it reached a phone is learned from Twilio's status callbacks, and **Tula asks for
none and reads none**. So:

- A message Twilio accepts and a carrier drops (an unregistered sender, a filtered text, a
  number that does not exist) is a sent message to Tula. The user waits for a code that
  does not come; the per-number limit lets them ask again after a minute.
- The place to look is Twilio's message log (Console → Monitor → Logs → Messaging), by the
  message SID. The API logs it at `debug` (`twilio accepted a text message`, `messageSid`).
- In the [usage counts](../phone-numbers.md#what-was-sent-and-what-was-never-used), a
  destination whose codes are sent and never used can be fraud, and can be a sender that is
  not delivering.

## When Twilio does not take a message

A send ends in one of three ways, and the difference is what happens to your
[daily limit](../phone-numbers.md#send-limits-and-the-daily-limit):

| What happened | For the user | The day's count |
| --- | --- | --- |
| **Sent**: Twilio answered a 2xx. | The code is on its way (as far as Twilio's queue). | Counted. |
| **Refused**: Twilio answered a 4xx (a 429 and a 408 included), or a redirect, which is never followed. | `sms.unavailable` (503) | **Taken back.** The message did not go. |
| **Unknown**: Twilio answered a 5xx (500, 502, 503, 504, …), nothing came back within ten seconds, or the connection failed. | `sms.unavailable` (503) | **Kept.** Twilio may have taken the message, and may bill it. |

The user's answer never holds anything of Twilio's. Nothing is retried: a retry could send
twice. After an unknown outcome a message may still arrive; its code was never stored, so
it is not accepted, and the user asks again. A 5xx is unknown and not a refusal because it
is a server failing, not a server saying no: a gateway answers 502 or 504 for a request
the service behind it may have taken. **The limit counts what may have been spent, not only
what is known to have been**: while Twilio cannot be reached, or answers 5xx, every try
uses one of the day's messages, and a long outage can use the day up. Raise `sms.dailyMessageLimit` for the
day once the cause is fixed if that happens.

The API's log has one line from the adapter and one from the send path (JSON lines; the
fields that matter are shown):

```text
{"level":40,"msg":"twilio did not take a text message","reason":"refused","status":400,"twilioCode":21608,"twilioMessage":"The number [redacted] is unverified. …"}
{"level":40,"msg":"text message not sent","environmentId":"…","reason":"failed"}

{"level":40,"msg":"twilio gave no answer for a text message","reason":"timeout"}
{"level":40,"msg":"text message not sent","environmentId":"…","reason":"unconfirmed","count":"kept"}

{"level":40,"msg":"twilio answered without saying whether it took a text message","reason":"server_error","status":503,"twilioCode":20503,"twilioMessage":"Service unavailable"}
{"level":40,"msg":"text message not sent","environmentId":"…","reason":"unconfirmed","count":"kept"}
```

| Adapter's line | `reason` | |
| --- | --- | --- |
| `twilio did not take a text message` | `refused` | Twilio answered a 4xx (or a 3xx that is no redirect to follow). `status`, and Twilio's `twilioCode` and `twilioMessage` when it sent them. The message is given back to the day. |
| | `redirected` | The answer was a redirect. It is not followed: it would carry the credentials wherever it points. Something between the server and Twilio (a proxy, a captive network) is the usual cause. |
| `twilio gave no answer for a text message` | `timeout` | No answer within ten seconds. |
| | `no_answer` | The request ended without one: DNS, the network, TLS, a connection refused or cut off. |
| `twilio answered without saying whether it took a text message` | `server_error` | Twilio, or something in front of it, answered a 5xx. `status`, and `twilioCode` and `twilioMessage` when they came. The message stays in the day's count. Look at [Twilio's status page](https://status.twilio.com/). |
| | `unexpected_status` | An answer whose status is no final answer at all (a 1xx, a number outside 100 to 599). Not expected of any runtime; kept counted like the rest. |
| `twilio accepted a text message, and its answer could not be read` | `body_unread`, `too_large`, `not_json`, `no_sid` | **The message was sent.** Twilio answered a 2xx, and its body broke off, was over 64 KB, was not JSON or held no message SID that could be logged. Only the log is poorer: find the message in Twilio's log by its time. |

`twilioMessage` is Twilio's own sentence with the recipient, the credentials, every Twilio
identifier and every run of four or more digits (however they are separated: spaces,
dots, slashes, dashes of any kind, non-breaking spaces) taken out, cut to 300 characters. The
number is never logged, and neither is the text.

| `twilioCode` | Usually means |
| --- | --- |
| 20003 | The credentials are wrong, or the key was revoked. |
| 21408 | The destination country is not enabled in Twilio's geo permissions (step 4). |
| 21608 | A trial account, or no approved compliance profile, and a number that is not verified (step 1). |
| 21211, 21614 | Twilio does not take the number for a mobile number. |
| HTTP 429 | Twilio's concurrency limit. Tula does not retry. |

(20003, 21211 and 21614 are from memory of Twilio's error list, not from a page read for
this change.)
