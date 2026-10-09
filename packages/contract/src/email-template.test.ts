import { describe, expect, test } from 'bun:test'
import {
  EMAIL_TEMPLATE_DIGIT_PLACEHOLDERS,
  EMAIL_TEMPLATE_KINDS,
  EMAIL_TEMPLATE_PLACEHOLDERS,
  EMAIL_TEMPLATE_RULES,
  type EmailTemplateKind,
  emailTemplateParagraphs,
  emailTemplateProblems,
  emailTemplatesBytes,
  isEmailTemplateKind,
  MAX_EMAIL_BODY_LENGTH,
  MAX_EMAIL_SUBJECT_LENGTH,
  MAX_EMAIL_TEMPLATES_BYTES,
  parseEmailTemplate,
  readStoredEmailTemplates,
  readsAsLink,
} from './email-template'
import { EmailSettingsSchema, EmailTemplatesSchema } from './email-template-schema'
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  EnvironmentSettingsInputSchema,
  EnvironmentSettingsSchema,
  readStoredEnvironmentSettings,
} from './environment-settings'

const NOTICES = EMAIL_TEMPLATE_KINDS.filter(
  (kind) => EMAIL_TEMPLATE_RULES[kind].category === 'notice'
)
const CODES = EMAIL_TEMPLATE_KINDS.filter((kind) => EMAIL_TEMPLATE_RULES[kind].category === 'code')

function codes(kind: EmailTemplateKind, template: { subject?: string; body?: string }) {
  return emailTemplateProblems(kind, template).map(({ field, code }) => `${field}:${code}`)
}

/** A body that passes for a kind: every placeholder it needs, each in its own paragraph. */
function minimalBody(kind: EmailTemplateKind): string {
  const { required } = EMAIL_TEMPLATE_RULES[kind]
  return required.length === 0 ? 'Hello.' : required.map((name) => `{{${name}}}`).join('\n\n')
}

describe('the table of kinds', () => {
  test('every kind has rules, and every rule names known placeholders', () => {
    expect(Object.keys(EMAIL_TEMPLATE_RULES).sort()).toEqual([...EMAIL_TEMPLATE_KINDS].sort())
    for (const kind of EMAIL_TEMPLATE_KINDS) {
      const { required, optional } = EMAIL_TEMPLATE_RULES[kind]
      for (const name of [...required, ...optional]) {
        expect(EMAIL_TEMPLATE_PLACEHOLDERS).toContain(name)
      }
      expect(new Set([...required, ...optional]).size).toBe(required.length + optional.length)
    }
  })

  test('the four code messages need the code, and sign-in the link too', () => {
    expect(CODES).toEqual(['email_verification', 'password_reset', 'sign_in', 'step_up'])
    for (const kind of CODES) {
      expect(EMAIL_TEMPLATE_RULES[kind].required).toContain('code')
    }
    expect(EMAIL_TEMPLATE_RULES.sign_in.required).toEqual(['code', 'link'])
  })

  test('no notice has a code or a link to name, and none has anything from a request', () => {
    for (const kind of NOTICES) {
      const { required, optional } = EMAIL_TEMPLATE_RULES[kind]
      expect(required).toEqual([])
      expect(optional).not.toContain('code')
      expect(optional).not.toContain('link')
    }
    // No placeholder for an address of any kind, a user agent or a token.
    expect([...EMAIL_TEMPLATE_PLACEHOLDERS]).toEqual([
      'appName',
      'code',
      'link',
      'expiresInMinutes',
      'device',
      'time',
      'provider',
      'backupCodesLeft',
    ])
  })

  test('isEmailTemplateKind knows the list and nothing inherited', () => {
    expect(isEmailTemplateKind('sign_in')).toBe(true)
    for (const name of ['constructor', '__proto__', 'toString', 'sms_code', '']) {
      expect(isEmailTemplateKind(name)).toBe(false)
    }
  })
})

