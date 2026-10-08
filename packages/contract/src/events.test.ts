import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { AUDIT_TARGET_TYPES } from './audit'
import { EVENT_FIXTURES } from './event-fixtures'
import { ACTIVITY_TYPES, EVENT_SCHEMA_VERSION, EVENT_TARGET_TYPES } from './event-types'
import { EVENT_DATA_SCHEMAS, EVENT_SCHEMAS, type Event, EventSchema } from './events'

const sorted = (values: readonly string[]) => [...values].sort()

describe('every activity type has a payload', () => {
  test.each<[string, Record<string, unknown>]>([
    ['a data schema', EVENT_DATA_SCHEMAS],
    ['an event schema', EVENT_SCHEMAS],
    ['a fixture', EVENT_FIXTURES],
    ['a target type', EVENT_TARGET_TYPES],
  ])('%s for each type, and none for a type that does not exist', (_what, record) => {
    expect(sorted(Object.keys(record))).toEqual(sorted(ACTIVITY_TYPES))
    for (const type of ACTIVITY_TYPES) {
      expect(record[type]).toBeDefined()
    }
  })

  test('the version is a positive integer and every schema pins it', () => {
    expect(Number.isInteger(EVENT_SCHEMA_VERSION)).toBe(true)
    expect(EVENT_SCHEMA_VERSION).toBeGreaterThan(0)
    for (const type of ACTIVITY_TYPES) {
      const event = { ...EVENT_FIXTURES[type], schemaVersion: EVENT_SCHEMA_VERSION + 1 }
      expect(EVENT_SCHEMAS[type].safeParse(event).success).toBe(false)
    }
  })

  test('every target type is one the audit log knows', () => {
    for (const type of ACTIVITY_TYPES) {
      expect(AUDIT_TARGET_TYPES).toContain(EVENT_TARGET_TYPES[type])
    }
  })
})

describe('fixtures', () => {
  test.each([...ACTIVITY_TYPES])('%s parses with its own schema and loses nothing', (type) => {
    const fixture: Event = EVENT_FIXTURES[type]
    expect(fixture.type).toBe(type)
    expect(fixture.schemaVersion).toBe(EVENT_SCHEMA_VERSION)
    expect(fixture.target.type).toBe(EVENT_TARGET_TYPES[type])
    // `toEqual` on the parsed value: a fixture field the schema does not name would be gone.
    expect(EVENT_SCHEMAS[type].parse(fixture)).toEqual(fixture)
    expect(EventSchema.parse(fixture)).toEqual(fixture)
  })

  test('a fixture exercises every field of its data schema', () => {
    for (const type of ACTIVITY_TYPES) {
      expect(sorted(Object.keys(EVENT_FIXTURES[type].data))).toEqual(
        sorted(Object.keys(EVENT_DATA_SCHEMAS[type].shape))
      )
    }
  })

  test('fixtures are plain JSON', () => {
    expect(JSON.parse(JSON.stringify(EVENT_FIXTURES))).toEqual(EVENT_FIXTURES)
  })
})

describe('an event schema', () => {
  test('is refused for another type’s payload', () => {
    const created = EVENT_FIXTURES['user.created']
    expect(EVENT_SCHEMAS['session.created'].safeParse(created).success).toBe(false)
    expect(EventSchema.safeParse({ ...created, type: 'user.exploded' }).success).toBe(false)
  })

  test('refuses a target of the wrong kind', () => {
    const event = {
      ...EVENT_FIXTURES['user.banned'],
      target: EVENT_FIXTURES['session.created'].target,
    }
    expect(EVENT_SCHEMAS['user.banned'].safeParse(event).success).toBe(false)
  })

  test('refuses a value outside a closed set', () => {
    const { userId } = EVENT_FIXTURES['session.created'].data
    for (const [type, data] of [
      ['user.created', { method: 'magic', emailVerified: true }],
      ['user.password_changed', { method: 'guessed' }],
      ['user.identity_linked', { provider: 'myspace', method: 'auto' }],
      ['session.created', { userId, client: 'fridge' }],
      ['session.revoked', { userId, reason: 'reuse_detected' }],
      ['session.reuse_detected', { userId, reason: 'sign_out' }],
      ['session.stepped_up', { userId, methods: ['telepathy'] }],
      ['api_key.created', { kind: 'master' }],
      ['oauth_provider.updated', { provider: 'google', changed: ['clientSecretValue'] }],
      ['environment.settings_updated', { revision: 2, changed: ['a key with spaces'] }],
      ['environment.settings_updated', { revision: 2, changed: [], managedBy: 'Not A Tool!' }],
    ] as const) {
      expect(EVENT_DATA_SCHEMAS[type].safeParse(data).success).toBe(false)
    }
  })

  // The allow-list: what a schema does not name does not survive a parse.
  test.each([...ACTIVITY_TYPES])('%s drops every key it does not name', (type) => {
    const canary = 'tula_sk_live_CANARY'
    const fixture = EVENT_FIXTURES[type]
    const parsed = EVENT_SCHEMAS[type].parse({
      ...fixture,
      ipAddress: canary,
      userAgent: canary,
      email: canary,
      actor: { ...fixture.actor, email: canary },
      target: { ...fixture.target, email: canary },
      data: { ...fixture.data, email: canary, token: canary, password: canary },
    })
    expect(JSON.stringify(parsed)).not.toContain(canary)
    expect(parsed).toEqual(fixture)
  })

  test('has no place for an IP address or a user agent', () => {
    // The envelope is exactly these keys: no IP address and no user agent (ADR 0012).
    for (const type of ACTIVITY_TYPES) {
      expect(sorted(Object.keys(EVENT_FIXTURES[type]))).toEqual(
        sorted(['id', 'type', 'schemaVersion', 'occurredAt', 'actor', 'target', 'data'])
      )
    }
  })
})

describe('ids', () => {
  test('an id is a UUID: no other string fits where one goes', () => {
    const canary = 'tula_sk_live_CANARY'
    const created = EVENT_FIXTURES['session.created']
    for (const event of [
      { ...created, id: canary },
      { ...created, target: { ...created.target, id: canary } },
      { ...created, data: { ...created.data, userId: canary } },
    ]) {
      expect(EVENT_SCHEMAS['session.created'].safeParse(event).success).toBe(false)
    }
    const added = EVENT_FIXTURES['user.passkey_added']
    expect(
      EVENT_SCHEMAS['user.passkey_added'].safeParse({
        ...added,
        data: { ...added.data, passkeyId: canary },
      }).success
    ).toBe(false)
  })

  test('the server and the instance admin token have no actor id', () => {
    const event = { ...EVENT_FIXTURES['user.banned'], actor: { type: 'instance_admin', id: null } }
    expect(EventSchema.parse(event)).toEqual(event as never)
  })
})

describe('the OpenAPI names', () => {
  test('every schema has a ref of its own', () => {
    const refs = [
      EventSchema,
      ...ACTIVITY_TYPES.flatMap((type) => [EVENT_SCHEMAS[type], EVENT_DATA_SCHEMAS[type]]),
    ].map((schema) => z.globalRegistry.get(schema)?.ref)
    for (const ref of refs) {
      expect(ref).toMatch(/^[A-Z][A-Za-z]+$/)
    }
    expect(new Set(refs).size).toBe(refs.length)
    expect(z.globalRegistry.get(EVENT_SCHEMAS['oauth_provider.updated'])?.ref).toBe(
      'OAuthProviderUpdatedEvent'
    )
  })
})
