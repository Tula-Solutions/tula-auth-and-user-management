import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  EMAIL_TEMPLATE_KINDS,
  MAX_EMAIL_BODY_LENGTH,
  MAX_EMAIL_SUBJECT_LENGTH,
  MAX_SMS_TEMPLATE_LENGTH,
  SMS_TEMPLATE_KINDS,
} from '@tula/contract'
import type { SettingsDocument } from '~/features/settings/model'
import {
  fieldsOf,
  hasOwnWording,
  MESSAGE_GROUPS,
  type MessageRef,
  maxLengthOf,
  messageId,
  placeholdersOf,
  previewRequest,
  problemsOf,
  segmentsSentence,
  settingsPath,
  templateOf,
  unusedSentence,
  withField,
  withoutWording,
  wordsOf,
} from './model'

const EMAIL: MessageRef = { channel: 'email', kind: 'email_verification' }
const NOTICE: MessageRef = { channel: 'email', kind: 'new_sign_in' }
const SMS: MessageRef = { channel: 'sms', kind: 'sign_in' }

function settings(): SettingsDocument {
  return structuredClone(DEFAULT_ENVIRONMENT_SETTINGS) as SettingsDocument
}

describe('the list of messages', () => {
  const all = MESSAGE_GROUPS.flatMap((group) => group.messages)

  test('every kind of the contract is in exactly one group', () => {
    expect(all.map(messageId).sort()).toEqual(
      [
        ...EMAIL_TEMPLATE_KINDS.map((kind) => `email:${kind}`),
        ...SMS_TEMPLATE_KINDS.map((kind) => `sms:${kind}`),
      ].sort()
    )
  })

  test('every message has a label of its own and a sentence of when it is sent', () => {
    const labels = all.map((message) => wordsOf(message).label)
    expect(new Set(labels).size).toBe(all.length)
    expect(all.every((message) => wordsOf(message).when.endsWith('.'))).toBe(true)
  })

  test('the groups are named, and none is empty', () => {
    expect(MESSAGE_GROUPS.map((group) => group.title)).toEqual([
      'Emails with a code',
      'Emails about an address',
      'Security notices',
      'Text messages',
    ])
    expect(MESSAGE_GROUPS.every((group) => group.messages.length > 0)).toBe(true)
  })
})

describe('what a message is made of', () => {
  test('an email has a subject and a body, a text message a text', () => {
    expect(fieldsOf(EMAIL)).toEqual(['subject', 'body'])
    expect(fieldsOf(SMS)).toEqual(['text'])
  })

  test('the caps are the contract’s', () => {
    expect(maxLengthOf('subject')).toBe(MAX_EMAIL_SUBJECT_LENGTH)
    expect(maxLengthOf('body')).toBe(MAX_EMAIL_BODY_LENGTH)
    expect(maxLengthOf('text')).toBe(MAX_SMS_TEMPLATE_LENGTH)
  })

  test('the settings path is the one the server names in a field error', () => {
    expect(settingsPath(EMAIL)).toBe('emails.templates.email_verification')
    expect(settingsPath(SMS)).toBe('sms.templates.sign_in')
  })

  test.each<[string, MessageRef, 'subject' | 'body' | 'text', [string, boolean][]]>([
    [
      'a code email’s body requires the code',
      EMAIL,
      'body',
      [
        ['code', true],
        ['appName', false],
        ['expiresInMinutes', false],
      ],
    ],
    [
      'its subject may name the code and requires nothing',
      EMAIL,
      'subject',
      [
        ['code', false],
        ['appName', false],
        ['expiresInMinutes', false],
      ],
    ],
    [
      'a sign-in email’s subject is offered no link',
      { channel: 'email', kind: 'sign_in' },
      'subject',
      [
        ['code', false],
        ['appName', false],
        ['expiresInMinutes', false],
      ],
    ],
    [
      'a notice is offered neither a code nor a link',
      NOTICE,
      'body',
      [
        ['appName', false],
        ['time', false],
        ['device', false],
      ],
    ],
    [
      'a text message requires the code',
      SMS,
      'text',
      [
        ['code', true],
        ['appName', false],
      ],
    ],
  ])('%s', (_name, message, field, expected) => {
    expect(placeholdersOf(message, field).map((choice) => [choice.name, choice.required])).toEqual(
      expected
    )
  })
})

