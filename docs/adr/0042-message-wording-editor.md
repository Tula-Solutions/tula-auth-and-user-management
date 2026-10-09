# ADR 0042: Text message templates, the message preview and the editor

- **Status:** accepted
- **Date:** 2026-10-09
- **Ticket:** TULA-30 (phase 2, step 2.7)

## Context

[ADR 0039](0039-email-templates.md) let an environment word its own emails and left three
things out: the wording of text messages, a preview, and a screen. An operator could write a
template only as JSON through the admin API or in `tula.config.ts`, and learned what it
looked like by causing the email.

A text message is a narrower thing than an email and a more expensive one. It has no layout
to keep an operator's words inside, it is billed by the segment, and its last line
(`@host #code`, [ADR 0037](0037-phone-numbers-and-sms.md)) is what lets a phone offer the
code on the application's own site and nowhere else. Everything in the product and in its
tests that reads a code from a message takes the **last run of exactly six digits**. An
operator who can write the message can, unless something stops them, write a second such
line, a link, or six digits of their own.

This ADR says what a text message template can be, how a draft is previewed, and what the
dashboard's screen is. The rules of an email template are unchanged.

## Decision

### A template is one sentence, and the last line stays the server's

`sms.templates` in the settings document, keyed by kind, each `{ text }`. The text is one
line with `{{name}}` placeholders, in the grammar of an email template and nothing more.
The server renders it, then appends its own line, exactly as it does for the built-in text:

```
<the environment's sentence>

@<host of the first allowed origin> #<code>
```

The template never holds that line and has no field for it. An environment with no allowed
origin has no such line, as before.

### Two kinds, two placeholders

`SMS_TEMPLATE_KINDS` (`packages/contract/src/sms-template.ts`, Zod-free): one kind per
reason the server texts a code.

| Kind | Sent when | Required | May also name |
| --- | --- | --- | --- |
| `phone_verification` | A signed-in user proves a phone number. | `code` | `appName` |
| `sign_in` | A sign-in by texted code was asked for a number that signs in. | `code` | `appName` |

Both have the same built-in sentence, `Your {{appName}} verification code is {{code}}.`
They are two kinds because they are two messages: an operator may want the sign-in to say
that it is one. `Sms.sendCode`'s caller names the kind, which chooses words and nothing
else: no limit, no order and no count depends on it.

There is no `{{expiresInMinutes}}`. The built-in text has never said how long a code lasts,
the two kinds' lifetimes are the callers' and not the message's, and a number in the
sentence is one more run of digits next to the code. Adding it is a decision, with the
digit rule below.

### What is refused when a template is saved

`smsTemplateProblems(kind, template)` is the one set of rules, called by the settings
schema, by the tolerant read and again before every send.

