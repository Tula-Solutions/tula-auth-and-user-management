import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WEBHOOK_REDELIVER_REFUSALS, WEBHOOK_ROTATION_REFUSALS } from '@tula/contract'
import { ApiError } from '~/api/errors'
import { deliverySearch } from './delivery-search'
import {
  answerText,
  deliveryStateLabel,
  endpointState,
  failureReasonText,
  lastResultText,
  sendResultText,
  webhookMessageFor,
} from './words'

// The sentences of the webhooks screens. The server answers with fixed words; an operator
// reads the dashboard's own text for each, never the word alone.

function refusal(code: string, reason?: unknown, status = 409): ApiError {
  return new ApiError({
    status,
    code,
    detail: 'The server’s own description.',
    params: reason === undefined ? {} : { reason },
  })
}

describe('an endpoint’s state in words', () => {
  test.each([
    [{ enabled: true, disabledReason: null, failingSince: null }, 'active', 'Active'],
    [
      { enabled: true, disabledReason: null, failingSince: '2026-10-03T08:00:00.000Z' },
      'failing',
      'Active, but failing',
    ],
    [{ enabled: false, disabledReason: null, failingSince: null }, 'off', 'Switched off'],
    [
      { enabled: false, disabledReason: 'gone', failingSince: null },
      'off-by-server',
      'Switched off by the server',
    ],
    [
      { enabled: false, disabledReason: 'failing', failingSince: '2026-10-01T08:00:00.000Z' },
      'off-by-server',
      'Switched off by the server',
    ],
  ])('%j is %s', (endpoint, kind, label) => {
    const state = endpointState(endpoint)
    expect<string>(state.kind).toBe(kind)
    expect(state.label).toBe(label)
  })

  test('each reason the server switches an endpoint off for has a fixed sentence', () => {
    const detail = (disabledReason: string) =>
      endpointState({ enabled: false, disabledReason, failingSince: null }).detail
    expect(detail('gone')).toBe(
      'It answered “410 Gone”, which means “stop”, so the server stopped sending at once. Switch it on only once the receiver takes deliveries again.'
    )
    expect(detail('failing')).toBe(
      'Requests to it failed for five days with no success among them, so the server stopped sending. Fix the receiver, send a test event, then switch it on.'
    )
    // A word a later server knows is quoted as text, after words of the dashboard's own.
    expect(detail('<b>moved</b>')).toBe(
      'The server stopped sending to it. The server’s reason: <b>moved</b>'
    )
  })
})

describe('a delivery in words', () => {
  test('a state the contract knows is a word, and another is shown as it is', () => {
    expect(['pending', 'delivered', 'failed', 'parked'].map(deliveryStateLabel)).toEqual([
      'Pending',
      'Delivered',
      'Failed',
      'parked',
    ])
  })

  test('every word the server gives for a failure has a sentence of its own', () => {
    const words = [
      'timeout',
      'connection_failed',
      'resolve_failed',
      'address_not_allowed',
      'scheme_not_allowed',
      'invalid_url',
      'invalid_request',
      'response_too_large',
      'signing_failed',
      'endpoint_unresponsive',
      'expired',
      'event_gone',
    ]
    const sentences = words.map(failureReasonText)
    expect(new Set(sentences).size).toBe(12)
    expect(sentences.filter((sentence) => sentence.startsWith('The server gave'))).toEqual([])
    expect(sentences.filter((sentence, index) => sentence.includes(words[index] ?? ''))).toEqual([])
    expect(failureReasonText('timeout')).toBe('No answer within five seconds.')
    expect(failureReasonText('expired')).toBe('Given up after three days pending.')
    expect(failureReasonText('a_later_word')).toBe('The server gave this reason: a_later_word')
  })

  test.each([
    [{ statusCode: 204, failureReason: null }, 'HTTP 204'],
    [{ statusCode: 500, failureReason: 'response_too_large' }, 'HTTP 500'],
    [{ statusCode: null, failureReason: 'timeout' }, 'No answer within five seconds.'],
    [{ statusCode: null, failureReason: null }, 'No request yet'],
  ])('the last result of %j is “%s”', (delivery, text) => {
    expect(lastResultText(delivery)).toBe(text)
  })

  test('an answer is its status code, or that there was none', () => {
    expect(answerText(410)).toBe('HTTP 410')
    expect(answerText(null)).toBe('No answer')
  })

  test.each([
    [
      { outcome: 'delivered', statusCode: 200, durationMs: 12, failureReason: null },
      'Delivered: the endpoint answered 200 in 12 ms.',
    ],
    [
      { outcome: 'failed', statusCode: 410, durationMs: 30, failureReason: null },
      'Failed: the endpoint answered 410 in 30 ms.',
    ],
    [
      { outcome: 'failed', statusCode: null, durationMs: 0, failureReason: 'signing_failed' },
      'Failed: there was no answer (0 ms). No request was made: the server could not open the endpoint’s signing secret. Check that every API instance has the same TULA_MASTER_KEY.',
    ],
    [
      { outcome: 'failed', statusCode: null, durationMs: 3, failureReason: null },
      'Failed: there was no answer (3 ms).',
    ],
  ] as const)('a request made on demand: %j', (result, text) => {
    expect(sendResultText(result)).toBe(text)
  })
})

