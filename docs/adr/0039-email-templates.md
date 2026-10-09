# ADR 0039: Email templates

- **Status:** accepted
- **Date:** 2026-10-09
- **Ticket:** TULA-17 (phase 2, step 2.7)

## Context

Every email the server sends has had one layout and one wording, fixed in code
(`modules/email/templates.ts`, [ADR 0018](0018-environment-settings.md),
[ADR 0023](0023-security-notices.md)). An operator could change the app's name and the
support address and nothing else: not the language, not the tone, not a word.

Letting an operator write the words means operator-written text reaches the inbox of every
user of an environment. Whoever holds a secret key, or a dashboard session, then writes mail
that arrives from the application's own address at the moment a user expects mail from it.
This ADR says what a template can be, what it can never be, where it is stored, and what the
server still says whatever the template does.

Not in it: an editor in the dashboard (TULA-30), the wording of text messages, HTML written
by an operator, and templates per language.

## Decision

### A template is text with placeholders, and the layout stays the server's

A template has a `subject` and a `body`, each optional, each plain text in which
`{{name}}` is a placeholder. There is nothing else in the language: no expression, no
condition, no loop, no include, no HTML. A brace that is not part of a well-formed
placeholder is refused, so a literal `{` or `}` cannot be written at all; that is the price
of having no escape syntax to get wrong.

The server lays the text out. Paragraphs are what blank lines separate; a single line break
stays a line break. Every character an operator wrote and every value put in for a
placeholder is HTML-escaped in the HTML part and literal in the text part, and both parts
come from the same template. Nothing an operator typed becomes a link: the only anchor in a
message is the server's own, drawn for `{{link}}`, with the server's label. A value is put
in once and never read again as a template, so an app name that holds `{{code}}` stays those
characters.

A subject is cleaned onto one line (control characters and line breaks become a space)
before it reaches a header, as the app name always was, and a subject that renders to more
than 255 characters is not used.

### Kinds and placeholders are closed lists in the contract

`EMAIL_TEMPLATE_KINDS` (`packages/contract/src/email-template.ts`, plain data, no Zod) has
one entry per message the server words differently: 24 today. `EMAIL_TEMPLATE_RULES` gives
each kind its category (`code` or `notice`), the placeholders it must have and the ones it
may have. `templateKind(message)` in the email module maps every message `Email.send` takes
to its kind with an exhaustive `switch`; a test fails when the two lists differ, so a new
message cannot be added without deciding its placeholders.

A kind is not the message's `type`: `password_changed` alone is seven kinds, because "your
password was changed", "a password was added by an administrator" and "the password was
removed from your account" are different sentences, and one template for the seven would
have to be wrong for six.

Placeholders, all of them: `appName`, `code`, `link`, `expiresInMinutes`, `device`, `time`,
`provider`, `backupCodesLeft`. Each is something the server knows: the device is a family
from a fixed list ([ADR 0023](0023-security-notices.md)), the provider a fixed name, the
time the server's clock in UTC. There is no placeholder for the reader's address, for
another address, for an IP address or for a user agent. The full table is in
[docs/email-templates.md](../email-templates.md).

### What is refused when a template is saved

`emailTemplateProblems(kind, template)` is the one set of rules; the settings schema calls
it for every template (`EmailTemplatesSchema`), so the admin API, `defineConfig()` and the
server's own tolerant read agree. A refusal names the field
(`emails.templates.<kind>.<subject|body>`) and, for a placeholder, its name; it never
repeats the template's text.

- An unknown kind, an unknown key, a subject over 200 characters, a body over 2,000.
- A control character other than a line break in a body; any in a subject.
- A character that changes what a reader sees without being seen, or that is nobody's
  (below).
- Malformed braces; a placeholder the kind does not have.
- A **body without a placeholder its message needs**: `{{code}}` for the four messages that
  carry a code, and `{{link}}` as well for `sign_in`. A body is where the code must be; a
  subject may leave it out.
- `{{link}}` in a subject, and `{{link}}` in the same paragraph as `{{code}}` (a paragraph
  that names the link is left out of a message that has none, and must not take the code
  with it).
- For a **notice** (the 17 security notices, and the three messages that answer a request
  for an address without giving it a code: `account_exists`, `no_account`,
  `no_account_sign_in`): what the next two sections say.