| Refused | Why |
| --- | --- |
| Empty, or only characters that draw nothing | Nothing to send. |
| Over 140 characters | The cost per message (below). Checked first, so every other pattern runs over at most 140 characters. |
| A control character or a line break | A template is one line. The only line break of a message is the server's. |
| A hidden character (the email rule's set) | What is sent is what was saved and can be seen. |
| A brace that is not part of `{{name}}`, or an unknown name | The grammar. |
| No `{{code}}` | The message exists to carry it. |
| A placeholder written twice | A second `{{code}}` is a second code in the text; a second `{{appName}}` breaks the bound on the length. |
| A letter, a digit or another placeholder directly beside a placeholder | A code must stand alone to be read, by a person and by a phone's code detection. |
| Four or more digits in a row, of any script | Only the code may look like a code. Checked on the text without the characters that draw nothing, so a zero-width joiner cannot split a run. |
| An `@` or a `#` at the start of a word | It is how the origin-bound line is recognised. A template that writes `@other-host #123456` would bind the code to a host the operator chose. Compared after NFKC, so the full-width forms are refused too. |
| Something that reads as a link (`readsAsLink`, the email rule) | A phone turns it into one, next to a sign-in code. |
| A text that does not start with a letter of its own | The message starts with a word, as the built-in one does: a leading placeholder would let the code, or an app name that starts with a digit, lead the message. |

The rules err towards refusing, as the email rules do: `Call 0800 1234` is refused, and so
is `Ask @support`. The accepted cost is that a text message can hold a sentence and nothing
that looks like an address, a number or a handle.

### The code is checked again when the message is rendered

A template's own text cannot put six digits after the code. A value can: the app's name is
the operator's, is put in as it is (through `smsAppName`), and may hold six digits. In an
environment with an allowed origin the server's last line ends the message with the code
whatever the sentence says. In one without, `Use {{code}} for {{appName}}` with the app
`Acme 123456` would end with the wrong digits.

So `renderCodeText` renders, appends the line, takes the last run of exactly six digits of
the result and compares it with the code. If it is not the code, the **built-in text is
sent** and the reason is logged as a fixed word (`code_not_last`) with the environment and
the kind, never the text. A template that fails the rules at send time (stored by a later
version, or written past the API) is replaced the same way (`invalid`). A template that
cannot be used is never a failed send and never a message whose code cannot be found.

### The cap, in segments

140 characters (UTF-16 code units) for the template. The arithmetic, stated so that the
number can be argued with:

- A template names the app at most once. With the longest name the settings accept (64
  characters, in place of the 11 of `{{appName}}`) and the 6 digits in place of the 8 of
  `{{code}}`, the sentence is at most 140 − 11 + 64 − 8 + 6 = 191 characters; the constant's
  comment rounds this up to 193 by not crediting the code's placeholder.
- The server's last line adds a blank line, `@`, the host, ` #` and the code: 11 characters
  and the host, which is at most 253.
- So a message is at most 193 + 11 + 253 = 457 characters. In the GSM 7-bit alphabet that
  is **at most three segments** (3 × 153 = 459) whatever the host, and at most two with a
  host of up to 102 characters.
- One character outside that alphabet, in the template or in the app's name, makes a carrier
  send the whole message as UCS-2: 67 characters a segment instead of 153, and the same
  worst case is seven segments.

The built-in message with a short name and host is one segment. An operator who writes
Cyrillic, Arabic or an emoji pays more per message, and the preview says how many segments
the sample is. The cap bounds the cost per message; `sms.dailyMessageLimit` still counts
**messages**, not segments, and that is unchanged: a daily limit in segments or in money is
the "limit in money" of ADR 0037's "Not built".

`smsSegments` is an estimate. It assumes the GSM 7-bit default alphabet and its extension
table, and a provider may count one more at a boundary (it does not split a two-septet
character or a surrogate pair). The docs call it an estimate.

### Stored, read and recorded like an email template

- **In the settings document** (`sms.templates`, default `{}`), under the same revision and
  `If-Match`. No migration.
- **Reading is tolerant** (`readStoredSmsTemplates`): a template that no longer passes is
  left out and the built-in text is sent, a kind this version does not know is left out, and
  the store logs the kinds, never the text.
- **The audit entry and the event name the kind and nothing of the words**:
  `sms.templates.<kind>.text` in `changed`. The kind is from a closed list, which is why it
  may be named (the rule of ADR 0039).
- **Not a weakening.** A template adds no way in and removes no check; what it can say is
  bounded by the table above and by the server's own last line. This follows ADR 0039 and
  has its edge: whoever can change the settings writes the sentence a user reads beside
  their code.
- **The limits are untouched.** Nothing of `Sms.sendCode`'s order, its limiter rows or the
  day's count reads a template.
- **`tula.config.ts`**: `settings.sms.templates`, validated by the contract's schema when
  the file is loaded. `tula diff` shows `sms.templates.<kind>.text` as one line through
  `printable()`; a kind the file leaves out is removed (the built-in text is sent, and the
  line says so); a kind this version does not know is an unknown setting. An environment
  with no template hashes as it did before templates existed (a test pins the value).
- **`@tula/mcp`**: `get_settings` names `enabled`, `allowedCountries` and
  `dailyMessageLimit` of `sms` and not `templates`, for the reason it does not name
  `emails`: an operator's prose is not what an agent asked for.

### The preview is a route, and answers text

`POST /v1/admin/message-preview`, behind `secretKey()` like every admin route.

```json
{ "channel": "sms", "kind": "sign_in", "template": { "text": "Use {{code}} to sign in." } }
```

`template` is optional: without it the answer is the built-in wording. For an email it may
hold a subject, a body or both, as a stored template may. The answer:

```json
{
  "channel": "sms",
  "kind": "sign_in",
  "subject": null,
  "text": "Use 123456 to sign in.\n\n@app.example.com #123456",
  "unused": [],
  "segments": { "encoding": "gsm7", "units": 46, "segments": 1 }
}
```

The other way to preview was to move the rendering into the contract and render in the
browser. It was not taken, for three reasons.

1. **The built-in copy and the layout are the server's.** Twenty-four kinds of email, their
   lead, their closing, the facts block of a notice and the sentence under it are some 900
   lines of `modules/email/templates.ts`, held byte for byte by a test. A second renderer in
   the contract is a second copy of them, in every bundle that imports the contract, to be
   kept equal for ever.
2. **Only the server can say what it would really send.** Whether a subject is replaced
   because the app's name starts with a digit, whether a text message falls back because
   the code would not be last, which host the last line names: these depend on the
   environment's saved values and on rules that run at send time. A client-side rendering
   would show the draft; the route shows the message, and `unused` says which part would be
   replaced and why.
3. **The answer is text.** The route never returns HTML: `subject` and `text` (an email's
   text part). The dashboard draws both as text nodes. There is nothing for an operator's
   words to run as, and the dashboard's Content-Security-Policy is not asked to permit
   anything.

What the route is held to:

- **It reads and writes nothing but the settings.** No store is written, no message is
  sent, nothing is recorded: a preview is not a change. `Cache-Control: no-store`.
- **A draft is judged as a save would judge it.** A problem is a 422 with the field under
  `template.` (`template.text`, `template.subject`, `template.body`), from the same
  validators.
- **Sample values are fixed and are the server's**: the code `123456`, a fixed time, device,
  provider and count, and a sample link. The app's name, the support address and the first
  allowed origin are the environment's **saved** ones. No request value reaches the text
  except the draft itself.
- **A sample code that the app's name happens to hold is not allowed to hide a fallback.** A
  text message is rendered a second time with another code; if either rendering would fall
  back, the preview says `code_not_last`.
- **It has a limit of its own**, 120 a minute per environment, mounted after `secretKey()`.
  It may pass when the limiter cannot count (`whenUnavailable: 'allow'`): nothing guessable
  and nothing costly is behind it (a render is string work over at most 2,200 characters).
- **It is not "send me a test".** Sending a draft to an address or a number is a way to
  make the server send operator-written text to anyone, and is not built.

`@tula/admin` gets the operation from the OpenAPI document like any other. `@tula/mcp` has
no tool for it: a preview takes a body, and the facade forwards `GET` only.

### The screen

**Messages**, under an environment, is a `SettingsFrame`: the wording is part of the
settings document, so it has that document's one save model and no other. Load with the
revision, replace with `If-Match`, "changed elsewhere" on a 412, a confirmation when the
settings are managed by a config file. A change of wording is not a weakening and is not
asked about.

- **Every kind is listed**, from the contract's two lists, in four groups, each marked
  "Built-in", "Own wording" or, after a save the server refused, "Refused". A kind added to
  the contract does not compile in the dashboard until it has a label.
- **An editor per part**: subject and body for an email, text for a text message. An empty
  part is no part: the key is left out of the document, which is how the server stores
  "built-in". "Reset to built-in" takes the kind's template out.
- **Placeholders are buttons**, drawn from the contract's rules for the kind and the part (a
  subject is offered no `link`, a notice neither `code` nor `link`), each a real button with
  a name that says what it puts in and where. A placeholder goes in at the caret and the
  focus returns to the field.