describe('a refusal in words', () => {
  test.each([
    ['scheme_not_allowed', 'The address must start with https://.'],
    [
      'address_not_allowed',
      'The address leads to a private or local network address, which the server does not call. Use an address on the public internet.',
    ],
    ['resolve_failed', 'The host name of the address could not be resolved. Check the spelling.'],
    [
      'invalid_url',
      'That is not an address the server can call. Enter a full https:// URL with no user name or password in it.',
    ],
    ['timeout', 'Looking up the host name of the address took too long. Try again.'],
    ['a_later_word', 'The server cannot deliver to that address.'],
    [42, 'The server cannot deliver to that address.'],
    [undefined, 'The server cannot deliver to that address.'],
  ])('an address refused for %s', (reason, sentence) => {
    expect(webhookMessageFor(refusal('webhook.url_not_allowed', reason, 422), 'create')).toBe(
      sentence
    )
  })

  test('every refusal the contract lists has a sentence that is not the fallback', () => {
    const cases: [string, readonly string[], string][] = [
      [
        'webhook.cannot_redeliver',
        WEBHOOK_REDELIVER_REFUSALS,
        'This delivery cannot be sent again.',
      ],
      [
        'webhook.rotation_refused',
        WEBHOOK_ROTATION_REFUSALS,
        'The signing secret cannot be changed now.',
      ],
    ]
    for (const [code, reasons, fallback] of cases) {
      const sentences = reasons.map((reason) => webhookMessageFor(refusal(code, reason)))
      expect(sentences.filter((sentence) => sentence === fallback)).toEqual([])
      expect(new Set(sentences).size).toBe(reasons.length)
    }
  })

  test('an eleventh endpoint is a sentence only where an endpoint was being added', () => {
    const conflict = new ApiError({
      status: 409,
      code: 'resource.conflict',
      detail: 'The server’s own description.',
      params: { max: 10 },
    })
    expect(webhookMessageFor(conflict, 'create')).toBe(
      'This environment already has 10 webhook endpoints, the most one can have. Delete one first.'
    )
    expect(webhookMessageFor(conflict)).toBe('The server’s own description.')
  })

  test('the limit on requests made on demand, with and without a time to wait', () => {
    const limited = (retryAfter: number | null) =>
      new ApiError({ status: 429, code: 'rate_limited', detail: 'Too many requests.', retryAfter })
    expect(webhookMessageFor(limited(7), 'send')).toBe(
      'Test events and deliveries sent again share a limit of ten a minute for the environment. Try again in 7 seconds.'
    )
    expect(webhookMessageFor(limited(null), 'send')).toBe(
      'Test events and deliveries sent again share a limit of ten a minute for the environment. Wait a moment, then try again.'
    )
  })
})

describe('the delivery list’s filters, read from an address', () => {
  test.each([
    [{}, {}],
    [
      { state: 'failed', eventType: 'user.created', page: 3 },
      { state: 'failed', eventType: 'user.created', page: 3 },
    ],
    [{ state: 'bogus', eventType: 'invoice.paid', page: 1 }, {}],
    [{ state: ['failed'], eventType: 7, page: '2' }, { page: 2 }],
    [{ state: 'pending', other: 'x', page: -1 }, { state: 'pending' }],
  ])('%j reads as %j', (search, filters) => {
    expect<unknown>(deliverySearch(search)).toEqual(filters)
  })
})

describe('the vocabulary', () => {
  // A webhook is a notice of something that has happened; a hook is a question whose answer
  // decides what happens next (GLOSSARY.md). The screens are about the first, and say so.
  const HERE = import.meta.dir
  const ROUTES = join(
    HERE,
    '../../routes/_app/w.$workspaceId/p.$projectId/e.$environmentId/webhooks'
  )

  function sources(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        return sources(path)
      }
      return /\.tsx?$/.test(entry.name) && !entry.name.includes('.test.') ? [path] : []
    })
  }

  test('the webhooks screens never say “hook” or “callback”', () => {
    const files = [...sources(HERE), ...sources(ROUTES)]
    // Fourteen files of the feature and three routes: a walk that finds none proves nothing.
    expect(files.length).toBe(17)
    const offending = files.filter((file) =>
      /callback|(?<!web)hook/i.test(readFileSync(file, 'utf8'))
    )
    expect(offending).toEqual([])
  })
})
