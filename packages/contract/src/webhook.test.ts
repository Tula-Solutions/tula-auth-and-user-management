import { describe, expect, test } from 'bun:test'
import { ACTIVITY_TYPES } from './event-types'
import {
  CreatedWebhookEndpointSchema,
  CreateWebhookEndpointRequestSchema,
  MAX_WEBHOOK_URL_LENGTH,
  UpdateWebhookEndpointRequestSchema,
  WebhookEndpointSchema,
} from './webhook'

const endpoint = {
  id: '0199c2f4-7a18-7abb-99ca-cd7e8b4a5f09',
  url: 'https://hooks.example.com/tula',
  eventTypes: ['user.created'],
  enabled: true,
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
