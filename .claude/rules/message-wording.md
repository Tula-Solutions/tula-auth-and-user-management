---
paths:
  - "apps/api/src/modules/email/**"
  - "apps/api/src/modules/message-preview/**"
  - "packages/contract/src/email-template*"
  - "packages/contract/src/sms-template*"
  - "apps/dashboard/src/features/messages/**"
---

# Email templates and the message preview

Moved here from `AGENTS.md`, word for word, and canonical for this area: `AGENTS.md` lists
this file under "Area rules" and does not repeat it. A section named in a sentence as
"above" or "below" is found through that list.

## Email templates (`modules/email`, see ADR 0039)

An environment's own subject and body for each email (`emails.templates` in its settings,
keyed by kind). The layout is the server's.

- **The kinds, the placeholders and the rules are one closed table in the contract**
  (`EMAIL_TEMPLATE_KINDS`, `EMAIL_TEMPLATE_PLACEHOLDERS`, `EMAIL_TEMPLATE_RULES` in
  `packages/contract/src/email-template.ts`: plain data, no Zod). `templateKind(message)`
  maps every message `Email.send` takes to its kind with an exhaustive `switch`. **A new
  message, or a new way an existing one is worded, is a new kind**: an entry in the three
  lists, a row in `docs/email-templates.md`, and the test "every message Email.send accepts
  has a kind in the contract's list, and every kind is sent"
  (`modules/email/wording.test.ts`) fails until both sides agree.
- **A template is text with `{{name}}` and nothing else.** No expression, no condition, no
  HTML, no escape syntax. Never add a placeholder whose value a request supplied (an IP
  address, a user agent, a name) or that holds an address, a token or a URL other than
  `link`. A new placeholder is a decision in ADR 0039.
- **`emailTemplateProblems` is the one set of rules**, called by the settings schema
  (`EmailTemplatesSchema`), by the tolerant read (`readStoredEmailTemplates`) and again by
  `renderTemplate`. A new rule goes there and nowhere else, with a row in
  `packages/contract/src/email-template.test.ts`.
- **The only link in any email is the server's own `{{link}}`: nothing an operator writes
  may read as one, in the subject or the body of any of the 28 kinds** (`readsAsLink`:
  `://`, a scheme of the closed list `EMAIL_LINK_SCHEMES` directly followed by something,
  `www.`, a letter or digit, a full stop and two letters with nothing between, or four
  groups of digits with full stops; combining marks are passed over wherever a letter may
  stand, with no quantifier inside another: keep the "work is bounded" rows). A second link next to a sign-in code is the phishing
  template, which is why the code messages are held to it too; the cost (no help-centre or
  email address in any template) is accepted, and the support address is the server's to
  write. The rule errs towards refusing (an email address, a sentence with no space after
  its full stop). Never narrow it to a list of top-level domains or to a category, never
  turn the scheme list into a pattern that takes any word before a colon (`10:30` and
  `Note: …` must pass), and never give a kind of the `notice` category a `code` or `link`
  placeholder. **The built-in copy of every kind passes the rule** (a test in
  `modules/email/wording.test.ts`): a new built-in sentence that would not is reworded.
- **A notice's subject never starts with a digit: refused at save for the text and for a
  placeholder whose value always starts with one (`EMAIL_TEMPLATE_DIGIT_PLACEHOLDERS`),
  replaced by the built-in subject at render for a value** (an app name can start with
  one). Keep both and the test of each. A new placeholder that is a number or a time goes
  in that list.
- **Every check that asks what a reader sees goes through `visibleEmailText`** (the empty
  check, the leading digit, at save and at render) **or strips the same set**
  (`readsAsLink`): `Cf`, the variation selectors and `Default_Ignorable_Code_Point`,
  removed for the check only. Never test `trim()` or the first code unit of operator text
  directly: an allowed invisible character in front defeats it.
