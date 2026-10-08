import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_PAGE_SIZE,
  WEBHOOK_REDELIVER_REFUSALS,
  WEBHOOK_ROTATION_REFUSALS,
} from '@tula/contract'
import { ACTIVITY_TYPES } from '@tula/contract/event-types'
import { ApiError } from '~/api/errors'
import { entryImports } from '~/testing/entry-imports'
import {
  DELIVERY_LIST_WINDOW,
  DELIVERY_PAGE_SIZE,
  deliverySearch,
  LAST_DELIVERY_PAGE,
} from './delivery-search'
import { eventTypeNote, NOTED_EVENT_TYPES } from './event-type-notes'
import {
  answerText,
  deliveryStateLabel,
  endpointState,
  failureReasonText,
  isNotFound,
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

  // A reason is a word the server chose, looked up in a table. A word that names something
  // every object has must not find it: the answer is then a function or an object, not a
  // sentence.
  describe.each([
    ['webhook.url_not_allowed', 'The server cannot deliver to that address.'],
    ['webhook.cannot_redeliver', 'This delivery cannot be sent again.'],
    ['webhook.rotation_refused', 'The signing secret cannot be changed now.'],
  ])('%s', (code, fallback) => {
    test.each([['constructor'], ['__proto__'], ['toString']])(
      'the reason `%s` is a word nobody knows, not a property of the table',
      (reason) => {
        expect(webhookMessageFor(refusal(code, reason))).toBe(fallback)
      }
    )

    test('a reason the answer only inherits is no reason', () => {
      const params = Object.create({ reason: 'delivery_pending' })
      const error = new ApiError({ status: 409, code, detail: 'The server’s own.', params })
      expect(webhookMessageFor(error)).toBe(fallback)
    })
  })

  test.each([['constructor'], ['__proto__'], ['toString']])(
    'the code `%s` is a code nobody knows, not a property of the table',
    (code) => {
      expect(webhookMessageFor(refusal(code, 'delivery_pending'))).toBe(
        'The server’s own description.'
      )
    }
  )

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

  test('a refusal for too many requests does not name a limit the answer did not name', () => {
    // A 429 says `rate_limited` and how long to wait, whichever limit it was: the general
    // one for the admin API (per address) or the one for requests made on demand.
    const limited = (retryAfter: number | null) =>
      new ApiError({ status: 429, code: 'rate_limited', detail: 'Too many requests.', retryAfter })
    expect(webhookMessageFor(limited(7), 'redeliver')).toBe(
      'Too many requests. Try again in 7 seconds. Test events and deliveries sent again also have an allowance of their own, for the whole environment.'
    )
    expect(webhookMessageFor(limited(7), 'test')).toBe(
      'Too many requests. Try again in 7 seconds. Test events and deliveries sent again also have an allowance of their own, for the whole environment.'
    )
    expect(webhookMessageFor(limited(null), 'redeliver')).toBe(
      'Too many requests. Wait a moment, then try again. Test events and deliveries sent again also have an allowance of their own, for the whole environment.'
    )
    expect(webhookMessageFor(limited(7))).toBe('Too many requests. Try again in 7 seconds.')
    for (const action of ['test', 'redeliver', 'other'] as const) {
      expect(webhookMessageFor(limited(7), action)).not.toMatch(/\bten\b|\b10\b|a minute/)
    }
  })

  describe('where the webhook worker is a service of its own', () => {
    const DETAIL = 'The server’s own description.'
    const unavailable = (params?: Record<string, unknown>) =>
      new ApiError({ status: 501, code: 'not_implemented', detail: DETAIL, params })
    const TEST =
      'This deployment delivers webhooks from a separate worker, so a test event cannot be sent from here. Real events are still delivered: to see a delivery, cause an event (create a test user, for example) and look at this endpoint’s deliveries.'
    const AGAIN =
      'This deployment delivers webhooks from a separate worker, so a delivery cannot be sent again from here. Real events are still delivered, and a delivery that is pending is still retried by the worker.'

    test('a test event and a delivery sent again each say so, in their own words', () => {
      const refused = unavailable({ reason: 'worker_separate' })
      expect(webhookMessageFor(refused, 'test')).toBe(TEST)
      expect(webhookMessageFor(refused, 'redeliver')).toBe(AGAIN)
      for (const sentence of [TEST, AGAIN]) {
        // A webhook is never called a hook, and no setting's name is the explanation.
        expect(sentence).not.toMatch(/\bhooks?\b|WEBHOOK_WORKER|not_implemented|501/)
      }
    })

    test('no other action has such a sentence', () => {
      const refused = unavailable({ reason: 'worker_separate' })
      expect(webhookMessageFor(refused)).toBe(DETAIL)
      expect(webhookMessageFor(refused, 'create')).toBe(DETAIL)
    })

    test.each([
      ['no params', undefined],
      ['no reason', {}],
      ['a reason this version does not know', { reason: 'a_later_word' }],
      ['a reason that is no string', { reason: 42 }],
      ['a reason in a list', { reason: ['worker_separate'] }],
      ['a reason that is not the answer’s own', Object.create({ reason: 'worker_separate' })],
      ['the name of something every object has', { reason: 'constructor' }],
    ])('any other `not_implemented` (%s) keeps the general sentence', (_name, params) => {
      for (const action of ['test', 'redeliver'] as const) {
        expect(webhookMessageFor(unavailable(params), action)).toBe(DETAIL)
      }
    })

    test('another code with that reason is not taken for it', () => {
      const other = new ApiError({
        status: 503,
        code: 'service.unavailable',
        detail: DETAIL,
        params: { reason: 'worker_separate' },
      })
      expect(webhookMessageFor(other, 'test')).toBe(DETAIL)
    })
  })

  test.each([
    ['resource.not_found', 404, undefined],
    // An id from a hand-edited address that is no id at all: the API refuses the path
    // parameter (422), which to the reader is the same thing as an id nothing has.
    [
      'validation.failed',
      422,
      [{ field: 'id', code: 'validation.failed', message: 'Invalid UUID' }],
    ],
    [
      'validation.failed',
      422,
      [{ field: 'deliveryId', code: 'validation.failed', message: 'Invalid UUID' }],
    ],
  ])('%s (%i) for the thing a screen is about is “not found”', (code, status, errors) => {
    const error = new ApiError({
      status,
      code,
      detail: 'The server’s own description.',
      fieldErrors: errors,
    })
    expect(isNotFound(error)).toBe(true)
  })

  test.each([
    [
      'a refused filter',
      422,
      'validation.failed',
      [{ field: 'page', code: 'validation.failed', message: 'x' }],
    ],
    [
      'a refused body',
      422,
      'validation.failed',
      [{ field: 'url', code: 'validation.failed', message: 'x' }],
    ],
    ['a refusal with no field', 422, 'validation.failed', []],
    ['a conflict', 409, 'resource.conflict', undefined],
    ['a failure of the server', 500, 'internal', undefined],
  ])('%s is not “not found”', (_name, status, code, errors) => {
    const error = new ApiError({
      status,
      code,
      detail: 'The server’s own description.',
      fieldErrors: errors,
    })
    expect(isNotFound(error)).toBe(false)
  })
})

