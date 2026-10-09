import { beforeEach, describe, expect, test } from 'bun:test'
import { MAX_NATIVE_APPS, type NativeApp } from '@tula/contract'
import { createApp, OPENAPI_PATH } from '~/index'
import { ASSOCIATION_MAX_AGE_SECONDS } from '~/modules/native-app/service'
import { createTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'

const SK = 'tula_sk_dev_secret000000000000000000000000'
const OTHER_SK = 'tula_sk_live_secret00000000000000000000000'
const PK = 'tula_pk_dev_publishable0000000000000000000'

const fingerprint = (byte: string) => Array.from({ length: 32 }, () => byte).join(':')
const AA = fingerprint('AA')
const BB = fingerprint('BB')
const IOS = { platform: 'ios', teamId: 'A1B2C3D4E5', bundleId: 'com.example.app' } as const
const ANDROID = {
  platform: 'android',
  packageName: 'com.example.app',
  sha256CertFingerprints: [AA],
} as const

let deps: TestDeps
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  deps = createTestDeps()
  for (const [id, kind] of [
    [TEST_TENANT.environmentId, 'development'],
    [TEST_TENANT.productionEnvironmentId, 'production'],
  ] as const) {
    deps.environments.add({
      id,
      projectId: TEST_TENANT.projectId,
      kind,
      createdAt: deps.clock.now(),
    })
  }
  await seedApiKey(deps, SK)
  await seedApiKey(deps, PK)
  await seedApiKey(deps, OTHER_SK, { environmentId: TEST_TENANT.productionEnvironmentId })
  app = createApp(deps)
})

