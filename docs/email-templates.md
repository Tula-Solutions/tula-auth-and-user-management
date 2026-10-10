# Email templates

Every email Tula sends has a built-in wording. An environment can replace the **subject**
and the **body** of each message with its own: another language, another tone, your
product's vocabulary. The layout, the way a code is drawn, the button of a sign-in link and
the footer stay Tula's.

An environment that has saved no template sends exactly what it always did.

The reasoning, and what a template can and cannot be made to do, is in
[ADR 0039](adr/0039-email-templates.md).

## Write a template

Templates live in the environment's settings, under `emails.templates`, keyed by the
[kind](#kinds-and-placeholders) of message. A template has a `subject`, a `body`, or both;
the part you leave out keeps the built-in wording.

| Where | How |
| --- | --- |
| `tula.config.ts` | `settings.emails.templates` ([settings as code](config.md)). |
| Admin API | `PUT /v1/admin/settings`, which replaces the whole document: read it, change `emails.templates`, send it back with `If-Match`. |
| Dashboard | Not yet. Saving any settings screen keeps the templates the environment has. |

```ts
import { defineConfig } from '@tula/config'

export default defineConfig({
  environments: {
    prod: {
      settings: {
        emails: {
          templates: {
            email_verification: {
              subject: '{{code}} is your {{appName}} code',
              body: 'Welcome to {{appName}}.\n\n{{code}}\n\nThe code works for {{expiresInMinutes}} minutes.',
            },
            password_changed: {
              subject: 'Your {{appName}} password was changed',
              body: 'The password of your {{appName}} account was changed at {{time}}.\n\nIf this was not you, reset your password now from the sign-in screen.',
            },
          },
        },
      },
    },
  },
})
```

## The language

A template is plain text. `{{name}}` is a placeholder; there is nothing else: no
conditions, no loops, no HTML.

- **Paragraphs** are separated by a blank line. A single line break stays a line break.
- **Everything you write is text.** In the HTML part it is escaped character by character,
  so `<b>` arrives as those three characters, and nothing you type becomes a link.
- **No link, address or domain name of your own, in any kind** ([below](#no-link-of-your-own)).
  The only link in an email is Tula's own, for `{{link}}`.
- **`{{code}}` alone in a paragraph** is drawn large, as in the built-in email. Inside a
  sentence it is bold.
- **`{{link}}`** becomes Tula's button in the HTML part and the address in the text part.
  Give it a paragraph of its own or share one with words, but not with `{{code}}`. In an
  email that has no link (the environment has emailed links switched off) a paragraph that
  names `{{link}}` is left out.
- **No hidden characters.** A template is refused when it holds a text-direction control
  (U+202A to U+202E, U+2066 to U+2069, U+200E, U+200F, U+061C), a private-use or unassigned
  character, or half a surrogate pair. They are refused and never silently removed: what
  you save is what is sent. Right-to-left text needs none of them. The zero-width joiner
  and non-joiner and emoji variation selectors are fine, and arrive as you wrote them; a
  subject or a body of nothing but such characters counts as empty and is refused.
- **A brace is only ever a placeholder.** A `{` or `}` that is not part of `{{name}}` is
  refused; there is no way to write a literal one.
- **A subject is one line.** It may use every placeholder of its kind except `{{link}}`.
- A subject is at most 200 characters and a body at most 2,000. All of an environment's
  templates together are at most 40 KiB as JSON, which is about eighteen bodies of full
  length.
- **Send the settings as UTF-8.** The 40 KiB are counted as compact UTF-8 JSON, but a
  request is refused over 64 KiB as it arrived. A client that writes every character
  outside ASCII as a `\uXXXX` escape, or indents the document, can get
  `413` for templates that are within their limit. `@tula/admin` and `tula apply` send
  compact UTF-8.

Under every body Tula adds its footer: the app's name and, when the environment has one,
the support address.

## Kinds and placeholders

Every kind may use `{{appName}}`. **Required** placeholders must be in the body, or the
template is refused when you save it.

### Messages that carry a code

| Kind | Sent when | Required | Optional |
| --- | --- | --- | --- |
| `email_verification` | A sign-up, or a sign-in to an unverified address, needs the address proven. | `code` | `appName`, `expiresInMinutes` |
| `password_reset` | A password reset was asked for an address that has an account. | `code` | `appName`, `expiresInMinutes` |
| `sign_in` | A sign-in by emailed code or link was asked for an address that has an account. | `code`, `link` | `appName`, `expiresInMinutes` |
| `step_up` | A signed-in user without a second factor confirms it is them before a sensitive change. | `code` | `appName`, `expiresInMinutes` |

The built-in subjects lead with the code, so that it can be read from a notification. Yours
need not.

**Keep a sentence about the browser in a `sign_in` body.** The link works only in the
browser that asked for it ([emailed link](methods/email-link.md)), and the built-in email
says so. With a body of your own that sentence is yours to write: without one, a user who
opens the link on another device is refused with no warning. Something like "The link
works only in the browser you asked from; anywhere else, type the code."

### Messages that answer for an address without a code

Sent so that asking gets the same answer whether or not an address has an account. They
follow the [rules for notices](#notices).

| Kind | Sent when | Optional |
| --- | --- | --- |
| `account_exists` | Someone tried to sign up with an address that already has an account. | `appName` |
| `no_account` | A password reset was asked for an address with no account. | `appName` |
| `no_account_sign_in` | A sign-in by email was asked for an address with no account. | `appName` |

### Security notices

Which of them are sent at all is the environment's `notifications` setting.

| Kind | Sent when | Optional |
| --- | --- | --- |
| `password_changed` | The user changed their password. | `appName`, `time` |
| `password_added` | The user set a password on an account that had none. | `appName`, `time` |
| `password_reset_completed` | A password reset replaced the password. | `appName`, `time` |
| `password_added_by_reset` | A password reset gave a password to an account that had none. | `appName`, `time` |
| `password_set_by_admin` | An administrator replaced the password. | `appName`, `time` |
| `password_added_by_admin` | An administrator gave a password to an account that had none. | `appName`, `time` |
| `password_removed` | The address was proven for the first time by someone who had not proven the password, and the password was removed ([emailed code](methods/email-code.md)). | `appName`, `time` |
| `new_sign_in` | The account was signed in to from a device not seen before. | `appName`, `time`, `device` |
| `mfa_enabled` | Two-step verification was turned on. | `appName`, `time` |
| `mfa_disabled` | Two-step verification was turned off. | `appName`, `time` |
| `mfa_reset_by_admin` | An administrator reset two-step verification. | `appName`, `time` |
| `backup_codes_regenerated` | New backup codes replaced the old ones. | `appName`, `time` |
| `backup_code_used` | A backup code was used to sign in. | `appName`, `time`, `backupCodesLeft` |
| `sms_factor_enabled` | A texted code became the account's second step. | `appName`, `time` |
| `sms_factor_removed` | A texted code stopped being the account's second step (turned off, reset by an administrator, or its phone number removed or replaced). | `appName`, `time` |
| `passkey_added` | A passkey was added. | `appName`, `time` |
| `passkey_removed` | A passkey was removed. | `appName`, `time` |
| `identity_linked` | A provider account was connected. | `appName`, `time`, `provider` |
| `identity_unlinked` | A provider account was disconnected. | `appName`, `time`, `provider` |

### What a placeholder holds

| Placeholder | Value |
| --- | --- |
| `appName` | The environment's app name. |
| `code` | The six-digit code. |
| `link` | The sign-in link, which works only in the browser that asked for it ([emailed link](methods/email-link.md)). |
| `expiresInMinutes` | How long the code works, as a number. |
| `time` | When it happened, in UTC: `2026-10-03 14:05 UTC`. |
| `device` | The kind of device, from Tula's fixed list: `Chrome on Windows`. |
| `provider` | The provider's name: `Google`. |
| `backupCodesLeft` | How many backup codes are unused, as a number. |

There is no placeholder for an email address, an IP address or anything the request said
about itself.

## No link of your own

The subject and the body of **every** kind, the messages that carry a code included, are
refused when they hold something that reads as a link:

- a scheme: `://` after anything (`https://…`, `myapp://…`), or `mailto:`, `tel:`, `sms:`,
  `xmpp:`, `sip:`, `facetime:`, `skype:`, `callto:`, `whatsapp:`, `tg:`, `data:`,
  `javascript:`, `file:` and their like, directly followed by something;
- `www.`;
- a letter or digit followed by a full stop and two or more letters with no space between
  (`example.com`). That also refuses an email address, a file name and a sentence with no
  space after its full stop;
- an IP address written as four numbers (`192.0.2.7`), which also refuses a four-part
  version number.

So **you cannot put a help-centre address, a website or an email address in any email**,
not even beside a code. That is on purpose: a second link next to a sign-in code is exactly
what a phishing email looks like, and whoever can change your settings writes these
messages. For a contact, set the environment's support address (`app.supportEmail`): Tula
writes it in the footer of every email and under every notice.

Not refused: a time (`10:30`), a label with a space after its colon (`Note: …`, `Tel: 555
0100`), and `{{appName}}.{{provider}}`. If a sentence of yours is refused, look for a full
stop with no space after it.

## Notices

A security notice asks its reader for nothing, and that is what makes one trustworthy. So
the templates of the notices, and of the three messages that carry no code, are held to
more:

- **No code and no link.** Those placeholders do not exist for these kinds.
- **A subject that does not start with a digit.** A subject that leads with digits is how a
  reader tells a code from everything else. A subject that starts with a digit is refused,
  and so is one that starts with `{{time}}` or `{{backupCodesLeft}}`, whose values always
  do; an invisible character in front changes nothing. If your subject starts with
  `{{appName}}` and the name starts with a digit, the built-in subject is sent instead.
- **The facts and the last words stay.** After your paragraphs Tula still writes, in this
  order: when it happened and, where the message has them, the device, the IP address and
  the number of backup codes left; then **its own sentence of what to do if the reader did
  not do this**; then, when a support address is set, where to write if the reader cannot
  get back in. Those lines are in English, and nothing of yours comes after them.

**Do not write your own "if this was not you" sentence**: Tula adds its own to every one of
these messages, and yours would be said twice. The sentence, by kind (`{app}` is your app's
name):

| Kinds | Tula's sentence |
| --- | --- |
| The password, two-step verification and passkey notices, except the two below | If it wasn't you, or you did not expect it, open {app} and reset your password from the sign-in screen right away. |
| `password_removed` | If you did not just sign in, open {app} and reset your password from the sign-in screen right away. |
| `new_sign_in` | If it wasn't you, open {app} and reset your password from the sign-in screen right away. Resetting the password signs every device out. |
| `identity_linked`, `identity_unlinked` | If it wasn't you, or you did not expect it, open {app} and reset your password from the sign-in screen right away, then review the connected accounts in your profile. |
| `account_exists` | If it wasn't you, you can safely ignore this email. Your account has not changed. |
| `no_account`, `no_account_sign_in` | If it wasn't you, you can safely ignore this email. |

What you do write is everything before it: what happened, and anything a reader who did do
it should know. The messages that carry a code get no sentence from Tula; say there what
your users should do with a code they did not ask for.

## When a template is refused, and when it is not used

A save that holds a template the rules refuse is answered `422 validation.failed`, naming
the field (`emails.templates.password_changed.body`) and never repeating your text. Nothing
is stored. `tula diff` and `tula apply` refuse the same file when they load it.

A stored template can still fail later: a placeholder with no value for one message, a
subject that renders too long or starts with a digit because of the app's name. Then **the
built-in wording is sent for that part** (the subject and the body separately), and the
server logs `email template not used` with the environment, the kind, the part and the
reason. A message is never sent half-filled and never held back.

**After an upgrade, check the log before you save settings.** A newer version of Tula can
refuse text an older one stored (this version, for one, refuses a link in a code message).
Such a subject or body is left out when the settings are read, by itself: the other part of
the template stays in use, and the server logs the kinds it left text out of. It is also
left out of what `GET /v1/admin/settings` answers, so **the next save of the settings, from
anywhere, stores the document without it and the text is gone**. If the log names a kind,
write its wording again before, or with, your next save.

Text messages have a wording of their own, with other rules:
[phone numbers](phone-numbers.md#your-own-wording).

## Seeing a template before it is saved

The dashboard's **Messages** screen lists every kind, edits its subject and body, and
shows the message as the server would write it ([dashboard](dashboard.md)). The preview
is a route of the admin API, so anything else can ask too:

```json
{
  "channel": "email",
  "kind": "password_reset",
  "template": { "subject": "Reset your {{appName}} password" }
}
```

`POST /v1/admin/message-preview` answers with `subject` and `text`, the email's text part,
filled with sample values (the code `123456`, a sample link, a fixed time and device) and
the environment's saved app name and support address. `template` may hold a subject, a
body, both or neither; what it leaves out is the built-in wording. `unused` names a part
the server would replace and why: a subject that would start with a digit once the app's
name is in it, for one. A draft a save would refuse is refused the same way, with the
field under `template.` (`template.body`).

The preview is the text part only. It never returns HTML, and the dashboard draws it as
text. It stores nothing, sends nothing, records nothing, and is limited to 120 calls a
minute per environment.

## Templates and `tula apply`

The config file is the whole truth: **a kind the file leaves out has its template removed**,
and a file with no `emails` key removes them all. `tula apply --yes` does that without any
further flag, because sending the built-in wording is not a weaker setting. `tula diff`
shows each removal as its own line (`- emails.templates.<kind>.body … (the built-in copy
is sent)`): read it before applying to an environment whose wording was written in another
place.

## When a change takes effect

On the instance that saved it, at once. On other instances within 5 seconds with Redis and
30 without ([self-hosting](self-host.md)). For that long two instances may word the same
message differently.

## What is recorded

A change is in the audit log and in the `environment.settings_updated` event as the fields
that changed, `emails.templates.<kind>.subject` or `.body`, never the words. A change of
wording is not flagged as weakening security.

`tula diff` prints a changed subject or body, cut at 100 characters, as it prints every
other setting. The MCP server's `get_settings` does not return templates.

## Whoever can change the settings writes your users' email

A template is mail from your application to every user of the environment. The rules above
keep a code where it has to be and every link but Tula's own out. They do not judge what
the words say: a template can tell a reader to phone a number, to reply with their
password, or nothing useful at all. And they are rules about the template's own text: the
app's name is put into every message as it is, a name may be a domain name, and a mail
client may turn one into a link. Treat a secret key and a dashboard session accordingly, and watch
for `emails.templates` in the audit log.

## Not built

- "Send me a test", and a preview of the HTML part.
- Your own HTML, and templates per language.
- Translating the button of a sign-in link, and the facts and the last sentence under a
  notice.