- **The tolerant read judges a subject and a body apart** (`readStoredEmailTemplates`), as
  `renderTemplate` does: one part that no longer passes never takes the other with it. What
  a read leaves out is absent from the admin API's answer and so gone at the next save;
  the store's log line (kinds only) is the notice of it. **The memory settings store runs
  the tolerant read too**: every adapter reads a row through `readStoredRow`
  (`~/adapters/stored-settings`), and the shared suite holds them to the same answer for
  the same stored document, so a document a test puts there with `seed` or `seedStored` is read as a
  deployment's store reads it (a wording that no longer passes is gone, with the store's
  log line). A test whose subject is the renderer's **own** fallback for a wording that
  reaches a send unjudged uses `seedUnread`, the memory store's one way past the read,
  and nothing else does: no real store can hand such a document on.
- **The guarantees are about the template's own text, not the app's name.** `app.name` is
  a value and the link rule is not applied to it (a brand may be a domain name). It is
  refused **on input only** (`EnvironmentSettingsInputSchema`) when it holds what
  `hasHiddenCharacter` refuses; `EnvironmentSettingsSchema` also parses the admin API's
  answers, so the rule must never move there: a name stored before it would make every
  `GET /v1/admin/settings` a 500. A name stored before the rule is cleaned where it is
  used: `displayName` removes the same set (`withoutHiddenCharacters`, the contract's one
  definition; never a second list), and `smsAppName` already removed more.