describe('parseEmailTemplate', () => {
  test('splits text and placeholders in order', () => {
    expect(parseEmailTemplate('{{code}} is your {{appName}} code')).toEqual([
      { placeholder: 'code' },
      { text: ' is your ' },
      { placeholder: 'appName' },
      { text: ' code' },
    ])
    expect(parseEmailTemplate('plain')).toEqual([{ text: 'plain' }])
    expect(parseEmailTemplate('')).toEqual([])
  })

  test.each([
    ['a space inside', 'Hi {{ code }}'],
    ['one brace', 'Hi {code}'],
    ['an unclosed placeholder', 'Hi {{code'],
    ['a stray closer', 'Hi code}}'],
    ['three braces', 'Hi {{{code}}}'],
    ['an expression', '{{code | upper}}'],
    ['a dotted name', '{{user.email}}'],
    ['a condition', '{{#if code}}x{{/if}}'],
    ['a nested name', '{{{{code}}}}'],
    ['a name that starts with a digit', '{{1code}}'],
    ['an empty name', '{{}}'],
    ['a lone brace in text', 'a } b'],
  ])('refuses %s', (_, text) => {
    expect(parseEmailTemplate(text)).toBeNull()
  })
})

describe('emailTemplateParagraphs', () => {
  test('blank lines separate paragraphs; a single line break stays inside one', () => {
    expect(emailTemplateParagraphs('One.\n\n\nTwo,\nstill two.\n \t\nThree.\n')).toEqual([
      'One.',
      'Two,\nstill two.',
      'Three.',
    ])
    expect(emailTemplateParagraphs(' \n\n ')).toEqual([])
  })
})

