import { describe, expect, test } from 'bun:test'
import {
  EnvironmentSettingsInputSchema,
  readStoredEnvironmentSettings,
} from './environment-settings'
import {
  isSmsTemplateKind,
  MAX_SMS_TEMPLATE_LENGTH,
  readStoredSmsTemplates,
  SMS_TEMPLATE_KINDS,
  SMS_TEMPLATE_PLACEHOLDERS,
  SMS_TEMPLATE_RULES,
  type SmsTemplateProblemCode,
  smsSegments,
  smsTemplateProblems,
} from './sms-template'
import { SmsTemplatesSchema } from './sms-template-schema'

const codes = (text: string) =>
  smsTemplateProblems('sign_in', { text }).map((problem) => problem.code)

describe('the kinds and their rules', () => {
  test('every kind has rules, needs the code and may name the app', () => {
    expect(Object.keys(SMS_TEMPLATE_RULES).sort()).toEqual([...SMS_TEMPLATE_KINDS].sort())
    for (const kind of SMS_TEMPLATE_KINDS) {
      expect(SMS_TEMPLATE_RULES[kind]).toEqual({ required: ['code'], optional: ['appName'] })
    }
  })

  test('no placeholder is a number other than the code, an address or a host', () => {
    expect([...SMS_TEMPLATE_PLACEHOLDERS]).toEqual(['appName', 'code'])
  })

  test('isSmsTemplateKind knows the list and nothing inherited', () => {
    expect(isSmsTemplateKind('sign_in')).toBe(true)
    expect(isSmsTemplateKind('constructor')).toBe(false)
    expect(isSmsTemplateKind('email_verification')).toBe(false)
  })
})

