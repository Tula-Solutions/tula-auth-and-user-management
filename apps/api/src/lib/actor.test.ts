import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { AppEnv, SessionVariables, TenantVariables } from '~/dependencies'
import {
  adminActor,
  cleanOrigin,
  MAX_USER_AGENT_LENGTH,
  requestOrigin,
  systemActor,
  userActor,
} from '~/lib/actor'
import { createTestDeps, TEST_CONFIG } from '~/testing'

describe('cleanOrigin', () => {
  test.each([
    [
      { ipAddress: '203.0.113.7', userAgent: 'curl/8' },
      { ipAddress: '203.0.113.7', userAgent: 'curl/8' },
    ],
    [
      { ipAddress: '::1', userAgent: null },
      { ipAddress: '::1', userAgent: null },
    ],
    [
      { ipAddress: 'unknown', userAgent: '' },
      { ipAddress: null, userAgent: null },
    ],
    [{ ipAddress: '203.0.113.7:8080' }, { ipAddress: null, userAgent: null }],
    [{}, { ipAddress: null, userAgent: null }],
  ] as [Parameters<typeof cleanOrigin>[0], ReturnType<typeof cleanOrigin>][])(
    '%j becomes %j',
    (origin, expected) => {
      expect(cleanOrigin(origin)).toEqual(expected)
    }
  )

  test('cuts a huge user agent instead of rejecting it', () => {
    expect(cleanOrigin({ userAgent: 'x'.repeat(10_000) }).userAgent).toHaveLength(
      MAX_USER_AGENT_LENGTH
    )
  })
})

describe('actors from a request', () => {
  type Env = AppEnv & { Variables: TenantVariables & SessionVariables }

  function app(trustProxy: boolean) {
    const deps = createTestDeps({ config: { ...TEST_CONFIG, trustProxy } })
    const hono = new Hono<Env>()
    hono.use(async (c, next) => {
      c.set('deps', deps)
      c.set('tenant', { projectId: 'p1', environmentId: 'e1', apiKeyId: 'key_1' })
      c.set('session', { sub: 'user_1', sid: 'session_1' } as SessionVariables['session'])
      await next()
    })
    hono.get('/origin', (c) => c.json(requestOrigin(c)))
    hono.get('/admin', (c) => c.json(adminActor(c)))
    hono.get('/user', (c) => c.json(userActor(c)))
    return hono
  }
  const headers = { 'x-forwarded-for': 'forged, 203.0.113.7', 'user-agent': 'curl/8' }

  test('the origin is the proxy-reported IP and the user agent', async () => {
    const res = await app(true).request('/origin', { headers })
    expect(await res.json()).toEqual({ ipAddress: '203.0.113.7', userAgent: 'curl/8' })
  })

  test('an IP that cannot be determined is stored as null, never as a placeholder', async () => {
    const res = await app(false).request('/origin', { headers: { 'x-forwarded-for': '1.2.3.4' } })
    expect(await res.json()).toEqual({ ipAddress: null, userAgent: null })
  })

  test('an admin is identified by the API key, a user by the token’s subject', async () => {
    expect(await (await app(true).request('/admin', { headers })).json()).toEqual({
      type: 'admin',
      id: 'key_1',
      ipAddress: '203.0.113.7',
      userAgent: 'curl/8',
    })
    expect(await (await app(true).request('/user', { headers })).json()).toEqual({
      type: 'user',
      id: 'user_1',
      ipAddress: '203.0.113.7',
      userAgent: 'curl/8',
    })
  })
})

test('the system actor has no id and a cleaned origin', () => {
  expect(systemActor()).toEqual({ type: 'system', id: null, ipAddress: null, userAgent: null })
  expect(systemActor({ ipAddress: 'unknown', userAgent: 'cli' })).toEqual({
    type: 'system',
    id: null,
    ipAddress: null,
    userAgent: 'cli',
  })
})