describe('emailTemplateProblems', () => {
  test.each([...EMAIL_TEMPLATE_KINDS])('%s accepts a body of only what it needs', (kind) => {
    expect(emailTemplateProblems(kind, { body: minimalBody(kind) })).toEqual([])
  })

  test.each([...EMAIL_TEMPLATE_KINDS])('%s accepts every placeholder it lists', (kind) => {
    const { required, optional, category } = EMAIL_TEMPLATE_RULES[kind]
    const all = [...required, ...optional]
    const body = all.map((name) => `Value {{${name}}}`).join('\n\n')
    const subject = `${category === 'notice' ? 'About' : ''} ${all
      .filter((name) => name !== 'link')
      .map((name) => `{{${name}}}`)
      .join(' ')}`
    expect(emailTemplateProblems(kind, { subject, body })).toEqual([])
  })

  test('a code message without its code is refused, by name', () => {
    for (const kind of CODES) {
      const problems = emailTemplateProblems(kind, { body: 'No code here. {{appName}}' })
      expect(problems).toContainEqual({
        field: 'body',
        code: 'missing_placeholder',
        placeholder: 'code',
        message: 'the body must contain {{code}}',
      })
    }
  })

  test('a sign-in template without the link is refused', () => {
    expect(codes('sign_in', { body: 'Your code: {{code}}' })).toEqual(['body:missing_placeholder'])
    expect(emailTemplateProblems('sign_in', { body: 'Your code: {{code}}' })[0]?.placeholder).toBe(
      'link'
    )
  })

  test('a subject alone needs no placeholder', () => {
    expect(emailTemplateProblems('sign_in', { subject: 'Sign in to {{appName}}' })).toEqual([])
  })

  test('the link and the code share no paragraph', () => {
    expect(codes('sign_in', { body: 'Use {{code}} or {{link}}' })).toEqual([
      'body:link_beside_code',
    ])
    // A single line break is still one paragraph.
    expect(codes('sign_in', { body: '{{code}}\n{{link}}' })).toEqual(['body:link_beside_code'])
    expect(codes('sign_in', { body: '{{code}}\n\n{{link}}' })).toEqual([])
  })

  test('a placeholder the kind does not have is refused with its name', () => {
    expect(emailTemplateProblems('password_reset', { body: '{{code}} {{device}}' })).toEqual([
      {
        field: 'body',
        code: 'unknown_placeholder',
        placeholder: 'device',
        message: '{{device}} is not a placeholder of this message',
      },
    ])
    // A link exists only for sign-in, and never in a subject.
    expect(codes('email_verification', { body: '{{code}}\n\n{{link}}' })).toEqual([
      'body:unknown_placeholder',
    ])
    expect(codes('sign_in', { subject: 'Open {{link}}' })).toEqual(['subject:unknown_placeholder'])
    expect(codes('sign_in', { body: '{{code}}\n\n{{link}}\n\n{{nope}}' })).toEqual([
      'body:unknown_placeholder',
    ])
  })

  test('a long unknown name is not repeated whole', () => {
    const [problem] = emailTemplateProblems('account_exists', { body: `{{${'n'.repeat(300)}}}` })
    expect(problem?.placeholder).toBe(`${'n'.repeat(40)}…`)
    expect(problem?.message.length).toBeLessThan(100)
  })

  test.each(NOTICES)('%s cannot be given a code, a link or a token', (kind) => {
    for (const name of ['code', 'link', 'token', 'url', 'ipAddress', 'email', 'userAgent']) {
      expect(codes(kind, { body: `Hello {{${name}}}` })).toContain('body:unknown_placeholder')
      if (name !== 'link') {
        expect(codes(kind, { subject: `Hello {{${name}}}` })).toContain(
          'subject:unknown_placeholder'
        )
      }
    }
  })

  test.each([
    ['https', 'Go to https://evil.test/reset now'],
    ['http', 'Go to http://evil.test'],
    ['another scheme', 'Open app://reset'],
    ['www', 'Go to www.evil.test'],
    ['a bare domain', 'Visit evil.com to confirm'],
    ['a domain made with the app name', 'Visit {{appName}}.com to confirm'],
    ['an email address', 'Write to help@evil.test'],
    ['mailto', 'mailto:someone'],
    ['a telephone link', 'Call tel:+15550100'],
    ['full-width letters', 'Visit ｅｖｉｌ．ｃｏｍ'],
    ['an ideographic full stop', 'Visit evil。com'],
    ['a zero-width space in the scheme', 'Go to htt\u{200B}ps:/\u{200B}/evil.test'],
    ['a zero-width space in the name', 'Visit evil\u{200B}.com'],
    ['a sentence with no space after its full stop', 'It changed.If not you, act'],
    ['a combining grapheme joiner in the name', 'Visit exa\u{034F}mple.com'],
    ['a Khmer inherent vowel in the name', 'Visit exa\u{17B4}mple.c\u{17B5}om'],
    ['a soft hyphen in the name', 'Visit exam\u{00AD}ple.com'],
    ['a word joiner after the dot', 'Visit example.\u{2060}com'],
    ['a tag character in the name', 'Visit example.\u{E0061}com'],
    ['an IPv4 address', 'Go to 203.0.113.7 now'],
    ['an IPv4 address with a path', 'Open 192.168.1.1/login'],
    ['an IPv4 address in full-width digits', 'Open １０.０.０.１'],
    ['a scheme nobody listed', 'Open foo-bar+x://thing'],
    ['xmpp', 'Write xmpp:eve@evil'],
    ['facetime', 'Call facetime:eve'],
    ['facetime-audio', 'Call facetime-audio:eve'],
    ['skype', 'Call skype:eve?call'],
    ['callto', 'Call callto:eve'],
    ['whatsapp', 'whatsapp:send?phone=1'],
    ['tg', 'Open tg:resolve?domain=eve'],
    ['data', 'Open data:text/html,x'],
    ['javascript', 'JavaScript:alert(1)'],
    ['file', 'Open file:/etc/passwd'],
    ['sms', 'Text sms:+15550100'],
    ['sip', 'Call sip:eve'],
    ['a scheme with a full-width colon', 'Call tel：+15550100'],
  ])('a template with %s is refused, in the body and in the subject, for every kind', (_, text) => {
    for (const kind of EMAIL_TEMPLATE_KINDS) {
      expect(codes(kind, { body: `${minimalBody(kind)}\n\n${text}` })).toEqual([
        'body:reads_as_link',
      ])
      expect(codes(kind, { subject: text })).toContain('subject:reads_as_link')
    }
  })

  // What the rule lets through on purpose (ADR 0039 says each): no mail client links
  // these, and refusing them would refuse ordinary sentences.
  test.each([
    ['a time', 'It happened at 10:30 today'],
    ['a label and a colon', 'Note: your account changed'],
    ['a label that is also a scheme, with a space', 'Tel: 555 0100. Data: none. File: none'],
    ['a word that ends like a scheme', 'The hotel:lobby and metadata:none'],
    ['a domain spelled with spaces', 'Visit example . com'],
    ['a domain spelled in words', 'Visit example dot com'],
    ['a domain across a line break', 'Visit example.\ncom'],
    ['two placeholders around a full stop', '{{appName}}.{{appName}}'],
    ['three numbers and dots', 'Version 1.2.3 is out'],
    ['an abbreviation', 'e.g. the U.S. office, 3.5 times'],
  ])('%s is not a link', (_, text) => {
    for (const kind of EMAIL_TEMPLATE_KINDS) {
      expect(codes(kind, { body: `${minimalBody(kind)}\n\n${text}` })).toEqual([])
    }
  })

  test('a provider’s name after the app’s, around a full stop, is not a host', () => {
    expect(codes('identity_linked', { body: '{{appName}}.{{provider}}' })).toEqual([])
  })

  test('ordinary sentences are not links', () => {
    for (const text of [
      'Your password was changed. If this was you, there is nothing to do.',
      'It happened at {{time}}, e.g. after a reset. Version 3.5 applies.',
      'Wait... then sign in. Ask the U.S. office.',
      'The {{appName}} team',
    ]) {
      expect(readsAsLink(text.replaceAll(/\{\{\w+\}\}/g, 'x'))).toBe(false)
      expect(codes('password_changed', { body: text })).toEqual([])
    }
  })

  // One rule for every kind: the only link in any email is the server's own `{{link}}`.
  test.each(CODES)('%s, which carries a code, can hold no link either', (kind) => {
    for (const text of [
      'Help: https://acme.test/help',
      'See www.acme.test',
      'See acme.test/help',
      'Write to help@acme.test',
    ]) {
      expect(codes(kind, { body: `${minimalBody(kind)}\n\n${text}` })).toEqual([
        'body:reads_as_link',
      ])
      expect(codes(kind, { subject: `{{code}} ${text}` })).toEqual(['subject:reads_as_link'])
    }
    expect(codes(kind, { subject: '{{code}} for {{appName}}', body: minimalBody(kind) })).toEqual(
      []
    )
  })

  test('the placeholders whose value always starts with a digit are listed, and are placeholders', () => {
    expect([...EMAIL_TEMPLATE_DIGIT_PLACEHOLDERS].sort()).toEqual([
      'backupCodesLeft',
      'code',
      'expiresInMinutes',
      'time',
    ])
    for (const name of EMAIL_TEMPLATE_DIGIT_PLACEHOLDERS) {
      expect(EMAIL_TEMPLATE_PLACEHOLDERS).toContain(name)
    }
  })

  // Saved, such a subject would be replaced by the built-in one at every send, silently.
  test.each<[EmailTemplateKind, string]>([
    ['password_changed', '{{time}}: your password changed'],
    ['new_sign_in', '  {{time}} new sign-in'],
    ['backup_code_used', '{{backupCodesLeft}} backup codes left'],
    ['backup_code_used', '\u{200D}{{backupCodesLeft}} left'],
  ])(
    'a %s subject that starts with a placeholder that is always a number is refused: %j',
    (kind, subject) => {
      expect(codes(kind, { subject })).toEqual(['subject:leading_digit'])
    }
  )

  test('a notice subject that starts with a name, or has a number later, is accepted', () => {
    expect(codes('new_sign_in', { subject: '{{appName}}: {{device}} at {{time}}' })).toEqual([])
    expect(codes('identity_linked', { subject: '{{provider}} connected at {{time}}' })).toEqual([])
    expect(codes('backup_code_used', { subject: 'You have {{backupCodesLeft}} left' })).toEqual([])
  })

  test.each<[string, string]>([
    ['a zero-width joiner', '\u{200D}'],
    ['a word joiner', '\u{2060}'],
    ['a soft hyphen', '\u{00AD}'],
    ['a zero-width space', '\u{200B}'],
    ['a variation selector', '\u{FE0F}'],
    ['a combining grapheme joiner', '\u{034F}'],
    ['a Hangul filler', '\u{3164}'],
    ['several, and a space', '\u{200D} \u{2060}\u{00AD}'],
  ])('%s in front does not hide a leading digit, and alone is empty', (_, invisible) => {
    expect(codes('password_changed', { subject: `${invisible}123456 changed` })).toEqual([
      'subject:leading_digit',
    ])
    expect(codes('password_changed', { subject: `${invisible}Changed 1 time` })).toEqual([])
    expect(
      codes('password_changed', { subject: invisible, body: `${invisible}\n\n ${invisible}` })
    ).toEqual(['subject:empty', 'body:empty'])
    expect(codes('step_up', { subject: invisible })).toEqual(['subject:empty'])
  })

  test('a notice’s subject does not start with a digit', () => {
    for (const kind of NOTICES) {
      expect(codes(kind, { subject: '123456 is your code' })).toEqual(['subject:leading_digit'])
      expect(codes(kind, { subject: '  ٣ things changed' })).toEqual(['subject:leading_digit'])
      expect(codes(kind, { subject: 'Your account changed 3 times' })).toEqual([])
    }
    // A code message's subject leads with its code today.
    expect(codes('sign_in', { subject: '{{code}} is your code' })).toEqual([])
    expect(codes('sign_in', { subject: '1 code for you' })).toEqual([])
  })

  test('the caps, one over', () => {
    const subject = 'a'.repeat(MAX_EMAIL_SUBJECT_LENGTH)
    const body = `{{code}}${'a'.repeat(MAX_EMAIL_BODY_LENGTH - '{{code}}'.length)}`
    expect(emailTemplateProblems('step_up', { subject, body })).toEqual([])
    expect(codes('step_up', { subject: `${subject}a` })).toEqual(['subject:too_long'])
    expect(codes('step_up', { body: `${body}a` })).toEqual(['body:too_long'])
  })

  test('empty and white space are refused', () => {
    expect(codes('account_exists', { subject: '', body: ' \n\n ' })).toEqual([
      'subject:empty',
      'body:empty',
    ])
  })

  test.each([
    ['a line feed', 'Hello\nBcc: eve@evil.test'],
    ['a carriage return', 'Hello\rBcc: eve@evil.test'],
    ['CRLF', 'Hello\r\nBcc: eve@evil.test'],
    ['a line separator', 'Hello\u{2028}Bcc'],
    ['a paragraph separator', 'Hello\u{2029}Bcc'],
    ['a NUL', 'Hello\u{0}'],
    ['an escape', 'Hello\u{1b}[2J'],
    ['a tab', 'Hello\tthere'],
  ])('a subject with %s is refused', (_, subject) => {
    expect(codes('email_verification', { subject })).toEqual(['subject:control_character'])
  })

  test('a body keeps its line feeds and refuses every other control character', () => {
    expect(codes('step_up', { body: 'One\n\n{{code}}\nthree' })).toEqual([])
    for (const bad of ['\r\n', '\u{0}', '\u{1b}', '\u{2028}', '\u{2029}', '\t', '\u{85}']) {
      expect(codes('step_up', { body: `{{code}}${bad}more` })).toEqual(['body:control_character'])
    }
  })

  // Refused, not stripped: what is sent is what was saved, so what cannot be seen and
  // changes what is seen has to be turned away while someone can still be told.
  test.each<[string, string]>([
    ['a left-to-right embedding', '\u{202A}'],
    ['a right-to-left embedding', '\u{202B}'],
    ['a pop directional formatting', '\u{202C}'],
    ['a left-to-right override', '\u{202D}'],
    ['a right-to-left override', '\u{202E}'],
    ['a left-to-right isolate', '\u{2066}'],
    ['a right-to-left isolate', '\u{2067}'],
    ['a first-strong isolate', '\u{2068}'],
    ['a pop directional isolate', '\u{2069}'],
    ['a left-to-right mark', '\u{200E}'],
    ['a right-to-left mark', '\u{200F}'],
    ['an Arabic letter mark', '\u{061C}'],
    ['a private-use character', '\u{E000}'],
    ['a private-use character of plane 15', '\u{F0000}'],
    ['an unassigned code point', '\u{0378}'],
    ['a noncharacter', '\u{FFFF}'],
    ['a lone high surrogate', 'a\u{D83D}b'],
    ['a lone low surrogate', 'a\u{DC00}b'],
  ])('%s is refused in a subject and in a body', (_, bad) => {
    expect(codes('step_up', { subject: `Code ${bad}{{code}}` })).toEqual([
      'subject:hidden_character',
    ])
    expect(codes('step_up', { body: `{{code}} ${bad}more` })).toEqual(['body:hidden_character'])
    expect(codes('password_changed', { body: `Changed${bad}.` })).toEqual(['body:hidden_character'])
  })

  test('the reason for a hidden character is fixed words, with none of the text', () => {
    const [problem] = emailTemplateProblems('step_up', { body: 'secret-wording \u{202E}{{code}}' })
    expect(problem).toEqual({
      field: 'body',
      code: 'hidden_character',
      message:
        'must not contain text-direction controls, private-use or unassigned characters, or half a surrogate pair',
    })
  })

  test.each<[string, string]>([
    ['a zero-width non-joiner (Persian)', 'می\u{200C}خواهم'],
    ['a zero-width joiner (an emoji sequence)', '👩\u{200D}💻'],
    ['a zero-width joiner (Devanagari)', 'क\u{094D}\u{200D}ष'],
    ['a variation selector', '\u{2764}\u{FE0F}'],
    ['a character outside the basic plane', '😀 𝒳'],
    ['right-to-left text with no control', 'رمز شما'],
  ])('%s is accepted', (_, good) => {
    expect(codes('step_up', { subject: `${good} {{code}}`, body: `${good} {{code}}` })).toEqual([])
    expect(codes('password_changed', { subject: good, body: good })).toEqual([])
  })

  test.each([
    'exam\u{200D}ple.com',
    'exam\u{200C}ple.com',
    'example\u{200D}.\u{200C}com',
    'ht\u{200D}tps:/\u{200C}/x',
    'w\u{200D}ww.example',
    'example.c\u{FE0F}om',
  ])('a joiner does not hide a link in a notice: %j', (text) => {
    expect(readsAsLink(text)).toBe(true)
    expect(codes('password_changed', { body: `See ${text} now` })).toEqual(['body:reads_as_link'])
  })

  test('malformed braces are refused, not passed through', () => {
    expect(codes('step_up', { subject: 'Hi {code}', body: '{{code}} and {{ appName }}' })).toEqual([
      'subject:malformed_braces',
      'body:malformed_braces',
    ])
  })

  test('no message repeats the template’s own text', () => {
    const canary = 'canary-wording-7c1f'
    const problems = [
      ...emailTemplateProblems('password_changed', {
        subject: `1 ${canary} https://x.test {bad`,
        body: `${canary} {{nope}} www.x.test`,
      }),
      ...emailTemplateProblems('sign_in', { body: `${canary}` }),
    ]
    expect(problems.length).toBeGreaterThan(2)
    expect(JSON.stringify(problems)).not.toContain(canary)
  })
})