describe('a draft’s wording', () => {
  test('a document without wording has none for any message', () => {
    const draft = settings()
    expect(templateOf(draft, EMAIL)).toEqual({})
    expect(templateOf(draft, SMS)).toEqual({})
    expect(hasOwnWording(draft, EMAIL)).toBe(false)
  })

  test('a part is written, changed and read back, and other kinds are left alone', () => {
    let draft = withField(settings(), NOTICE, 'body', 'Other')
    draft = withField(draft, EMAIL, 'subject', 'Hello')
    draft = withField(draft, EMAIL, 'body', 'Code {{code}}')
    draft = withField(draft, EMAIL, 'subject', 'Hello again')
    expect(draft.emails?.templates).toEqual({
      new_sign_in: { body: 'Other' },
      email_verification: { subject: 'Hello again', body: 'Code {{code}}' },
    })
    expect(templateOf(draft, EMAIL)).toEqual({ subject: 'Hello again', body: 'Code {{code}}' })
    expect(hasOwnWording(draft, EMAIL)).toBe(true)
  })

  test('an emptied part is left out, and a template with no part left is gone', () => {
    const original = settings()
    let draft = withField(original, EMAIL, 'subject', 'Hello')
    draft = withField(draft, EMAIL, 'body', 'Code {{code}}')
    draft = withField(draft, EMAIL, 'subject', '')
    expect(draft.emails?.templates).toEqual({ email_verification: { body: 'Code {{code}}' } })
    draft = withField(draft, EMAIL, 'body', '')
    // Byte for byte what was loaded: the editor then has nothing to save.
    expect(JSON.stringify(draft)).toBe(JSON.stringify(original))
  })

  test('a text message’s wording is its text, beside the other sms settings', () => {
    const original = settings()
    const draft = withField(original, SMS, 'text', 'Use {{code}}')
    expect(draft.sms).toEqual({ ...original.sms, templates: { sign_in: { text: 'Use {{code}}' } } })
    expect(JSON.stringify(withField(draft, SMS, 'text', ''))).toBe(JSON.stringify(original))
  })

  test('resetting takes the whole template out and nothing else', () => {
    const original = settings()
    let draft = withField(original, EMAIL, 'subject', 'Hello')
    draft = withField(draft, SMS, 'text', 'Use {{code}}')
    draft = withoutWording(draft, EMAIL)
    expect(draft.emails?.templates).toEqual({})
    expect(templateOf(draft, SMS)).toEqual({ text: 'Use {{code}}' })
    expect(JSON.stringify(withoutWording(draft, SMS))).toBe(JSON.stringify(original))
  })

  test('a draft with no sms section keeps no text message wording', () => {
    const { sms: _sms, ...draft } = settings()
    expect(withField(draft, SMS, 'text', 'Use {{code}}')).toBe(draft)
  })

  test('the draft that was given is never changed', () => {
    const draft = settings()
    const before = JSON.stringify(draft)
    withField(draft, EMAIL, 'subject', 'Hello')
    withField(draft, SMS, 'text', 'Use {{code}}')
    expect(JSON.stringify(draft)).toBe(before)
  })
})

describe('why a wording would be refused', () => {
  test('no wording has no problem', () => {
    expect(problemsOf(EMAIL, {})).toEqual({})
    expect(problemsOf(SMS, {})).toEqual({})
  })

  test('the reasons are the contract’s, by part', () => {
    expect(problemsOf(EMAIL, { subject: 'Fine', body: 'No code' })).toEqual({
      body: ['the body must contain {{code}}'],
    })
    expect(problemsOf(EMAIL, { subject: 'A\nB', body: 'Code {{code}}' })).toEqual({
      subject: ['must not contain control characters or line breaks'],
    })
    expect(problemsOf(NOTICE, { body: 'Enter {{code}}' }).body?.[0]).toContain('{{code}}')
    expect(problemsOf(SMS, { text: 'Welcome.' })).toEqual({
      text: ['the text must contain {{code}}'],
    })
    expect(problemsOf(SMS, { text: 'Use {{code}}' })).toEqual({})
  })
})

describe('what the preview is asked', () => {
  test('no wording asks for the built-in text', () => {
    expect(previewRequest(EMAIL, {})).toEqual({ channel: 'email', kind: 'email_verification' })
    expect(previewRequest(SMS, {})).toEqual({ channel: 'sms', kind: 'sign_in' })
  })

  test('only the parts the draft has are sent', () => {
    expect(previewRequest(EMAIL, { subject: 'Hello' })).toEqual({
      channel: 'email',
      kind: 'email_verification',
      template: { subject: 'Hello' },
    })
    expect(previewRequest(SMS, { text: 'Use {{code}}' })).toEqual({
      channel: 'sms',
      kind: 'sign_in',
      template: { text: 'Use {{code}}' },
    })
  })
})

describe('the preview’s words', () => {
  test.each([
    [
      { part: 'subject', reason: 'leading_digit' },
      'The subject would start with a digit once its values are filled in, so the built-in subject is sent instead.',
    ],
    [
      { part: 'body', reason: 'invalid' },
      'The body does not pass the rules for this message, so the built-in body is sent instead.',
    ],
    [
      { part: 'body', reason: 'missing_value' },
      'The body names a value this message does not have, so the built-in body is sent instead.',
    ],
    [
      { part: 'subject', reason: 'empty' },
      'The subject would be empty once its values are filled in, so the built-in subject is sent instead.',
    ],
    [
      { part: 'subject', reason: 'too_long' },
      'The subject would be too long once its values are filled in, so the built-in subject is sent instead.',
    ],
  ] as const)('%j', (unused, sentence) => {
    expect(unusedSentence(unused)).toBe(sentence)
  })

  test('the size of a text message, and none for an email', () => {
    expect(segmentsSentence(null)).toBeNull()
    expect(segmentsSentence({ encoding: 'gsm7', units: 71, segments: 1 })).toBe(
      'Sent as 1 text message: 71 characters of the GSM alphabet.'
    )
    expect(segmentsSentence({ encoding: 'ucs2', units: 80, segments: 2 })).toBe(
      'Sent as 2 text messages: 80 characters as Unicode, which fits fewer in a message.'
    )
  })
})