function admin(method: string, path = '', body?: unknown, key: string | null = SK) {
  return app.request(`/v1/admin/native-apps${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(key !== null && { authorization: `Bearer ${key}` }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
}

const json = async <T>(res: Response) => (await res.json()) as T

async function registered(body: Record<string, unknown> = IOS, key = SK): Promise<NativeApp> {
  const res = await admin('POST', '', body, key)
  expect(res.status).toBe(201)
  return json<NativeApp>(res)
}

const actions = () => deps.activityLog.entries.map((entry) => entry.type)
const file = (
  name: string,
  environmentId: string = TEST_TENANT.environmentId,
  init?: RequestInit
) => app.request(`/v1/environments/${environmentId}/.well-known/${name}`, init)

describe('POST /v1/admin/native-apps', () => {
  test('registers an iOS app and an Android app, each read back as it was written', async () => {
    const ios = await registered(IOS)
    expect(ios).toMatchObject(IOS)
    expect(Object.keys(ios).sort()).toEqual(
      ['bundleId', 'createdAt', 'id', 'platform', 'teamId', 'updatedAt'].sort()
    )
    const android = await registered(ANDROID)
    expect(android).toMatchObject(ANDROID)
    expect(Object.keys(android).sort()).toEqual(
      ['createdAt', 'id', 'packageName', 'platform', 'sha256CertFingerprints', 'updatedAt'].sort()
    )
    const listed = await json<{ data: NativeApp[] }>(await admin('GET'))
    expect(listed.data.map((one) => one.id).sort()).toEqual([ios.id, android.id].sort())
    expect(await json<NativeApp>(await admin('GET', `/${android.id}`))).toEqual(android)
    expect(actions()).toEqual(['native_app.created', 'native_app.created'])
  })

  test('stores a fingerprint upper case with colons, however it was pasted, each once and sorted', async () => {
    const created = await registered({
      ...ANDROID,
      sha256CertFingerprints: ['bb'.repeat(32), AA.toLowerCase()],
    })
    expect(created).toMatchObject({ sha256CertFingerprints: [AA, BB] })
  })

  test.each([
    ['a team id in lower case', { ...IOS, teamId: 'a1b2c3d4e5' }],
    ['a bundle id of one segment', { ...IOS, bundleId: 'app' }],
    ['a bundle id with a wildcard', { ...IOS, bundleId: 'com.example.*' }],
    ['an iOS app with fingerprints', { ...IOS, sha256CertFingerprints: [AA] }],
    ['an iOS app with paths of its own', { ...IOS, paths: ['/*'] }],
    ['a package name of one segment', { ...ANDROID, packageName: 'app' }],
    ['a package name with a hyphen', { ...ANDROID, packageName: 'com.example.my-app' }],
    ['an Android app with no fingerprint', { ...ANDROID, sha256CertFingerprints: [] }],
    ['a fingerprint that is not one', { ...ANDROID, sha256CertFingerprints: ['nonsense'] }],
    ['a SHA-1 fingerprint', { ...ANDROID, sha256CertFingerprints: [AA.slice(0, 59)] }],
    ['the same fingerprint twice', { ...ANDROID, sha256CertFingerprints: [AA, 'aa'.repeat(32)] }],
    ['an Android app with a team', { ...ANDROID, teamId: 'A1B2C3D4E5' }],
    ['a relation of the caller’s own', { ...ANDROID, relation: ['handle_all_urls'] }],
    [
      'an environment of the caller’s own',
      { ...IOS, environmentId: TEST_TENANT.productionEnvironmentId },
    ],
    ['a platform nobody knows', { ...IOS, platform: 'windows' }],
    ['no platform', { teamId: IOS.teamId, bundleId: IOS.bundleId }],
  ])('refuses %s as a validation error and stores nothing', async (_name, body) => {
    const res = await admin('POST', '', body)
    expect(res.status).toBe(422)
    expect((await json<{ code: string }>(res)).code).toBe('validation.failed')
    expect(await deps.nativeApps.list(TEST_TENANT.environmentId)).toEqual([])
    expect(actions()).toEqual([])
  })

  test('refuses an app the environment already has, and says so without storing or recording', async () => {
    const first = await registered(IOS)
    const res = await admin('POST', '', { ...IOS, teamId: 'ZZZZZZZZZZ' })
    expect(res.status).toBe(409)
    expect((await json<{ code: string }>(res)).code).toBe('resource.conflict')
    expect(await json<{ data: NativeApp[] }>(await admin('GET'))).toEqual({ data: [first] })
    expect(actions()).toEqual(['native_app.created'])
    // The same name on the other platform, and in another environment, is another app.
    await registered({ ...ANDROID, packageName: IOS.bundleId })
    await registered(IOS, OTHER_SK)
  })

  test('refuses one app more than an environment may have', async () => {
    for (let n = 0; n < MAX_NATIVE_APPS; n += 1) {
      await registered({ ...IOS, bundleId: `com.example.app${n}` })
    }
    const res = await admin('POST', '', ANDROID)
    expect(res.status).toBe(409)
    expect(await json<{ code: string; params: unknown }>(res)).toMatchObject({
      code: 'resource.conflict',
      params: { max: MAX_NATIVE_APPS },
    })
    expect(await deps.nativeApps.list(TEST_TENANT.environmentId)).toHaveLength(MAX_NATIVE_APPS)
    // Another environment has its own count.
    await registered(ANDROID, OTHER_SK)
  })

  test('records which platform and how many fingerprints, and nothing that names the app', async () => {
    await registered({ ...ANDROID, sha256CertFingerprints: [AA, BB] })
    const [entry] = deps.activityLog.entries
    expect(entry).toMatchObject({
      type: 'native_app.created',
      target: { type: 'native_app' },
      data: { platform: 'android', fingerprints: 2, weakened: true },
    })
    const text = JSON.stringify(deps.activityLog.entries)
    expect(text).not.toContain(ANDROID.packageName)
    expect(text).not.toContain(AA)
  })

  test.each([
    ['no key', null, 401],
    ['a publishable key', PK, 401],
  ])('is refused with %s', async (_name, key, status) => {
    expect((await admin('POST', '', IOS, key)).status).toBe(status)
    expect((await admin('GET', '', undefined, key)).status).toBe(status)
    expect(await deps.nativeApps.list(TEST_TENANT.environmentId)).toEqual([])
  })
})

describe('PATCH /v1/admin/native-apps/:id', () => {
  test('replaces an Android app’s fingerprints and says a fingerprint more is a weakening', async () => {
    const created = await registered(ANDROID)
    const res = await admin('PATCH', `/${created.id}`, {
      sha256CertFingerprints: [BB.toLowerCase(), AA],
    })
    expect(res.status).toBe(200)
    expect(await json<NativeApp>(res)).toMatchObject({ sha256CertFingerprints: [AA, BB] })
    expect(deps.activityLog.entries.at(-1)).toMatchObject({
      type: 'native_app.updated',
      data: {
        platform: 'android',
        changed: ['sha256CertFingerprints'],
        fingerprints: 2,
        weakened: true,
      },
    })
    // Taking one away widens nothing.
    await admin('PATCH', `/${created.id}`, { sha256CertFingerprints: [BB] })
    const narrowed = deps.activityLog.entries.at(-1)
    expect(narrowed).toMatchObject({ type: 'native_app.updated', data: { fingerprints: 1 } })
    expect(narrowed?.data).not.toHaveProperty('weakened')
    expect(JSON.stringify(deps.activityLog.entries)).not.toContain(BB)
  })

  test('moves an iOS app to another team, recorded as a weakening without the team', async () => {
    const created = await registered(IOS)
    const res = await admin('PATCH', `/${created.id}`, { teamId: 'ZZZZZZZZZZ' })
    expect(await json<NativeApp>(res)).toMatchObject({
      teamId: 'ZZZZZZZZZZ',
      bundleId: IOS.bundleId,
    })
    expect(deps.activityLog.entries.at(-1)).toMatchObject({
      type: 'native_app.updated',
      data: { platform: 'ios', changed: ['teamId'], fingerprints: 0, weakened: true },
    })
    expect(JSON.stringify(deps.activityLog.entries)).not.toContain('ZZZZZZZZZZ')
  })

  test('a request that changes nothing writes and records nothing', async () => {
    const created = await registered(ANDROID)
    const res = await admin('PATCH', `/${created.id}`, {
      sha256CertFingerprints: ['aa'.repeat(32)],
    })
    expect(await json<NativeApp>(res)).toEqual(created)
    expect(actions()).toEqual(['native_app.created'])
  })

  test('refuses the field of the other platform, and what an app is', async () => {
    const ios = await registered(IOS)
    const android = await registered(ANDROID)
    for (const [id, body] of [
      [ios.id, { sha256CertFingerprints: [AA] }],
      [android.id, { teamId: 'A1B2C3D4E5' }],
      [ios.id, { bundleId: 'com.other.app' }],
      [android.id, { packageName: 'com.other.app' }],
      [android.id, { platform: 'ios' }],
      [android.id, { sha256CertFingerprints: [] }],
      [android.id, {}],
    ] as const) {
      const res = await admin('PATCH', `/${id}`, body)
      expect(res.status).toBe(422)
      expect((await json<{ code: string }>(res)).code).toBe('validation.failed')
    }
    expect(await json<NativeApp>(await admin('GET', `/${ios.id}`))).toEqual(ios)
    expect(await json<NativeApp>(await admin('GET', `/${android.id}`))).toEqual(android)
    expect(actions()).toEqual(['native_app.created', 'native_app.created'])
  })
})

describe('DELETE /v1/admin/native-apps/:id', () => {
  test('removes the app, recorded by platform and not as a weakening', async () => {
    const created = await registered(IOS)
    expect((await admin('DELETE', `/${created.id}`)).status).toBe(204)
    expect((await admin('GET', `/${created.id}`)).status).toBe(404)
    expect((await admin('DELETE', `/${created.id}`)).status).toBe(404)
    expect(deps.activityLog.entries.at(-1)).toMatchObject({
      type: 'native_app.deleted',
      data: { platform: 'ios' },
    })
    expect(actions()).toEqual(['native_app.created', 'native_app.deleted'])
  })
})

describe('an app of another environment', () => {
  test('is not read, changed or removed with this environment’s key, and answers as an unknown one', async () => {
    const theirs = await registered(ANDROID, OTHER_SK)
    const unknown = Bun.randomUUIDv7()
    for (const id of [theirs.id, unknown]) {
      expect((await admin('GET', `/${id}`)).status).toBe(404)
      expect((await admin('PATCH', `/${id}`, { sha256CertFingerprints: [BB] })).status).toBe(404)
      expect((await admin('DELETE', `/${id}`)).status).toBe(404)
    }
    expect(await json<{ data: NativeApp[] }>(await admin('GET'))).toEqual({ data: [] })
    expect(await json<NativeApp>(await admin('GET', `/${theirs.id}`, undefined, OTHER_SK))).toEqual(
      theirs
    )
    expect((await admin('GET', '/not-a-uuid')).status).toBe(422)
  })
})

describe('the association files', () => {
  test('name the environment’s apps, without a key, as cacheable JSON that is not sniffed', async () => {
    await registered(IOS)
    await registered({ ...IOS, bundleId: 'com.example.second', teamId: 'ZZZZZZZZZZ' })
    await registered({ ...ANDROID, sha256CertFingerprints: [BB, AA] })
    const apple = await file('apple-app-site-association')
    expect(apple.status).toBe(200)
    expect(apple.redirected).toBe(false)
    expect(apple.headers.get('content-type')).toMatch(/^application\/json\b/)
    expect(apple.headers.get('cache-control')).toBe(
      `public, max-age=${ASSOCIATION_MAX_AGE_SECONDS}`
    )
    expect(apple.headers.get('x-content-type-options')).toBe('nosniff')
    expect(apple.headers.get('set-cookie')).toBeNull()
    expect(await apple.json()).toEqual({
      webcredentials: { apps: ['A1B2C3D4E5.com.example.app', 'ZZZZZZZZZZ.com.example.second'] },
    })
    const links = await file('assetlinks.json')
    expect(links.status).toBe(200)
    expect(links.headers.get('content-type')).toMatch(/^application\/json\b/)
    expect(links.headers.get('cache-control')).toBe(
      `public, max-age=${ASSOCIATION_MAX_AGE_SECONDS}`
    )
    expect(links.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await links.json()).toEqual([
      {
        relation: ['delegate_permission/common.get_login_creds'],
        target: {
          namespace: 'android_app',
          package_name: 'com.example.app',
          sha256_cert_fingerprints: [AA, BB],
        },
      },
    ])
  })

  test('grant nothing for an environment with no app: no section, no statement', async () => {
    expect(await (await file('apple-app-site-association')).json()).toEqual({})
    expect(await (await file('assetlinks.json')).json()).toEqual([])
    // An app of one platform is in that platform's file only.
    await registered(ANDROID)
    expect(await (await file('apple-app-site-association')).json()).toEqual({})
  })

  test('follow a change and a removal', async () => {
    const created = await registered(ANDROID)
    await admin('PATCH', `/${created.id}`, { sha256CertFingerprints: [BB] })
    expect(JSON.stringify(await (await file('assetlinks.json')).json())).not.toContain(AA)
    await admin('DELETE', `/${created.id}`)
    expect(await (await file('assetlinks.json')).json()).toEqual([])
  })

  test('hold only the apps of the environment in the path, whatever else the request says', async () => {
    await registered(IOS)
    await registered(ANDROID)
    await registered({ ...IOS, bundleId: 'com.other.tenant' }, OTHER_SK)
    await registered({ ...ANDROID, packageName: 'com.other.tenant' }, OTHER_SK)
    const other = TEST_TENANT.productionEnvironmentId
    // A key, a header or a query of another environment chooses nothing.
    const pointing: RequestInit = {
      headers: {
        authorization: `Bearer ${OTHER_SK}`,
        'x-tula-environment': other,
        'x-tula-publishable-key': PK,
        host: 'other.example.com',
        'x-forwarded-host': 'other.example.com',
      },
    }
    for (const name of ['apple-app-site-association', 'assetlinks.json']) {
      const mine = await (await file(name)).text()
      expect(mine).toContain('com.example.app')
      expect(mine).not.toContain('com.other.tenant')
      expect(await (await file(name, TEST_TENANT.environmentId, pointing)).text()).toBe(mine)
      const withQuery = await app.request(
        `/v1/environments/${TEST_TENANT.environmentId}/.well-known/${name}?environmentId=${other}`
      )
      expect(await withQuery.text()).toBe(mine)
      const theirs = await (await file(name, other)).text()
      expect(theirs).toContain('com.other.tenant')
      expect(theirs).not.toContain('com.example.app')
    }
  })

  test('answer 404 for an unknown environment and 422 for a malformed id, as its JWKS does', async () => {
    for (const name of ['apple-app-site-association', 'assetlinks.json']) {
      const unknown = await file(name, Bun.randomUUIDv7())
      expect(unknown.status).toBe(404)
      expect((await json<{ code: string }>(unknown)).code).toBe('resource.not_found')
      expect(unknown.headers.get('cache-control')).toBeNull()
      expect((await file(name, 'not-a-uuid')).status).toBe(422)
    }
  })

  test('are read only: no method writes through them', async () => {
    for (const name of ['apple-app-site-association', 'assetlinks.json']) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        expect((await file(name, TEST_TENANT.environmentId, { method })).status).toBe(404)
      }
    }
  })

  test('are not at the root of the API’s own host: no environment is chosen from a request', async () => {
    await registered(IOS)
    for (const path of [
      '/.well-known/apple-app-site-association',
      '/.well-known/assetlinks.json',
      '/apple-app-site-association',
    ]) {
      expect((await app.request(path, { headers: { host: 'app.example.com' } })).status).toBe(404)
    }
  })
})

describe('the OpenAPI document', () => {
  test('publishes the admin routes behind the secret key and the two files as public', async () => {
    const doc = (await (await app.request(OPENAPI_PATH)).json()) as {
      paths: Record<string, Record<string, { operationId: string; security: unknown[] }>>
    }
    const files = '/v1/environments/{environmentId}/.well-known'
    expect(doc.paths[`${files}/apple-app-site-association`]?.get).toMatchObject({
      operationId: 'getAppleAppSiteAssociation',
      security: [],
    })
    expect(doc.paths[`${files}/assetlinks.json`]?.get).toMatchObject({
      operationId: 'getAssetLinks',
      security: [],
    })
    expect(doc.paths['/v1/admin/native-apps']?.post?.operationId).toBe('createNativeApp')
    expect(doc.paths['/v1/admin/native-apps/{id}']?.patch?.operationId).toBe('updateNativeApp')
  })
})