describe('EmailTemplatesSchema', () => {
  const issues = (input: unknown) => {
    const result = EmailTemplatesSchema.safeParse(input)
    return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'))
  }

  test('nothing saved is the default, in the settings document too', () => {
    expect(EmailSettingsSchema.parse({})).toEqual({ templates: {} })
    expect(DEFAULT_ENVIRONMENT_SETTINGS.emails).toEqual({ templates: {} })
    expect(EnvironmentSettingsInputSchema.parse({}).emails).toEqual({ templates: {} })
  })

  test('keeps a valid template as written', () => {
    const templates = {
      sign_in: { subject: 'Sign in to {{appName}}', body: 'Code: {{code}}\n\nOr: {{link}}' },
      password_changed: { body: 'Your {{appName}} password changed at {{time}}.' },
    }
    expect(EmailTemplatesSchema.parse(templates)).toEqual(templates)
  })

  test('a problem is reported at the kind and the field', () => {
    expect(issues({ sign_in: { body: 'no placeholders' } })).toEqual([
      'sign_in.body',
      'sign_in.body',
    ])
    expect(issues({ new_sign_in: { subject: 'See https://x.test', body: 'Fine.' } })).toEqual([
      'new_sign_in.subject',
    ])
    const result = EnvironmentSettingsInputSchema.safeParse({
      emails: { templates: { step_up: { body: 'Hello {{device}}' } } },
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => [issue.path.join('.'), issue.message])).toEqual([
      ['emails.templates.step_up.body', '{{device}} is not a placeholder of this message'],
      ['emails.templates.step_up.body', 'the body must contain {{code}}'],
    ])
  })

  test('an unknown kind, an unknown field and an empty template are refused', () => {
    expect(EmailTemplatesSchema.safeParse({ sms_code: { body: 'x' } }).success).toBe(false)
    expect(
      EmailTemplatesSchema.safeParse({ step_up: { body: '{{code}}', html: '<b>' } }).success
    ).toBe(false)
    expect(EmailTemplatesSchema.safeParse({ step_up: {} }).success).toBe(false)
    expect(EmailSettingsSchema.safeParse({ templates: {}, layout: 'x' }).success).toBe(false)
    expect(EnvironmentSettingsSchema.safeParse({ emails: { template: {} } }).success).toBe(false)
  })

  test('the templates together are capped in bytes, whatever the script', () => {
    // Three bytes a character: a body at its cap is 6,000 bytes, and seven of them are over.
    const body = (extra: string) => `{{code}}${'字'.repeat(MAX_EMAIL_BODY_LENGTH - 8)}${extra}`
    const notice = '字'.repeat(MAX_EMAIL_BODY_LENGTH)
    const six = Object.fromEntries(NOTICES.slice(0, 6).map((kind) => [kind, { body: notice }]))
    expect(emailTemplatesBytes(six)).toBeLessThanOrEqual(MAX_EMAIL_TEMPLATES_BYTES)
    expect(issues(six)).toEqual([])
    const seven = { ...six, step_up: { body: body('') } }
    expect(emailTemplatesBytes(seven)).toBeGreaterThan(MAX_EMAIL_TEMPLATES_BYTES)
    expect(issues(seven)).toEqual([''])
  })
})