### Hidden characters are refused, not stripped

A template that holds any of these is refused when it is saved (`hidden_character`, the
field's path, a fixed reason):

- a **text-direction control**: the embeddings, overrides and their pop (U+202A to U+202E),
  the isolates and their pop (U+2066 to U+2069), the two direction marks (U+200E, U+200F)
  and the Arabic letter mark (U+061C). They reorder what a reader sees, so that the text
  reviewed and the text read differ;
- a **private-use or unassigned code point** (`Co`, `Cn`, noncharacters among them): it
  means whatever the reader's font says it means;
- **half a surrogate pair**: not a character at all.

Refused, and not removed on the way out: the message sent is the template saved, byte for
byte, and a server that quietly edits what it was given leaves the operator reviewing one
text and the user reading another. A stored template that holds one (written past the API,
or by another version) is not used, like any template that no longer passes.

**The zero-width joiner and non-joiner (U+200D, U+200C) and the variation selectors are
allowed.** Persian, Arabic and Indic text is not written correctly without the first two,
and emoji sequences need all three. They are delivered unchanged. The link rule ignores
them when it looks for a domain, so `exam<ZWJ>ple.com` in a notice is still refused as a
link. Right-to-left text needs no control character: the bidirectional algorithm orders it.

The other format characters (the zero-width space, the word joiner, the soft hyphen, the
byte-order mark, tag characters) are allowed too: each has an ordinary use (line breaking,
flag emoji), none reorders text, and the link rule ignores them as well. Which code points
count as unassigned is the runtime's Unicode version: a character newer than it is refused
until the runtime knows it.

The pattern is one character class matched with the `u` flag, so its cost is linear.

### A notice carries no code, no link, and nothing that reads as one

A security notice tells the owner of an account that something changed. Its value is that
it asks for nothing: no code to enter, no link to follow. A notice that can be given either
is a phishing template with the application's own sender.

So a notice kind has no `code` and no `link` placeholder, and its text is refused when it
**reads as a link** (`readsAsLink`). The text is first normalised (NFKC; format characters
and variation selectors removed, for the check only) and then refused for any of:

- a scheme: `://` anywhere, or `mailto:`, `tel:`, `sms:`;
- `www.`;
- **a letter or digit, a full stop, and two or more letters** with nothing between them
  (`example.com`, `bit.ly`, `пример.рф`; the ideographic full stop counts).

The third rule is deliberately wider than "a domain name". It also refuses an email
address, a file name, a version number followed by letters, and a sentence with no space
after its full stop. That is the side it errs on: mail clients turn bare domains into links
themselves, no list of top-level domains stays true, and the operator's cost of a false
refusal is a space. The cost of a miss is a link in a security notice. The support address
is not lost by this: it is the environment's `app.supportEmail`, and the server writes it
under every notice itself.

What the rule does not stop is said under "What a template can still do".

### A notice's subject never starts with a digit

A subject that leads with digits is how a reader, and a notification, tells a code message
from every other ([ADR 0023](0023-security-notices.md)). The rule is held twice, because
the text and the values come from different places:

- **at save**, a notice subject whose text starts with a digit (any Unicode decimal digit)
  is refused;
- **at render**, a notice subject that starts with one once its placeholders are filled (an
  app name can start with a digit: `{{appName}} security notice` for "1Password") is not
  used, and the built-in subject is sent.

### A notice keeps its facts and its last words

With a body of its own, a notice still ends with what the server wrote before. After the
operator's paragraphs, in this order, in the text part and in the HTML part:

1. **the facts** (a security notice): `When`, and where the message has them `Device`,
   `IP address`, `Backup codes left`;
2. **the server's own sentence of what to do if the reader did not do this**: the last
   paragraph of the kind's built-in closing, for all 20 kinds of the notice category;
3. **the support line** (a security notice, when a support address is set): where to write
   if the reader cannot get back in.

Then the footer. Nothing an operator writes comes after the sentence, and no template can
suppress or replace it: it is not part of the template. A template changes how a notice is
worded, never what it reports or what it tells the reader to do. The lines are the
server's, in English, and an operator who writes a version of the sentence in the body
sends it twice.

| Kinds | The fixed sentence (`{app}` is the app's name) |
| --- | --- |
| `password_changed`, `password_added`, `password_reset_completed`, `password_added_by_reset`, `password_set_by_admin`, `password_added_by_admin`, `mfa_enabled`, `mfa_disabled`, `mfa_reset_by_admin`, `backup_codes_regenerated`, `backup_code_used`, `passkey_added`, `passkey_removed` | If it wasn't you, or you did not expect it, open {app} and reset your password from the sign-in screen right away. |
| `password_removed` | If you did not just sign in, open {app} and reset your password from the sign-in screen right away. |
| `new_sign_in` | If it wasn't you, open {app} and reset your password from the sign-in screen right away. Resetting the password signs every device out. |
| `identity_linked`, `identity_unlinked` | If it wasn't you, or you did not expect it, open {app} and reset your password from the sign-in screen right away, then review the connected accounts in your profile. |
| `account_exists` | If it wasn't you, you can safely ignore this email. Your account has not changed. |
| `no_account`, `no_account_sign_in` | If it wasn't you, you can safely ignore this email. |

What is not kept is the built-in paragraph before it ("If this was you, there is nothing
more to do.", "If you expected this, …"): that one reassures and asks for nothing, and it
is the operator's to word or leave out. The four messages that carry a code keep no
sentence of the server's: their closing ("If you didn't request this, …") is the
operator's, as before.

### Where it is stored: the settings document

`emails.templates` in the environment's settings ([ADR 0018](0018-environment-settings.md)),
keyed by kind, `{}` by default, in the strict input schema and the lenient stored one. It
gets everything the settings already have: the revision and `If-Match`, the audit entry,
the config file, the "managed by" record, the per-instance cache.

**Size.** Every request body is capped at 64 KiB (`MAX_BODY_BYTES`), and the settings are
replaced whole, so a section that could grow to 24 kinds at 2,200 characters each (52,800
characters, more in bytes) could make a document that can be stored once and never saved
again. The section is therefore capped as a whole: `MAX_EMAIL_TEMPLATES_BYTES`, **40 KiB**
of UTF-8 JSON. That is the worst case of the section, and it leaves 24 KiB for the rest of
the document. All 24 kinds at full length do not fit; about eighteen do, fewer in a script that takes
more than one byte a character. A table of its own was
the alternative and was not built: it buys size nobody has asked for and loses the
revision, the single replace and the config file's one document.

One cost is accepted and stated: the settings row is read whole wherever settings are read,
and the Postgres adapter's scan of every environment's allowed origins reads every row. A
deployment with thousands of environments that each fill their 40 KiB pays for it there.

### Reading is tolerant

Settings are read on the request path, so a stored template that this version would not
accept must never be a failed read (`readStoredEmailTemplates`): an unknown kind is left
out, a template that no longer passes its kind's rules is left out, and a section over the
byte cap is left out whole. The store logs the environment, the kinds and a count, never
text.

`Email.send` checks again with the message in hand (`renderTemplate`). A part that cannot
be used is replaced **whole** by the built-in copy for that part, and the subject and the
body fall back independently: never a half-rendered message, never a 500, never an unsent
code. The log line holds the environment, the kind, the part and a fixed word (`invalid`,
`missing_value`, `leading_digit`, `empty`, `too_long`).

An environment that has saved nothing sends the built-in copy byte for byte: `render` was
not changed, and a snapshot of every kind, taken before the work, holds it.

### The audit entry names the kind and the field, never the words

`Settings.changedKeys` flattens to leaves, so a changed template is recorded as
`emails.templates.<kind>.<subject|body>` in the audit entry and in
`environment.settings_updated`. At most 48 keys, inside the event's bounds.

JWT templates record only `sessions.jwtTemplates` ([ADR 0036](0036-jwt-templates.md)),
because a JWT template's name is the operator's own string and is also a value in the
document. An email template's kind is neither: it comes from the contract's closed list, a
kind the list does not have is refused before anything is recorded, and "the wording of the
password-reset email changed" is exactly what a reader of the audit log needs. The subject
and the body themselves are never in an audit entry, an event payload or a log line; the
event canary runs scenario 71 with its template text tapped.

### Not a weakening

A change to a template is not in `settingsWeakenings`. A weakening is a change that removes
a protection the server enforces, and what the server enforces here cannot be removed by a
template: the code is still required, a notice still cannot carry a code or a link, and its
facts are still appended. So `tula apply --yes` and the dashboard do not ask.

This is a judgement with a known edge: an operator can word a notice so that it says
little, or says something false, and nothing flags that change above any other. The audit
entry names the kind; that is the record.

### The config file

`emails.templates` in `tula.config.ts` is the same shape, validated by the same schema when
the file is loaded. The file is the whole truth, as for every other setting: **a kind the
file leaves out has its template removed**, and the built-in copy is sent. `tula diff`
shows a template field by field (`emails.templates.<kind>.subject`), also when a whole
template is added or removed, and prints the text as it prints every other string setting
(`app.name` is printed), cut at the same 100 characters, after `printable()`: the server's
copy was written by somebody else. A template of a kind this version of the CLI does not
know is an unknown setting and needs `--allow-unknown`. An environment with no template
hashes as it did before templates existed.

### The dashboard and the MCP server

The dashboard has no screen for templates yet. A save from any settings screen sends the
document it loaded, templates included, so a save does not reset them (a test holds it).
`@tula/mcp`'s `get_settings` is an allow-list projection that does not name `emails`: an
agent reading the settings does not get up to 40 KiB of an operator's prose, and a test
holds that too.

### When a change takes effect

With the settings cache ([ADR 0018](0018-environment-settings.md)): at once on the instance
that saved, within 5 seconds elsewhere with Redis and 30 without. For that long two
instances may word the same message differently. Nothing safe depends on it: the rules
above are held at render on every instance, whatever template it has.

### Finding a code in an email

Nothing in the product reads a subject. The tests did: the conformance runner, the SDK
journeys and the browser tests find a code by a subject that leads with six digits. An
operator's subject need not, so the conformance format gained a step that reads an email
the way a person does (`emailMessage`: found by a marker in its subject, the code taken
from the text). The older steps are unchanged, and a scenario that rewords a code message
keeps the code first in its subject or uses the new step.

## What a template can still do

Stated so that nobody assumes otherwise. An operator, or whoever holds an operator's key,
can:

- **Write anything that is not a link.** "Call 555 0100 and read out your code", "reply to
  this email with your password", a false statement about what happened. Digits that are
  not a URL are not refused; a telephone number is not refused unless written as `tel:`.
- **Leave a code message without its warning.** A code message need not say "never share
  this code" or "if you did not ask for this, ignore it". (A notice cannot lose its own:
  the server writes it.)
- **Contradict the server's sentence from above it.** The body can say "this is routine,
  ignore what follows"; the sentence still follows, last, in the server's words.
- **Bury the code or the facts** under 2,000 characters of text.
- **Say a different expiry**: with a body of its own the line about how long a code lasts
  is the operator's, and nothing checks a number typed in place of `{{expiresInMinutes}}`.
- **Spell a link so that the rule misses it and a person does not**: `example dot com`,
  `example . com`. No mail client links those; a reader can still follow them.
- **Use look-alike letters** (a Cyrillic `а` for a Latin one) and zero-width characters
  that are allowed, in what a reader sees. Text-direction controls are refused; joiners
  are ignored by the link rule and sent as written.
- **Put the code in the subject** of a code message, where a lock screen shows it. The
  built-in copy does the same.

None of it is new power: the same operator already chooses the app name, the support
address, the allowed origins and the redirect URLs. It is, though, the first setting whose
abuse is aimed at the users and reads like the application speaking.

## Consequences

- An environment can word and translate every email; the layout, the button and the footer
  cannot be changed.
- A notice with its own body is part operator's words, part server's English lines (the
  facts, the sentence of what to do, the support line). An application that needs a notice
  fully in another language cannot have it yet.
- The link's label, and the facts' labels, are not translatable.
- A literal brace, an email address in a notice and a domain name in a notice cannot be
  written.
- The settings document can be 40 KiB larger.

## Not built

- The editor, its preview and "send me a test" (TULA-30).
- Templates for text messages; templates per language; operator HTML.
- An announcement to anyone when a template changes, beyond the audit entry and the event.
- A contract entry point of its own for the template module: it is Zod-free but exported
  from the index only, and no SDK needs it at run time yet.