- **A notice keeps its facts and its last words.** With a body of its own it still ends,
  in this order, with the server's "when, which device, from where" block, **the server's
  own sentence of what to do if the reader did not do this** (the last paragraph of the
  kind's built-in closing, for every kind of the `notice` category, the three "no account /
  account exists" messages included) and the support line; then the footer. Never let a
  template remove, reword or follow them, and never make the sentence a placeholder or a
  setting. A new notice kind's built-in closing ends with such a sentence: the test "…
  with a body of its own still ends with the server's own sentence" runs every kind. The
  messages that carry a code keep no sentence of the server's.
- **Hidden characters are refused at save, never stripped** (`hidden_character`: the
  text-direction controls U+202A to U+202E, U+2066 to U+2069, U+200E, U+200F and U+061C;
  `Co`, `Cn`; a lone surrogate). What is sent is what was saved. The zero-width joiner and
  non-joiner and the variation selectors stay allowed (Persian, Arabic, Indic text, emoji)
  and are delivered unchanged; `readsAsLink` removes what draws nothing **for its check
  only**, so a joiner cannot hide a domain. Keep both tables in
  `packages/contract/src/email-template.test.ts`. The pattern is one character class with
  the `u` flag, written with `\u{…}` escapes: keep it linear.
- **Operator text is escaped by the renderer, never by the template**: every character and
  every value through `escapeHtml` in the HTML part, the subject cleaned onto one line
  before a header. The only anchor is the server's, for `{{link}}`; never turn text into a
  link. A value is put in once and never parsed again.
- **A template that cannot be used is never a failed send.** The part (subject or body,
  each alone) is replaced whole by the built-in copy and logged with the environment, the
  kind, the part and a fixed word. `render` is the built-in copy and is held byte for byte
  by `builtin-copy.test.ts`: change the built-in wording there on purpose, never as a side
  effect.
- **Never a subject or a body in an audit entry, an event payload or a log line.** A change
  is the keys `emails.templates.<kind>.<subject|body>`: the kind is from the closed list,
  which is why it may be named where a JWT template's name may not.
- **The section is capped as a whole** (`MAX_EMAIL_TEMPLATES_BYTES`, 40 KiB of compact
  UTF-8 JSON): the settings are replaced in one request of at most 64 KiB
  (`MAX_BODY_BYTES`, counted on the wire, so a client that escapes non-ASCII can meet a
  413 first: documented, not changed). Raise neither the per-field caps nor the kind count
  without that sum.
- **Changing a template is not a weakening** (ADR 0039 has the argument and its edge). A
  test pins it; changing that is a decision.
- **`tula diff` shows a template field by field and prints its text through `printable()`**;
  a kind the file leaves out is removed (under `--yes` with no flag: not a weakening; the
  diff's line per kind and field is the warning), a kind this version does not know is
  `unknown`.
  `@tula/mcp`'s settings projection does not name `emails`: keep the test.
- **A test that needs a code from a reworded email reads the text, not the subject** (the
  conformance `emailMessage` step). The older email steps find a code by a subject that
  leads with one: a scenario that saves a template for a code message keeps the code first
  in its subject or uses the new step.

## The message preview (`modules/message-preview`, see ADR 0042)

`POST /v1/admin/message-preview` answers what the server would send for a draft of an
email or a text message, with sample values. It is what the dashboard's Messages screen
draws.

- **It answers text and never HTML**: `subject` and `text` (an email's text part). Never
  add the HTML part to the answer; the dashboard's Content-Security-Policy is not to be
  asked for anything, and nothing an operator typed may have something to run as.
- **It renders with the code that sends**: `renderTemplate` and `renderCodeText`, never a
  second renderer and never the contract. A draft is judged by the validators a save uses,
  and a problem is a 422 with the field under `template.`.
- **It reads the settings and writes nothing**: no store write, no message, no audit
  entry, `Cache-Control: no-store`. It is not "send me a test" and must not become one: a
  route that sends a draft sends operator-written text to anyone.
- **No request value reaches the text but the draft.** The sample values are the service's
  constants (`SAMPLE_CODE`, `SAMPLE_EMAILS`); the app's name, the support address and the
  first allowed origin are the environment's saved ones.
- **A text message is rendered with two codes**, so that an app name that happens to hold
  the sample code cannot hide a `code_not_last`. Keep the test.
- **Its limit is its own** (`MESSAGE_PREVIEW_RATE_LIMIT`, per environment, after
  `secretKey()`), and may pass when the limiter cannot count: a render is string work over
  a capped draft. Anything costlier added to the route takes that exemption away.
- A scenario that previews does not ask for the kind whose template it then saves: the
  event canary would find the request's string in `changed`. Never loosen the canary for it.

## What to test

The failure paths a change to an email template is held to (moved from the checklist of
`security.md`; the rules themselves are above and are not repeated).

- **Escaping:** HTML in a subject, a body and a value, escaped in the HTML part and literal
  in the text part; a line break or control character in a subject (refused at save, cleaned
  when it arrives through a value); a value that holds `{{code}}` not expanded again.
- **Shape:** a body of only its required placeholder; each cap one over, and the section's
  byte cap; an unknown kind, an unknown placeholder and malformed braces refused with the
  field's path and without the text; a code message without its code and a sign-in without
  its link refused; a notice given `{{code}}` or `{{link}}` refused.
- **Links:** **every kind**, the code messages included, refused for a scheme (`://`, each of
  `EMAIL_LINK_SCHEMES`), `www.`, a bare domain, an email address and an IPv4 address, in its
  subject and in its body, with `10:30`, `Note: …` and `{{appName}}.{{provider}}` accepted.
- **A notice's subject** that starts with a digit, with `{{time}}` or `{{backupCodesLeft}}`,
  or with an allowed invisible character and then a digit: refused at save and, through the
  app's name, replaced by the built-in subject at render. A subject or body of only invisible
  characters is refused as empty.
- **The tolerant read:** a stored subject surviving a stored body that no longer passes, and
  the reverse, through `readStoredEnvironmentSettings`; an app name with a text-direction
  control refused on input and still read when already stored.
- **A notice's parts:** the HTML part of every notice in the order body, facts, the server's
  sentence, support line, footer; the server's sentence once, in both parts.
- **Hidden characters:** a text-direction control, a private-use or unassigned code point and
  a lone surrogate refused at save, one row per class; a zero-width joiner and non-joiner
  accepted and delivered unchanged, and not hiding a domain from the link rule.
- **Fallback and isolation:** a stored template that no longer passes sends the built-in
  copy, logged by environment and kind; another environment's template is never used; a stale
  settings cache on another instance; every kind byte for byte the built-in copy when nothing
  is saved.
- **The record:** neither a subject nor a body in an audit entry, an event's payload, a log
  line or an error (the event canary runs the scenario with its text tapped), and `@tula/mcp`
  does not return them.