describe('reading stored templates', () => {
  test('keeps what passes and names what does not', () => {
    const good = { subject: 'Hi from {{appName}}', body: '{{code}}' }
    expect(
      readStoredEmailTemplates({
        step_up: good,
        // A placeholder a later version might have had.
        password_reset: { body: '{{code}} for {{firstName}}' },
        sign_in: { body: 'code {{code}}' },
        new_sign_in: { subject: 'See https://x.test' },
        account_exists: 'text',
        no_account: { subject: 7 },
        mfa_enabled: {},
        later_kind: { body: 'x' },
        constructor: { body: 'x' },
      })
    ).toEqual({
      templates: { step_up: good },
      dropped: [
        'password_reset',
        'sign_in',
        'account_exists',
        'no_account',
        'new_sign_in',
        'mfa_enabled',
      ],
      unknown: 2,
    })
  })

  test('unknown fields of a stored template are dropped, not kept', () => {
    expect(readStoredEmailTemplates({ step_up: { body: '{{code}}', html: '<b>' } })).toEqual({
      templates: { step_up: { body: '{{code}}' } },
      dropped: [],
      unknown: 0,
    })
  })

  // The subject and the body are judged apart, as they are at a send: one that still
  // passes is not lost because the other does not.
  test('a stored subject survives a body that no longer passes, and the reverse', () => {
    expect(
      readStoredEmailTemplates({
        step_up: { subject: 'Confirm: {{code}}', body: 'no code here' },
        password_changed: { subject: '123 changes', body: 'Your password changed.' },
        sign_in: { subject: 7, body: '{{code}}\n\n{{link}}' },
        new_sign_in: { subject: 'See https://x.test', body: 'See https://x.test' },
      })
    ).toEqual({
      templates: {
        step_up: { subject: 'Confirm: {{code}}' },
        password_changed: { body: 'Your password changed.' },
        sign_in: { body: '{{code}}\n\n{{link}}' },
      },
      dropped: ['sign_in', 'step_up', 'password_changed', 'new_sign_in'],
      unknown: 0,
    })
  })

  test('something that is not a map reads as none', () => {
    expect(readStoredEmailTemplates(undefined)).toEqual({ templates: {}, dropped: [], unknown: 0 })
    expect(readStoredEmailTemplates(null)).toEqual({ templates: {}, dropped: [], unknown: 0 })
    expect(readStoredEmailTemplates(['x']).unknown).toBe(1)
    expect(readStoredEmailTemplates('x').unknown).toBe(1)
  })

  test('templates over the byte cap are dropped together', () => {
    const notice = '字'.repeat(MAX_EMAIL_BODY_LENGTH)
    const stored = Object.fromEntries(NOTICES.slice(0, 8).map((kind) => [kind, { body: notice }]))
    const read = readStoredEmailTemplates(stored)
    expect(read.templates).toEqual({})
    expect(read.dropped).toEqual(NOTICES.slice(0, 8))
  })

  test('a stored document never fails for its templates, and what it returns is saveable', () => {
    const read = readStoredEnvironmentSettings({
      app: { name: 'Acme' },
      emails: {
        layout: 'later',
        templates: {
          step_up: { body: '{{code}}' },
          sign_in: { body: 'no link {{code}}' },
          later_kind: { body: 'x' },
        },
      },
    })
    expect(read.settings.emails).toEqual({ templates: { step_up: { body: '{{code}}' } } })
    expect(read.droppedEmailTemplates).toEqual(['sign_in'])
    expect(read.unknownEmailTemplates).toBe(1)
    expect(EnvironmentSettingsSchema.safeParse(read.settings).success).toBe(true)
    for (const emails of [null, 'x', 7, [], { templates: null }, { templates: 'x' }]) {
      expect(readStoredEnvironmentSettings({ emails }).settings.emails).toEqual({ templates: {} })
    }
  })
})

