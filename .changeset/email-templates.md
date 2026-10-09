---
'@tula/contract': minor
'@tula/config': minor
'@tula/cli': minor
'@tula/admin': minor
---

Email templates: an environment's own subject and wording for each email
(`emails.templates` in the settings, keyed by the kind of message).

- `@tula/contract` gains the kinds, the placeholders and the rules of each kind
  (`EMAIL_TEMPLATE_KINDS`, `EMAIL_TEMPLATE_PLACEHOLDERS`, `EMAIL_TEMPLATE_RULES`), the
  checks (`emailTemplateProblems`, `readsAsLink`, `parseEmailTemplate`) and the schemas
  (`EmailTemplateSchema`, `EmailTemplatesSchema`, `EmailSettingsSchema`). The settings
  document has a new section, `emails`, with no template by default: an environment that
  has saved nothing sends the email it always did.
- A template is text with `{{name}}` placeholders. One that lacks the code or the link its
  message needs is refused when saved; a security notice can be given no code, no link and
  nothing that reads as a link, and its subject cannot start with a digit.
- `@tula/config` accepts `settings.emails.templates`, validated when the file is loaded. A
  file with no template hashes as before.
- `tula diff` shows a template field by field (`emails.templates.<kind>.subject`), and
  `tula apply` removes the template of a kind the file leaves out, as for every setting.
- `@tula/admin`'s settings types include the section.
