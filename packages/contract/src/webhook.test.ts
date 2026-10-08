import { describe, expect, test } from 'bun:test'
import { ACTIVITY_TYPES } from './event-types'
import {
  CreatedWebhookEndpointSchema,
  CreateWebhookEndpointRequestSchema,
  MAX_WEBHOOK_URL_LENGTH,
  SendTestWebhookRequestSchema,
  UpdateWebhookEndpointRequestSchema,
  WebhookDeliveryDetailSchema,
  WebhookEndpointSchema,
  WebhookSendResultSchema,
} from './webhook'

const endpoint = {
  id: '0199c2f4-7a18-7abb-99ca-cd7e8b4a5f09',
  url: 'https://hooks.example.com/tula',
  eventTypes: ['user.created'],
  enabled: true,
  disabledReason: null,
  failingSince: null,
  lastFailedAt: null,
  createdAt: '2026-10-08T09:30:00.000Z',
  updatedAt: '2026-10-08T09:30:00.000Z',
}

describe('CreateWebhookEndpointRequestSchema', () => {
  const accepts = (body: unknown) => CreateWebhookEndpointRequestSchema.safeParse(body).success

  test('an endpoint is on unless it says otherwise', () => {
    expect(
      CreateWebhookEndpointRequestSchema.parse({ url: endpoint.url, eventTypes: ['user.created'] })
    ).toEqual({ url: endpoint.url, eventTypes: ['user.created'], enabled: true })
  })

  test('every known event type can be subscribed to at once', () => {
    expect(accepts({ url: endpoint.url, eventTypes: [...ACTIVITY_TYPES] })).toBe(true)
  })

  test.each([
    ['no event type', { url: endpoint.url, eventTypes: [] }],
    ['an unknown event type', { url: endpoint.url, eventTypes: ['user.exploded'] }],
    ['an event type twice', { url: endpoint.url, eventTypes: ['user.created', 'user.created'] }],
    ['no address', { eventTypes: ['user.created'] }],
    [
      'an address with a line break in it',
      { url: 'https://a.example/x\ny', eventTypes: ['user.created'] },
    ],
    [
      'an address with a space in it',
      { url: 'https://a.example/x y', eventTypes: ['user.created'] },
    ],
    [
      'an address with a control character',
      { url: 'https://a.example/\u0000', eventTypes: ['user.created'] },
    ],
    ['an empty address', { url: '', eventTypes: ['user.created'] }],
    [
      'an address that is too long',
      {
        url: `https://a.example/${'x'.repeat(MAX_WEBHOOK_URL_LENGTH)}`,
        eventTypes: ['user.created'],
      },
    ],
    // The server generates the secret: a client cannot choose a weak one.
    ['a secret of the caller’s', { url: endpoint.url, eventTypes: ['user.created'], secret: 'x' }],
    ['an unknown field', { url: endpoint.url, eventTypes: ['user.created'], retries: 3 }],
  ])('refuses %s', (_, body) => {
    expect(accepts(body)).toBe(false)
  })
})

describe('UpdateWebhookEndpointRequestSchema', () => {
  const accepts = (body: unknown) => UpdateWebhookEndpointRequestSchema.safeParse(body).success

  test.each([
    ['the address', { url: 'https://other.example.com/hook' }],
    ['an address that is not ASCII', { url: 'https://bücher.example/hook?q=é' }],
    ['the event types', { eventTypes: ['session.created', 'session.revoked'] }],
    ['the switch', { enabled: false }],
    ['all three', { url: endpoint.url, eventTypes: ['user.created'], enabled: true }],
  ])('changes %s', (_, body) => {
    expect(accepts(body)).toBe(true)
  })

  test.each([
    ['nothing', {}],
    ['a secret', { secret: 'whsec_x' }],
    ['an id', { id: endpoint.id, enabled: false }],
    ['no event type', { eventTypes: [] }],
    ['an unknown event type', { eventTypes: ['nope'] }],
    ['an address with a tab in it', { url: 'https://a.example/\tx' }],
  ])('refuses %s', (_, body) => {
    expect(accepts(body)).toBe(false)
  })
})

describe('WebhookEndpointSchema', () => {
  test('a listed endpoint never carries a secret, even when given one', () => {
    expect(WebhookEndpointSchema.parse({ ...endpoint, secret: 'whsec_x' })).toEqual(endpoint)
  })

  test('reads an event type a later server added', () => {
    expect(WebhookEndpointSchema.parse({ ...endpoint, eventTypes: ['phone.verified'] })).toEqual({
      ...endpoint,
      eventTypes: ['phone.verified'],
    })
  })

  test('only the created endpoint has the secret', () => {
    expect(CreatedWebhookEndpointSchema.parse({ ...endpoint, secret: 'whsec_x' }).secret).toBe(
      'whsec_x'
    )
    expect(CreatedWebhookEndpointSchema.safeParse(endpoint).success).toBe(false)
  })
})

describe('the delivery log', () => {
  const delivery = {
    id: '0199c2f4-7a19-7abb-99ca-cd7e8b4a5f10',
    endpointId: endpoint.id,
    eventId: '0199c2f5-0000-7000-8000-000000000001',
    eventType: 'user.created',
    test: false,
    state: 'pending',
    attemptCount: 1,
    nextAttemptAt: '2026-10-08T09:30:05.000Z',
    lastAttemptAt: '2026-10-08T09:30:00.000Z',
    statusCode: 500,
    failureReason: null,
    completedAt: null,
    createdAt: '2026-10-08T09:30:00.000Z',
    attempts: [
      {
        attempt: 1,
        attemptedAt: '2026-10-08T09:30:00.000Z',
        statusCode: 500,
        durationMs: 12,
        failureReason: null,
      },
    ],
  }

  test('a delivery has no field for anything a receiver said but its status code', () => {
    const parsed = WebhookDeliveryDetailSchema.parse({
      ...delivery,
      responseBody: 'canary',
      attempts: [{ ...delivery.attempts[0], responseHeaders: { canary: 'canary' } }],
    })
    expect(JSON.stringify(parsed)).not.toContain('canary')
    expect(parsed).toEqual(delivery)
  })

  test('a state, an event type and a failure word a later server added are still read', () => {
    expect(
      WebhookDeliveryDetailSchema.safeParse({
        ...delivery,
        state: 'paused',
        eventType: 'user.exploded',
        failureReason: 'something_new',
      }).success
    ).toBe(true)
  })

  test('a test event has no event id', () => {
    expect(
      WebhookDeliveryDetailSchema.safeParse({ ...delivery, eventId: null, test: true }).success
    ).toBe(true)
  })

  test('a test event is asked for by a known type and nothing else', () => {
    expect(SendTestWebhookRequestSchema.safeParse({ eventType: 'user.created' }).success).toBe(true)
    expect(SendTestWebhookRequestSchema.safeParse({ eventType: 'user.exploded' }).success).toBe(
      false
    )
    expect(SendTestWebhookRequestSchema.safeParse({}).success).toBe(false)
    expect(
      SendTestWebhookRequestSchema.safeParse({
        eventType: 'user.created',
        url: 'https://x.example',
      }).success
    ).toBe(false)
  })

  test('the outcome of a request made on demand is a status and a duration, nothing more', () => {
    const result = {
      deliveryId: delivery.id,
      outcome: 'failed',
      statusCode: 500,
      durationMs: 3,
      failureReason: null,
    }
    expect(WebhookSendResultSchema.parse({ ...result, body: 'canary' })).toEqual(result as never)
  })
})