describe('an event type that could be misread says what it is about', () => {
  test.each([
    [
      'hook.created',
      'A hook (a question the server asks your backend before a sign-up) was registered. Not sent when a hook is asked.',
    ],
    [
      'hook.updated',
      'A hook (a question the server asks your backend before a sign-up) was changed, switched on or switched off. Not sent when a hook is asked.',
    ],
    [
      'hook.deleted',
      'A hook (a question the server asks your backend before a sign-up) was removed. Not sent when a hook is asked.',
    ],
    [
      'signing_key.rotated',
      'The key that signs this environment’s access tokens was replaced. Not about a webhook signing secret.',
    ],
    [
      'webhook_endpoint.secret_rotated',
      'A webhook endpoint’s signing secret was replaced. The event carries when the overlap ends, never a secret.',
    ],
    [
      'webhook_endpoint.disabled',
      'The server switched a webhook endpoint off by itself (it answered 410, or failed for five days). Not sent when an operator switches one off: that is webhook_endpoint.updated.',
    ],
    [
      'session.reuse_detected',
      'A refresh token that had already been used was presented again, and the server ended every session of that sign-in.',
    ],
  ])('%s', (type, note) => {
    expect(eventTypeNote(type)).toBe(note)
  })

  test('a type that says what it is has no note, and neither has one nobody knows', () => {
    expect(eventTypeNote('user.created')).toBeUndefined()
    expect(eventTypeNote('invoice.paid')).toBeUndefined()
    // An inherited key is not a type.
    expect(eventTypeNote('constructor')).toBeUndefined()
  })

  test('every note is about a type the contract defines', () => {
    expect(NOTED_EVENT_TYPES.filter((type) => !ACTIVITY_TYPES.includes(type as never))).toEqual([])
    expect(NOTED_EVENT_TYPES).toHaveLength(7)
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
    // The last page the server answers: 500 pages of 20 are its newest 10,000 deliveries.
    [{ page: 500 }, { page: 500 }],
    // A page past that is refused by the server (422), so it is no page: the first one.
    [{ page: 501 }, {}],
    [{ state: 'failed', page: 600 }, { state: 'failed' }],
    [{ page: 1_000_001 }, {}],
  ])('%j reads as %j', (search, filters) => {
    expect<unknown>(deliverySearch(search)).toEqual(filters)
  })

  test('the window and the page size are the server’s, as the generated client states them', () => {
    // The API's `WEBHOOK_DELIVERY_LIST_WINDOW` is not in the contract; the operation's
    // description, which the client is generated with, says it.
    const client = readFileSync(join(import.meta.dir, '../../api/generated/api.gen.ts'), 'utf8')
    const stated = /pages through the newest (\d+) matching deliveries/.exec(client)
    expect(Number(stated?.[1])).toBe(DELIVERY_LIST_WINDOW)
    expect(DELIVERY_LIST_WINDOW).toBe(10_000)
    expect(DELIVERY_PAGE_SIZE).toBe(DEFAULT_PAGE_SIZE)
    expect(LAST_DELIVERY_PAGE).toBe(500)
  })
})

