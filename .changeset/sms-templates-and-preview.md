---
'@tula/contract': minor
'@tula/config': minor
'@tula/cli': minor
'@tula/admin': minor
'@tula/mcp': patch
---

Text message wording and a preview of any message (`sms.templates` in the settings, and
`POST /v1/admin/message-preview`).

- `@tula/contract` gains the kinds of text message, their placeholders and rules
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
  reads as a link, or text directly beside a placeholder, or does not start with a letter.
- `@tula/config` accepts `settings.sms.templates`, validated when the file is loaded. A
  file with no wording hashes as before.
- `tula diff` shows `sms.templates.<kind>.text` as one line, and `tula apply` removes the
  wording of a kind the file leaves out, as for every setting.
- `@tula/admin` has the `previewMessage` operation and the new settings types.
- `@tula/mcp`'s `get_settings` still returns `enabled`, `allowedCountries` and
  `dailyMessageLimit` of `sms`, and not the wording.