// Review round 2.
describe('a combining mark does not hide a domain', () => {
  // Written as escapes: a mark in source is invisible in a diff.
  test.each<[string, string]>([
    ['a mark on the label’s last letter', 'example\u{0338}.com'],
    ['a mark that does not compose, inside the last part', 'example.co\u{0338}m'],
    ['a mark that composes, inside the last part', 'example.co\u{0301}m'],
    ['marks on both sides', 'example\u{0338}\u{0338}.c\u{0338}o\u{0338}m'],
    ['a mark inside www', 'w\u{0338}ww\u{0338}.example'],
    ['one letter and a mark after the dot', 'example.c\u{0338}'],
  ])('%s still reads as a link', (_, text) => {
    expect(readsAsLink(`Visit ${text} today`)).toBe(true)
    for (const kind of EMAIL_TEMPLATE_KINDS) {
      const required = EMAIL_TEMPLATE_RULES[kind].required.map((name) => `{{${name}}}`).join('\n\n')
      const body = required === '' ? text : `${required}\n\n${text}`
      expect(emailTemplateProblems(kind, { body }).map((problem) => problem.code)).toEqual([
        'reads_as_link',
      ])
    }
  })

  test.each([
    'Dr. Smith will call',
    'e.g. tomorrow',
    'At 10 a.m. sharp',
    'Version 1.2.3 is out',
    'Ask Dr\u{0338}. Smith',
    'Cafe\u{0301}. Then home',
  ])('%s is still not a link', (text) => {
    expect(readsAsLink(text)).toBe(false)
  })

  // Each start can be followed by at most one run of marks, so the scan stays linear.
  test.each<[string, string]>([
    ['letter, mark, dot', 'a\u{0338}.'.repeat(2000)],
    ['letter, mark', 'a\u{0338}'.repeat(2000)],
    ['one letter and marks only', `a${'\u{0338}'.repeat(4000)}`],
    ['letter, marks, dot, digit', `${'a\u{0338}\u{0338}.1'.repeat(1500)}`],
    ['w and marks', 'w\u{0338}'.repeat(3000)],
  ])('work is bounded for %s', (_, text) => {
    const started = performance.now()
    readsAsLink(text)
    expect(performance.now() - started).toBeLessThan(250)
  })
})

describe('reading stored templates over the cap', () => {
  test('a kind that lost a part in a section also over the cap is named once', () => {
    const notice = '字'.repeat(MAX_EMAIL_BODY_LENGTH)
    const stored: Record<string, unknown> = Object.fromEntries(
      NOTICES.slice(0, 8).map((kind) => [kind, { body: notice }])
    )
    const first = NOTICES[0] as EmailTemplateKind
    // Its subject no longer passes; its body does, and with the rest is over the cap.
    stored[first] = { subject: 'See https://x.test', body: notice }
    const read = readStoredEmailTemplates(stored)
    expect(read.templates).toEqual({})
    expect(read.dropped.filter((kind) => kind === first)).toEqual([first])
    expect(read.dropped).toEqual(NOTICES.slice(0, 8))
    expect(new Set(read.dropped).size).toBe(read.dropped.length)
  })
})