- **Why a wording would be refused is said as it is typed**, by the contract's validator in
  the contract's words, on the field (`aria-invalid`, announced). After a save the server
  refused, its field errors are shown on the same fields. The screen has no rule of its own.
- **The preview is the route's answer**, asked for once the draft has rested 300 ms, and
  not at all while the draft would be refused. It is drawn as text. An answer to an earlier
  draft is shown dimmed with "Updating the preview"; an answer for another kind is never
  shown. A part the server would replace is said in words, and a text message's segments
  are stated.
- **Characters that cannot be seen are named**, under the field and under the preview
  (`U+200D`), instead of being written out. `printable()`, which the dashboard uses for an
  address, escapes every space and every combining mark: right for an address, unreadable
  for a sentence. `unseenCodePoints` (`src/lib/printable.ts`) names what is hidden and
  leaves the text alone.
- **Nothing follows the operator to another environment**: the draft, the chosen kind and
  the preview are state of a screen `EnvironmentGate` remounts, and a preview request names
  the environment its screen was drawn for (`src/environment-switch.test.tsx`).
- **The chosen kind is not in the address.** It is state of the screen. Putting it in a
  search parameter means a `validateSearch` in the route file, which runs before Zod is
  switched to its interpreter; the cost is that a reload opens the first kind.

### Finding a text in a test

The conformance `smsCode` step gained `textContains` and `textExcludes`: strings the
message must and must not hold, filled after the code is captured. Not the whole text: the
last line names a host only the server knows. A failed check says which entry failed and
nothing of the message. The scenario "text message wording" is one of those CI's
`self-host` jobs must see pass, by name.

In that scenario the preview is asked for another kind than the one whose template is
saved. The event-canary test treats any string a request carried and an event then holds as
a leak, and a kind's name is in `changed`, by design, when its template is saved. Asking
the preview for the same kind would make the request body carry the name as a value. The
canary was left as strict as it was.

## What a template can still do

- Say something false in one sentence: that the code is for something else, that the user
  should read it to a caller. The rules bound the form of the message, not its meaning.
- Name the app as anything the settings accept. The app's name is a value, the link rule is
  not applied to it, and a name that is a domain may be shown as a link by a phone. That is
  ADR 0039's edge, unchanged.
- Cost more: up to three segments in GSM 7-bit, up to seven in UCS-2, per message, while
  the daily limit counts messages.

## Consequences

- `Sms.sendCode`'s callers say which kind they send.
- "A message's words are written in `modules/sms/templates.ts` and nowhere else" now reads:
  the **built-in** words, the rendering of an environment's own and the server's last line
  are there and nowhere else; what an environment may write is the contract's.
- The settings document can be about 300 bytes larger.
- One more admin route, with a rate limit of its own.
- The dashboard has one more screen and no new save path.

## Not verified

- No real phone was sent a message: that a phone offers the code from a message in an
  environment's own words was not seen. The last line is byte for byte what it was.
- No carrier's segment count was compared with `smsSegments`.
- The screen was driven in Chromium only.

## Not built

- "Send me a test", for an email or a text message.
- A preview of an email's HTML part: the preview is the text part.
- Templates per language; a template for the last line; `{{expiresInMinutes}}` in a text
  message.
- A daily limit in segments or in money.
- The chosen kind in the address.
