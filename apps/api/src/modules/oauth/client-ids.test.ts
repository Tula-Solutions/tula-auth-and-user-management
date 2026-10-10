import { beforeEach, describe, expect, test } from 'bun:test'
import type { OAuthProviderSettings } from '@tula/contract'
import { createApp } from '~/index'
import * as Audit from '~/modules/audit/service'
import * as OAuth from '~/modules/oauth/service'
import type { OAuthProviderRecord } from '~/ports/oauth-provider-store'
import { createTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'

// The client ids, beside a provider's own, that an environment accepts an ID token for
// (ADR 0045): what an operator may save, what is recorded of it, and what is read back.

const SK = 'tula_sk_dev_secret000000000000000000000000'
const WEB = '1234567890-webclient.apps.googleusercontent.com'
const ANDROID = '1234567890-androidclient.apps.googleusercontent.com'
const IOS = '1234567890-iosclient.apps.googleusercontent.com'

let deps: TestDeps
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  deps = createTestDeps()
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  await seedApiKey(deps, SK)
  app = createApp(deps)
})

function put(provider: string, body: Record<string, unknown>) {
  return app.request(`/v1/admin/oauth-providers/${provider}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${SK}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const google = (body: Record<string, unknown> = {}) =>
  put('google', { clientId: WEB, clientSecret: 'GOCSPX-a-client-secret-value', ...body })

/** A later write: the secret left out, so that it is not among what changed. */
const change = (body: Record<string, unknown> = {}) => put('google', { clientId: WEB, ...body })

const saved = async (res: Response | Promise<Response>) =>
  (await (await res).json()) as OAuthProviderSettings

const lastEntry = () =>
  deps.activityLog.entries.findLast((entry) => entry.type === 'oauth_provider.updated')?.data

const stored = () =>
  deps.oauthProviders.find(TEST_TENANT.environmentId, 'google') as Promise<OAuthProviderRecord>

describe('saving the client ids an ID token may be for', () => {
  test('a provider saved without them has none', async () => {
    const res = await google()
    expect(res.status).toBe(200)
    expect((await saved(res)).additionalClientIds).toEqual([])
    expect((await stored()).config).toEqual({})
    expect(lastEntry()).toEqual({
      provider: 'google',
      changed: ['clientId', 'secret', 'enabled'],
      created: true,
    })
  })

  test('they are stored and answered as a sorted set, whatever order they were typed in', async () => {
    const answer = await saved(google({ additionalClientIds: [IOS, ANDROID] }))
    expect(answer.additionalClientIds).toEqual([ANDROID, IOS])
    expect((await stored()).config).toEqual({ additionalClientIds: [ANDROID, IOS] })
    const listed = (await (
      await app.request('/v1/admin/oauth-providers', {
        headers: { authorization: `Bearer ${SK}` },
      })
    ).json()) as { data: OAuthProviderSettings[] }
    expect(listed.data.find((row) => row.provider === 'google')?.additionalClientIds).toEqual([
      ANDROID,
      IOS,
    ])
  })

  test('the list is the whole set on every write: left out, there are none', async () => {
    await google({ additionalClientIds: [ANDROID, IOS] })
    expect((await saved(change())).additionalClientIds).toEqual([])
    expect((await stored()).config).toEqual({})
    expect(lastEntry()).toEqual({
      provider: 'google',
      changed: ['additionalClientIds'],
      additionalClientIdCount: 0,
    })
  })

  test.each<[string, unknown]>([
    ['not a Google client id', ['com.example.app']],
    ['a client id with upper case', ['1234567890-ABC.apps.googleusercontent.com']],
    ['a look-alike host', ['1234567890-abc.apps.googleusercontent.com.evil.test']],
    ['a URL', ['https://1234567890-abc.apps.googleusercontent.com']],
    ['a wildcard', ['*.apps.googleusercontent.com']],
    ['white space around one', [` ${ANDROID}`]],
    ['an empty entry', ['']],
    ['the same id twice', [ANDROID, ANDROID]],
    ['not a list', ANDROID],
    [
      'one more than the cap',
      Array.from({ length: 9 }, (_, i) => `${i + 1}-app.apps.googleusercontent.com`),
    ],
  ])('refused with a 422 and nothing stored: %s', async (_name, additionalClientIds) => {
    const res = await google({ additionalClientIds })
    expect(res.status).toBe(422)
    expect(await deps.oauthProviders.find(TEST_TENANT.environmentId, 'google')).toBeNull()
    expect(lastEntry()).toBeUndefined()
  })

  test('the cap itself is accepted', async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `${i + 1}-app.apps.googleusercontent.com`)
    expect((await saved(google({ additionalClientIds: ids }))).additionalClientIds).toHaveLength(8)
  })

  test.each([
    ['github', { clientId: 'gh', clientSecret: 'secret-value' }],
    ['microsoft', { clientId: 'ms', clientSecret: 'secret-value', tenant: 'common' }],
  ])('a provider that exchanges no ID token takes none: %s', async (provider, body) => {
    const res = await put(provider, { ...body, additionalClientIds: [ANDROID] })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ errors: [{ field: 'additionalClientIds' }] })
    // An empty list is refused too: the field is not this provider's.
    expect((await put(provider, { ...body, additionalClientIds: [] })).status).toBe(422)
    expect((await put(provider, body)).status).toBe(200)
  })
})

describe('what is recorded of a change', () => {
  test('a client id gained is a weakening; the entry holds a count and never an id', async () => {
    await google()
    await change({ additionalClientIds: [ANDROID] })
    expect(lastEntry()).toEqual({
      provider: 'google',
      changed: ['additionalClientIds'],
      additionalClientIdCount: 1,
      weakened: true,
    })
    const recorded = JSON.stringify(deps.activityLog.entries)
    expect(recorded).not.toContain(ANDROID)
    expect(recorded).not.toContain('googleusercontent')
  })

  test('one swapped for another is a weakening too: the count alone would not show it', async () => {
    await google({ additionalClientIds: [ANDROID] })
    await change({ additionalClientIds: [IOS] })
    expect(lastEntry()).toEqual({
      provider: 'google',
      changed: ['additionalClientIds'],
      additionalClientIdCount: 1,
      weakened: true,
    })
  })

  test('one taken away is recorded and is not a weakening', async () => {
    await google({ additionalClientIds: [ANDROID, IOS] })
    await change({ additionalClientIds: [IOS] })
    expect(lastEntry()).toEqual({
      provider: 'google',
      changed: ['additionalClientIds'],
      additionalClientIdCount: 1,
    })
  })

  test('the same set in another order is no change', async () => {
    await google({ additionalClientIds: [ANDROID, IOS] })
    await change({ additionalClientIds: [IOS, ANDROID] })
    expect(lastEntry()).toEqual({ provider: 'google', changed: [] })
  })

  test('a provider created with client ids says so once', async () => {
    await google({ additionalClientIds: [ANDROID] })
    expect(lastEntry()).toEqual({
      provider: 'google',
      changed: ['clientId', 'secret', 'additionalClientIds', 'enabled'],
      created: true,
      additionalClientIdCount: 1,
      weakened: true,
    })
  })
})

describe('reading a stored row', () => {
  async function tamper(config: Record<string, unknown>) {
    await google()
    const row = await stored()
    await deps.oauthProviders.upsert(
      { ...row, config: config as OAuthProviderRecord['config'] },
      Audit.none('fixture')
    )
  }

  test.each<[string, unknown, string[]]>([
    ['entries that are not client ids are left out', [ANDROID, 'com.example', 7, null], [ANDROID]],
    ['a repeat counts once', [IOS, IOS, ANDROID], [ANDROID, IOS]],
    ['a value that is no list means none', 'everything', []],
    [
      'no more than the cap is read',
      Array.from({ length: 12 }, (_, i) => `${i + 10}-app.apps.googleusercontent.com`),
      Array.from({ length: 12 }, (_, i) => `${i + 10}-app.apps.googleusercontent.com`)
        .sort()
        .slice(0, 8),
    ],
  ])('%s', async (_name, value, expected) => {
    await tamper({ additionalClientIds: value })
    const res = await app.request('/v1/admin/oauth-providers', {
      headers: { authorization: `Bearer ${SK}` },
    })
    expect(res.status).toBe(200)
    const listed = (await res.json()) as { data: OAuthProviderSettings[] }
    expect(listed.data.find((row) => row.provider === 'google')?.additionalClientIds).toEqual(
      expected
    )
    const credentials = await OAuth.credentials(deps, TEST_TENANT, 'google')
    expect(await OAuth.idTokenAudiences(deps, TEST_TENANT, 'google', credentials)).toEqual([
      WEB,
      ...expected,
    ])
  })

  test('a stored entry that is the provider’s own client id is left out, not a failed read', async () => {
    // A row from before the rule, or changed in the database: the own id is accepted as
    // the own id, once, and is not listed as an additional one.
    await tamper({ additionalClientIds: [WEB, ANDROID] })
    const res = await app.request('/v1/admin/oauth-providers', {
      headers: { authorization: `Bearer ${SK}` },
    })
    expect(res.status).toBe(200)
    const listed = (await res.json()) as { data: OAuthProviderSettings[] }
    expect(listed.data.find((row) => row.provider === 'google')?.additionalClientIds).toEqual([
      ANDROID,
    ])
    const credentials = await OAuth.credentials(deps, TEST_TENANT, 'google')
    expect(await OAuth.idTokenAudiences(deps, TEST_TENANT, 'google', credentials)).toEqual([
      WEB,
      ANDROID,
    ])
    // And the next save is judged against what the read gave: nothing gained, one id.
    await change({ additionalClientIds: [ANDROID] })
    expect(lastEntry()).toEqual({ provider: 'google', changed: [] })
  })
})

describe('the provider’s own client id among the additional ones', () => {
  test.each<[string, string[], string]>([
    ['alone', [WEB], 'additionalClientIds.0'],
    ['after another', [ANDROID, WEB], 'additionalClientIds.1'],
  ])('is refused at save, on the field, with nothing stored: %s', async (_name, ids, field) => {
    const res = await google({ additionalClientIds: ids })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { errors: { field: string; message: string }[] }
    expect(body.errors.map((error) => error.field)).toEqual([field])
    // The entry is named by its place, never repeated.
    expect(JSON.stringify(body)).not.toContain('googleusercontent')
    expect(await deps.oauthProviders.find(TEST_TENANT.environmentId, 'google')).toBeNull()
    expect(lastEntry()).toBeUndefined()
  })

  test('is refused when it is the client id that changes to a listed one, and the row stays', async () => {
    await google({ additionalClientIds: [ANDROID] })
    const res = await put('google', { clientId: ANDROID, additionalClientIds: [ANDROID] })
    expect(res.status).toBe(422)
    expect(await stored()).toMatchObject({
      clientId: WEB,
      config: { additionalClientIds: [ANDROID] },
    })
  })

  test('an id that only resembles the own one is another id', async () => {
    const res = await google({ additionalClientIds: [`${WEB.slice(0, -27)}x${WEB.slice(-27)}`] })
    expect(res.status).toBe(200)
  })
})
