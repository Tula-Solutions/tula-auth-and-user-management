import { describe, expect, spyOn, test } from 'bun:test'
import {
  ACTIVITY_TYPES,
  type ActivityType,
  EVENT_FIXTURES,
  EVENT_SCHEMA_VERSION,
  EVENT_SCHEMAS,
} from '@tula/contract'
import { eventPayload } from '~/lib/event-payload'
import * as logger from '~/lib/logger'
import type { Activity } from '~/ports/activity-log'

const CANARY = 'tula_sk_live_CANARY_9f8e7d6c5b4a'

/** The activity that a fixture's event is the payload of. */
function activityOf(type: ActivityType, overrides: Partial<Activity> = {}): Activity {
  const fixture = EVENT_FIXTURES[type]
  return {
    id: fixture.id,
    projectId: 'p_1',
    environmentId: 'e_1',
    type,
    actor: fixture.actor,
    target: fixture.target,
    ipAddress: '203.0.113.7',
    userAgent: 'Mozilla/5.0',
    // A copy all the way down: a test that changes an activity must not change the fixture.
    data: structuredClone(fixture.data),
    occurredAt: new Date(fixture.occurredAt),
    ...overrides,
  }
}

describe('eventPayload', () => {
  test.each([...ACTIVITY_TYPES])('%s: the payload is the event its schema describes', (type) => {
    const payload = eventPayload(activityOf(type))
    expect(payload).toEqual(EVENT_FIXTURES[type])
    expect(EVENT_SCHEMAS[type].parse(payload)).toEqual(EVENT_FIXTURES[type])
  })

  test('carries the version, an ISO time and neither the IP address nor the user agent', () => {
    const payload = eventPayload(activityOf('session.created'))
    expect(payload.schemaVersion).toBe(EVENT_SCHEMA_VERSION)
    expect(payload.occurredAt).toBe('2026-10-08T09:30:00.000Z')
    expect(Object.keys(payload).sort()).toEqual(
      ['actor', 'data', 'id', 'occurredAt', 'schemaVersion', 'target', 'type'].sort()
    )
    expect(JSON.stringify(payload)).not.toContain('203.0.113.7')
    expect(JSON.stringify(payload)).not.toContain('Mozilla')
  })

  // The allow-list. A key the type's schema does not name never reaches a payload, whatever
  // a call site (or a later change to one) puts in `data`.
  test.each([...ACTIVITY_TYPES])('%s: a key the schema does not name is dropped', (type) => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      const fixture = EVENT_FIXTURES[type]
      const payload = eventPayload(
        activityOf(type, {
          actor: Object.assign({}, fixture.actor, { email: CANARY }),
          target: Object.assign({}, fixture.target, { email: CANARY }),
          ipAddress: CANARY,
          userAgent: CANARY,
          data: {
            ...fixture.data,
            email: CANARY,
            password: CANARY,
            token: CANARY,
            nested: { secret: CANARY },
            list: [CANARY],
          },
        })
      )
      expect(JSON.stringify(payload)).not.toContain(CANARY)
      expect(payload).toEqual(fixture)
    } finally {
      warn.mockRestore()
    }
  })

  // And a key the schema does name carries only what the schema allows there: a secret in
  // place of an enum value, an id or a list of key names is dropped with its field.
  test.each([...ACTIVITY_TYPES])(
    '%s: a named key with a value its schema refuses is dropped',
    (type) => {
      const warn = spyOn(logger, 'warn').mockImplementation(() => undefined)
      try {
        const long = `${CANARY}${'x'.repeat(200)} with spaces\n`
        const data = Object.fromEntries(
          Object.keys(EVENT_FIXTURES[type].data).flatMap((key) => [[key, { value: long }]])
        )
        const payload = eventPayload(activityOf(type, { data }))
        expect(payload.data).toEqual({})
        for (const value of [long, [long], 12.5]) {
          const each = Object.fromEntries(
            Object.keys(EVENT_FIXTURES[type].data).map((key) => [key, value])
          )
          expect(JSON.stringify(eventPayload(activityOf(type, { data: each })))).not.toContain(
            CANARY
          )
        }
      } finally {
        warn.mockRestore()
      }
    }
  )

  test('never throws: a record that cannot be written would undo the change it records', () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      for (const data of [{}, { method: null }, { method: undefined }, { changed: 'not a list' }]) {
        expect(() => eventPayload(activityOf('user.created', { data }))).not.toThrow()
      }
      const unknown = activityOf('user.created', {
        type: 'user.exploded' as ActivityType,
        data: { anything: CANARY },
      })
      expect(eventPayload(unknown).data).toEqual({})
    } finally {
      warn.mockRestore()
    }
  })

  test('says which keys it dropped, by name and never by value', () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      eventPayload(activityOf('user.banned', { data: { reason: CANARY } }))
      expect(warn).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(warn.mock.calls)).toContain('reason')
      expect(JSON.stringify(warn.mock.calls)).not.toContain(CANARY)
      warn.mockClear()
      eventPayload(activityOf('user.banned'))
      // An optional field that is simply absent is not a dropped one.
      eventPayload(activityOf('user.created', { data: { method: 'admin', emailVerified: true } }))
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  test('copies what it keeps: a later change to the activity does not reach the payload', () => {
    const activity = activityOf('session.stepped_up')
    const payload = eventPayload(activity)
    ;(activity.data.methods as string[]).push('pwd')
    expect(activity.data.methods).toContain('pwd')
    expect(payload.data).toEqual(EVENT_FIXTURES['session.stepped_up'].data)
  })
})