describe('what a route file runs before its screen is loaded stays free of Zod', () => {
  // `validateSearch` and `beforeLoad` are part of the entry chunk; the screen (`component`)
  // is split off and loaded later. The entry chunk's imports run before `lib/zod-csp.ts`
  // has told Zod not to probe `new Function`, so a schema built there is a
  // Content-Security-Policy violation in the browser, and nothing in happy-dom notices.
  const SRC = join(import.meta.dir, '../..')
  const ROUTE_FILES = [
    'index.tsx',
    '$endpointId/index.tsx',
    '$endpointId/deliveries/$deliveryId.tsx',
  ].map((file) =>
    join(SRC, 'routes/_app/w.$workspaceId/p.$projectId/e.$environmentId/webhooks', file)
  )

  test('the three route files exist and each names a screen', () => {
    for (const file of ROUTE_FILES) {
      expect(entryImports(file, SRC).lazy.length).toBe(1)
    }
  })

  test('nothing they import at module level, however far down, reaches Zod or the contract’s schemas', () => {
    for (const file of ROUTE_FILES) {
      const { reached, forbidden } = entryImports(file, SRC)
      // The walk went somewhere: the generated client is what the search reader reads.
      expect(forbidden).toEqual([])
      expect(reached.length).toBeGreaterThan(0)
    }
    const reader = entryImports(ROUTE_FILES[1] as string, SRC).reached
    expect(reader.some((path) => path.endsWith('features/webhooks/delivery-search.ts'))).toBe(true)
    expect(reader.some((path) => path.endsWith('api/generated/api.gen.ts'))).toBe(true)
  })

  test('the walk would see it: a screen’s module does reach the contract’s schemas', () => {
    const screen = join(SRC, 'features/webhooks/webhooks-screen.tsx')
    expect(entryImports(screen, SRC, { everything: true }).forbidden).toContain('@tula/contract')
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
    // Sixteen files of the feature and three routes: a walk that finds none proves nothing.
    expect(files.length).toBe(19)
    const offending = files
      // The one file that has to say the word: the notes on the `hook.*` event types.
      .filter((file) => !file.endsWith('event-type-notes.ts'))
      .filter((file) => /callback|(?<!web)hook/i.test(readFileSync(file, 'utf8')))
    expect(offending).toEqual([])
  })

  test('the notes say “hook” only of the `hook.*` types, and never for a webhook', () => {
    const notes = readFileSync(join(HERE, 'event-type-notes.ts'), 'utf8')
    expect(/callback/i.test(notes)).toBe(false)
    const saying = NOTED_EVENT_TYPES.filter((type) =>
      /(?<!web)hook/i.test(eventTypeNote(type) ?? '')
    )
    expect(saying).toEqual(['hook.created', 'hook.updated', 'hook.deleted'])
  })
})