describe('what a template may say', () => {
  test.each([
    ['the built-in sentence', 'Your {{appName}} verification code is {{code}}.'],
    ['without the app', 'Your sign-in code is {{code}}. Do not share it.'],
    ['the code in brackets', 'Sign-in code ({{code}}) for {{appName}}.'],
    ['the app possessive', 'Use {{code}} as {{appName}}’s code.'],
    ['another script', 'Ihr Code für {{appName}} lautet: {{code}}'],
    ['Japanese', 'あなたの確認コードは {{code}} です。'],
    ['a short number', 'Your code is {{code}}. It works for 10 minutes.'],
    ['a time of day and a label', 'Note: {{code}} is your code until 10:30.'],
    ['an @ and a # inside a word', 'Team C#fans and a@b say: {{code}}'],
    ['a zero-width non-joiner in Persian', 'کد شما می\u{200C}باشد: {{code}}'],
    ['exactly the longest', `A${'a'.repeat(MAX_SMS_TEMPLATE_LENGTH - 10)} {{code}}`],
  ])('accepts %s', (_name, text) => {
    expect(smsTemplateProblems('sign_in', { text })).toEqual([])
  })

  test.each<[string, string, SmsTemplateProblemCode]>([
    ['no code at all', 'Your sign-in code is on its way.', 'missing_placeholder'],
    ['the code twice', 'Code {{code}}, again: {{code}}.', 'repeated_placeholder'],
    ['the app twice', 'From {{appName}}: {{code}} for {{appName}}.', 'repeated_placeholder'],
    ['an unknown placeholder', 'Hi {{name}}, your code is {{code}}.', 'unknown_placeholder'],
    [
      'an email placeholder',
      'Code {{code}}, valid {{expiresInMinutes}} min.',
      'unknown_placeholder',
    ],
    ['a host placeholder', 'Code {{code}} for {{host}}.', 'unknown_placeholder'],
    ['a lone brace', 'Your code is {{code}}. {', 'malformed_braces'],
    ['a space inside the braces', 'Your code is {{ code }}.', 'malformed_braces'],
    ['a joiner inside the braces', 'Your code is {{co\u{200D}de}}.', 'malformed_braces'],
    ['a joiner between the braces', 'Your code is {\u{200D}{code}}.', 'malformed_braces'],
    ['a letter before the code', 'Your code is no{{code}}.', 'placeholder_touches_text'],
    ['a digit after the code', 'Your code is {{code}}7.', 'placeholder_touches_text'],
    ['a digit before the code', 'Your code is 7{{code}}.', 'placeholder_touches_text'],
    [
      'a hidden digit after the code',
      'Your code is {{code}}\u{200D}7.',
      'placeholder_touches_text',
    ],
    ['the app against the code', 'Your code is {{appName}}{{code}}.', 'placeholder_touches_text'],
    [
      'a joiner between two placeholders',
      'Code: {{appName}}\u{200D}{{code}}',
      'placeholder_touches_text',
    ],
    ['a digit against the app', 'Your {{appName}}2 code is {{code}}.', 'placeholder_touches_text'],
    // A combining mark draws on what stands before it: after the code it is an accent on the
    // code's last digit. Refused on either side, for both placeholders.
    ['a combining mark after the code', 'Code {{code}}\u{301} ok', 'placeholder_touches_text'],
    ['a combining mark before the code', 'Code \u{301}{{code}} ok', 'placeholder_touches_text'],
    [
      'a combining mark after the app',
      'For {{appName}}\u{301} use {{code}}',
      'placeholder_touches_text',
    ],
    ['an enclosing mark after the code', 'Code {{code}}\u{20DD} ok', 'placeholder_touches_text'],
    [
      'a mark behind a joiner after the code',
      'Code {{code}}\u{200D}\u{301} ok',
      'placeholder_touches_text',
    ],
    [
      'a mark behind a variation selector after the code',
      'Code {{code}}\u{FE0F}\u{301} ok',
      'placeholder_touches_text',
    ],
    [
      'a letter behind a variation selector after the code',
      'Code {{code}}\u{FE0F}x ok',
      'placeholder_touches_text',
    ],
    [
      'a letter behind a non-joiner before the code',
      'Code x\u{200C}{{code}} ok',
      'placeholder_touches_text',
    ],
    [
      'a digit behind a variation selector before the app',
      'For 7\u{FE0E}{{appName}} use {{code}}',
      'placeholder_touches_text',
    ],
    ['four digits in a row', 'Call 5550 if {{code}} was not asked for.', 'digit_run'],
    ['six digits that read as a code', 'Not 123456 but {{code}}.', 'digit_run'],
    ['digits split by a joiner', 'Not 12\u{200D}34 but {{code}}.', 'digit_run'],
    ['Arabic-Indic digits', 'Not ١٢٣٤ but {{code}}.', 'digit_run'],
    ['full-width digits', 'Not １２３４ but {{code}}.', 'digit_run'],
    ['a second code line', 'Your code is {{code}}. @evil #x', 'imitates_code_line'],
    ['a word that starts with @', 'Ask @support about {{code}}.', 'imitates_code_line'],
    ['a word that starts with #', 'Your code: #{{code}}', 'imitates_code_line'],
    ['a # after punctuation', 'Your code (#{{code}}) is here.', 'imitates_code_line'],
    ['a full-width @', 'Ask ＠support about {{code}}.', 'imitates_code_line'],
    ['a line break', 'Your code is {{code}}.\nBye', 'control_character'],
    ['a carriage return', 'Your code is {{code}}.\rBye', 'control_character'],
    ['a line separator', 'Your code is {{code}}.\u{2028}Bye', 'control_character'],
    ['a tab', 'Your code is\t{{code}}.', 'control_character'],
    ['a right-to-left override', 'Your code is \u{202E}{{code}}.', 'hidden_character'],
    ['a private-use character', 'Your code is {{code}}.\u{E000}', 'hidden_character'],
    ['a lone surrogate', 'Your code is {{code}}.\u{D800}', 'hidden_character'],
    ['a link', 'Your code is {{code}}. See https://x.test', 'reads_as_link'],
    ['a bare domain', 'Your code is {{code}}. Visit example.com', 'reads_as_link'],
    ['no space after a full stop', 'Your code is {{code}}.Bye', 'reads_as_link'],
    ['a tel: scheme', 'Your code is {{code}}. tel:555', 'reads_as_link'],
    ['the code first', '{{code}} is your sign-in code.', 'leading_non_letter'],
    ['the app first', '{{appName}}: your code is {{code}}.', 'leading_non_letter'],
    ['a digit first', '1 code for you: {{code}}', 'leading_non_letter'],
    ['a space first', ' Your code is {{code}}.', 'leading_non_letter'],
    ['punctuation first', '[Acme] Your code is {{code}}.', 'leading_non_letter'],
    ['a joiner then a digit first', '\u{200D}1 code: {{code}}', 'leading_non_letter'],
    ['nothing', '', 'empty'],
    ['only spaces', '   ', 'empty'],
    ['only what draws nothing', '\u{200D}\u{200C}', 'empty'],
    ['one over the longest', `A${'a'.repeat(MAX_SMS_TEMPLATE_LENGTH - 9)} {{code}}`, 'too_long'],
  ])('refuses %s', (_name, text, code) => {
    expect(codes(text)).toContain(code)
  })

  test('a problem names a placeholder at most, never the text', () => {
    const canary = 'Wording-canary-5f2c'
    const problems = SMS_TEMPLATE_KINDS.flatMap((kind) =>
      smsTemplateProblems(kind, { text: `${canary} {{nope}} 12345 @x https://x.test {` })
    ).concat(smsTemplateProblems('sign_in', { text: `${canary} {{nope}} 12345 @x https://x.test` }))
    expect(problems.length).toBeGreaterThan(3)
    expect(JSON.stringify(problems)).not.toContain(canary)
    expect(problems.find((problem) => problem.code === 'unknown_placeholder')?.placeholder).toBe(
      'nope'
    )
  })

  test('a long unknown name is cut where it is said back', () => {
    // Under the length cap: a name of 60 letters in a template of 140.
    const [problem] = smsTemplateProblems('sign_in', {
      text: `Code {{code}} {{${'n'.repeat(60)}}}`,
    })
    expect(problem?.placeholder).toBe(`${'n'.repeat(40)}…`)
  })

  test.each([
    ['digits', '1'.repeat(MAX_SMS_TEMPLATE_LENGTH)],
    ['marks', `a${'\u{0338}'.repeat(MAX_SMS_TEMPLATE_LENGTH - 1)}`],
    ['at signs', '@ '.repeat(MAX_SMS_TEMPLATE_LENGTH / 2)],
    ['open braces', '{'.repeat(MAX_SMS_TEMPLATE_LENGTH)],
    ['w and dots', 'w.'.repeat(MAX_SMS_TEMPLATE_LENGTH / 2)],
    ['a megabyte, refused for its length before any pattern runs', '1@#{w.'.repeat(200_000)],
  ])('work is bounded for %s', (_name, text) => {
    const started = performance.now()
    smsTemplateProblems('sign_in', { text })
    expect(performance.now() - started).toBeLessThan(250)
  })
})

