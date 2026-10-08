import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { AUDIT_TARGET_TYPES } from './audit'
import { EVENT_FIXTURES } from './event-fixtures'
import { ACTIVITY_TYPES, EVENT_SCHEMA_VERSION, EVENT_TARGET_TYPES } from './event-types'
import { EVENT_DATA_SCHEMAS, EVENT_SCHEMAS, type TulaEvent, TulaEventSchema } from './events'

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
    const fixture: TulaEvent = EVENT_FIXTURES[type]
    expect(fixture.type).toBe(type)
    expect(fixture.schemaVersion).toBe(EVENT_SCHEMA_VERSION)
    expect(fixture.target.type).toBe(EVENT_TARGET_TYPES[type])
    // `toEqual` on the parsed value: a fixture field the schema does not name would be gone.
    expect(EVENT_SCHEMAS[type].parse(fixture)).toEqual(fixture)
    expect(TulaEventSchema.parse(fixture)).toEqual(fixture)
  })

  test('a fixture exercises every field of its data schema', () => {
    // Fields that belong to another `method` of the same type than the one the fixture shows.
    const elsewhere: Partial<Record<(typeof ACTIVITY_TYPES)[number], string[]>> = {
      'user.passkey_removed': ['canStillSignIn'],
    }
    for (const type of ACTIVITY_TYPES) {
      expect(
        sorted([...Object.keys(EVENT_FIXTURES[type].data), ...(elsewhere[type] ?? [])])
      ).toEqual(sorted(Object.keys(EVENT_DATA_SCHEMAS[type].shape)))
    }
  })

  test('fixtures are plain JSON', () => {
    expect(JSON.parse(JSON.stringify(EVENT_FIXTURES))).toEqual(EVENT_FIXTURES)
  })
})

describe('a webhook secret being replaced', () => {
  test('no field of either event is named like a secret: a time under such a key would be taken for one', () => {
    for (const type of [
      'webhook_endpoint.secret_rotated',
      'webhook_endpoint.previous_secret_revoked',
    ] as const) {
      expect(
        Object.keys(EVENT_DATA_SCHEMAS[type].shape).filter((key) => /secret|token|key/i.test(key))
      ).toEqual([])
    }
  })

  test('the rotation says when the previous secret stops signing, and has no place for a secret', () => {
    const fixture = EVENT_FIXTURES['webhook_endpoint.secret_rotated']
    expect(Object.keys(EVENT_DATA_SCHEMAS['webhook_endpoint.secret_rotated'].shape)).toEqual([
      'rotationOverlapEndsAt',
    ])
    const leaky = { ...fixture, data: { ...fixture.data, secret: 'whsec_x', prefix: 'whsec_ab' } }
    expect(EVENT_SCHEMAS['webhook_endpoint.secret_rotated'].parse(leaky)).toEqual(fixture)
    expect(
      EVENT_SCHEMAS['webhook_endpoint.secret_rotated'].safeParse({
        ...fixture,
        data: { rotationOverlapEndsAt: 'soon' },
      }).success
    ).toBe(false)
  })

  test('ending the overlap early is an event of its own, about the endpoint, with nothing in it', () => {
    const fixture = EVENT_FIXTURES['webhook_endpoint.previous_secret_revoked']
    expect(
      Object.keys(EVENT_DATA_SCHEMAS['webhook_endpoint.previous_secret_revoked'].shape)
    ).toEqual([])
    expect(fixture.target.type).toBe('webhook_endpoint')
    expect(fixture.data).toEqual({})
  })
})

describe('an event schema', () => {
  test('is refused for another type’s payload', () => {
    const created = EVENT_FIXTURES['user.created']
    expect(EVENT_SCHEMAS['session.created'].safeParse(created).success).toBe(false)
    expect(TulaEventSchema.safeParse({ ...created, type: 'user.exploded' }).success).toBe(false)
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
    expect(TulaEventSchema.parse(event)).toEqual(event as never)
  })
})

describe('user.passkey_removed', () => {
  const schema = EVENT_SCHEMAS['user.passkey_removed']
  const fixture = EVENT_FIXTURES['user.passkey_removed']
  const { passkeyId } = fixture.data
  const withData = (data: Record<string, unknown>) => schema.safeParse({ ...fixture, data }).success

  test('by its owner it names the passkey and says nothing about signing in', () => {
    expect(fixture.data).toEqual({ passkeyId, method: 'user' } as never)
    expect(withData({ passkeyId, method: 'user' })).toBe(true)
    expect(withData({ method: 'user' })).toBe(false)
    expect(withData({ passkeyId, method: 'user', canStillSignIn: true })).toBe(false)
  })

  test('by an admin reset it names no passkey (all are removed) and says whether the user can still sign in', () => {
    expect(withData({ method: 'admin_reset', canStillSignIn: false })).toBe(true)
    expect(withData({ method: 'admin_reset', canStillSignIn: true })).toBe(true)
    expect(withData({ method: 'admin_reset' })).toBe(false)
    expect(withData({ passkeyId, method: 'admin_reset', canStillSignIn: true })).toBe(false)
  })

  test('the data schema still has a shape and its ref: the rule is a check, not another type', () => {
    const data = EVENT_DATA_SCHEMAS['user.passkey_removed']
    expect(sorted(Object.keys(data.shape))).toEqual(['canStillSignIn', 'method', 'passkeyId'])
    expect(z.globalRegistry.get(data)?.ref).toBe('UserPasskeyRemovedEventData')
  })
})

describe('environment.settings_updated', () => {
  const { changed } = EVENT_DATA_SCHEMAS['environment.settings_updated'].shape

  test('`changed` is bounded: 256 names at most', () => {
    const names = (count: number) => Array.from({ length: count }, (_, n) => `a.key${n}`)
    expect(changed.safeParse(names(256)).success).toBe(true)
    expect(changed.safeParse(names(257)).success).toBe(false)
  })

  test('a name is dotted segments of letters, digits, `_` and `-`, 128 characters at most', () => {
    for (const name of ['password.minLength', 'sessions.profiles.back-office.idleTimeout']) {
      expect(changed.safeParse([name]).success).toBe(true)
    }
    for (const name of ['', 'a..b', '.a', 'a.', 'a b', 'a=b', 'a/b', `a.${'b'.repeat(127)}`]) {
      expect(changed.safeParse([name]).success).toBe(false)
    }
  })
})

describe('the OpenAPI names', () => {
  test('the union is `TulaEvent`: `Event` is the DOM’s', () => {
    expect(z.globalRegistry.get(TulaEventSchema)?.ref).toBe('TulaEvent')
  })

  test('every schema has a ref of its own', () => {
    const refs = [
      TulaEventSchema,
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