describe('the settings schema', () => {
  test('reports a refused template under sms.templates.<kind>.text', () => {
    const result = EnvironmentSettingsInputSchema.safeParse({
      sms: { templates: { sign_in: { text: 'No code.' } } },
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual([
      'sms.templates.sign_in.text',
    ])
  })

  test.each([
    ['a kind nobody knows', { welcome: { text: 'Your code is {{code}}.' } }],
    ['a key beside the text', { sign_in: { text: 'Your code is {{code}}.', lastLine: '@x #1' } }],
    ['a template with no text', { sign_in: {} }],
    ['a text that is no string', { sign_in: { text: 7 } }],
  ])('refuses %s', (_name, templates) => {
    expect(SmsTemplatesSchema.safeParse(templates).success).toBe(false)
  })

  test('no template is the default, and a saved one is kept as written', () => {
    expect(EnvironmentSettingsInputSchema.parse({}).sms.templates).toEqual({})
    const text = 'Your {{appName}} sign-in code is {{code}}.'
    expect(
      EnvironmentSettingsInputSchema.parse({ sms: { templates: { sign_in: { text } } } }).sms
        .templates
    ).toEqual({ sign_in: { text } })
  })
})

describe('reading stored templates', () => {
  const good = { text: 'Your {{appName}} sign-in code is {{code}}.' }

  test('keeps what passes, drops what does not, counts what it does not know', () => {
    expect(
      readStoredSmsTemplates({
        sign_in: good,
        phone_verification: { text: 'No code here.' },
        welcome: good,
        __proto__: good,
      })
    ).toEqual({ templates: { sign_in: good }, dropped: ['phone_verification'], unknown: 1 })
  })

  test.each([
    ['nothing stored', undefined, 0],
    ['null', null, 0],
    ['a list', [good], 1],
    ['a string', 'x', 1],
  ])('%s reads as no template', (_name, stored, unknown) => {
    expect(readStoredSmsTemplates(stored)).toEqual({ templates: {}, dropped: [], unknown })
  })

  test.each([
    ['a string where a template belongs', 'Your code is {{code}}.'],
    ['a list', [good]],
    ['null', null],
    ['a text that is a number', { text: 123456 }],
  ])('%s is dropped by kind', (_name, written) => {
    expect(readStoredSmsTemplates({ sign_in: written })).toEqual({
      templates: {},
      dropped: ['sign_in'],
      unknown: 0,
    })
  })

  test('a stored document with a template that no longer passes still reads', () => {
    const read = readStoredEnvironmentSettings({
      sms: {
        enabled: true,
        allowedCountries: ['DE', 'nowhere'],
        templates: {
          sign_in: { text: 'See example.com {{code}}' },
          phone_verification: good,
          x: 1,
        },
      },
    })
    expect(read.settings.sms).toEqual({
      enabled: true,
      allowedCountries: ['DE'],
      dailyMessageLimit: 500,
      templates: { phone_verification: good },
    })
    expect(read.dropped).toBe(1)
    expect(read.droppedSmsTemplates).toEqual(['sign_in'])
    expect(read.unknownSmsTemplates).toBe(1)
  })

  test('a section that is no section is a missing one', () => {
    const read = readStoredEnvironmentSettings({ sms: 'on' })
    expect(read.settings.sms.templates).toEqual({})
    expect(read.droppedSmsTemplates).toEqual([])
  })
})

describe('smsSegments', () => {
  test.each([
    ['a short sentence', 'Your Acme verification code is 123456.', 'gsm7', 38, 1],
    ['exactly one segment', 'a'.repeat(160), 'gsm7', 160, 1],
    ['one over', 'a'.repeat(161), 'gsm7', 161, 2],
    ['two full segments', 'a'.repeat(306), 'gsm7', 306, 2],
    ['three', 'a'.repeat(307), 'gsm7', 307, 3],
    ['an extension character counts two', `${'a'.repeat(159)}€`, 'gsm7', 161, 2],
    ['the line break of the code line', 'Code 123456.\n\n@x.test #123456', 'gsm7', 29, 1],
    ['one character outside the alphabet', `${'a'.repeat(69)}ő`, 'ucs2', 70, 1],
    ['and one more', `${'a'.repeat(70)}ő`, 'ucs2', 71, 2],
    ['an emoji is two units', `${'a'.repeat(69)}😀`, 'ucs2', 71, 2],
    ['nothing', '', 'gsm7', 0, 1],
  ])('%s', (_name, text, encoding, units, segments) => {
    expect(smsSegments(text)).toEqual({ encoding, units, segments } as never)
  })

  // The cap's arithmetic, as its JSDoc states it: the longest sentence a template can
  // render to, the server's last line and the longest host.
  test('the longest template, app name and host are three GSM-7 segments, seven in UCS-2', () => {
    const sentence = MAX_SMS_TEMPLATE_LENGTH - '{{appName}}'.length + 64
    expect(sentence).toBe(193)
    const whole = sentence + '\n\n@'.length + 253 + ' #123456'.length
    expect(whole).toBe(457)
    expect(smsSegments('a'.repeat(whole)).segments).toBe(3)
    expect(smsSegments(`ő${'a'.repeat(whole - 1)}`).segments).toBe(7)
    // A host of up to 102 characters keeps it to two.
    expect(smsSegments('a'.repeat(sentence + 11 + 102)).segments).toBe(2)
  })
})
