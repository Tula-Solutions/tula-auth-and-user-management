import { afterEach, describe, expect, test } from 'bun:test'
import { NativeAppListSchema, NativeAppSchema } from '@tula/contract'
import { type FakeApi, fakeAndroidApp, fakeIosApp, IDS, installFakeApi } from './fake-api'

// The fake's native app routes answer as the API does where the screen can tell the
// difference (`apps/api/src/modules/native-app`: `schema.ts` and the contract for what is
// refused, `service.ts` for what a change does). These tests hold the fake to what was read
// there.

let api: FakeApi | undefined

afterEach(() => {
  api?.restore()
  api = undefined
})

/** The fake, with a dashboard session: every admin route is behind one. */
function signedIn(): FakeApi {
  api = installFakeApi()
  api.state.signedIn = true
  return api
}

const ROOT = '/v1/admin/native-apps'
const NO_SUCH = '00000000-0000-7000-8000-ffffffffffff'
const fingerprint = (byte: string) => Array.from({ length: 32 }, () => byte).join(':')
const AA = fingerprint('AA')
const BB = fingerprint('BB')
const IOS = { platform: 'ios', teamId: 'A1B2C3D4E5', bundleId: 'com.example.app' }

async function call(
  method: string,
  path: string,
  body?: unknown,
  environment: string = IDS.development
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://localhost${path}`, {
    method,
    headers: {
      'x-tula-dashboard': '1',
      'x-tula-environment': environment,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, body: text === '' ? {} : JSON.parse(text) }
}

function fields(body: Record<string, unknown>): string[] {
  return (body.errors as { field: string }[] | undefined)?.map((entry) => entry.field) ?? []
}

describe('what the API refuses before it looks, the fake refuses the same way', () => {
  test.each([
    ['GET', '/not-an-id', undefined],
    ['PATCH', '/not-an-id', { teamId: 'A1B2C3D4E5' }],
    ['DELETE', '/not-an-id', undefined],
  ])('%s %s: an id that is no UUID is 422 validation.failed', async (method, path, body) => {
    signedIn()
    const answer = await call(method, `${ROOT}${path}`, body)
    expect(answer.status).toBe(422)
    expect(answer.body.code).toBe('validation.failed')
  })

  test.each([
    ['a team in lower case', { ...IOS, teamId: 'a1b2c3d4e5' }, 'teamId'],
    ['a bundle id of one segment', { ...IOS, bundleId: 'app' }, 'bundleId'],
    [
      'a fingerprint that is not one',
      { platform: 'android', packageName: 'com.example.app', sha256CertFingerprints: ['AA'] },
      'sha256CertFingerprints.0',
    ],
  ])(
    'a registration with %s is 422 on that field, and nothing is stored',
    async (_n, body, field) => {
      const fake = signedIn()
      const answer = await call('POST', ROOT, body)
      expect(answer.status).toBe(422)
      expect(fields(answer.body)).toContain(field)
      expect(fake.state.nativeApps).toHaveLength(0)
    }
  )

  test('an update that names no field is 422, before the app is looked for', async () => {
    signedIn()
    expect((await call('PATCH', `${ROOT}/${NO_SUCH}`, {})).status).toBe(422)
    expect((await call('PATCH', `${ROOT}/${NO_SUCH}`, { teamId: 'A1B2C3D4E5' })).status).toBe(404)
    expect((await call('DELETE', `${ROOT}/${NO_SUCH}`)).status).toBe(404)
    expect((await call('GET', `${ROOT}/${NO_SUCH}`)).status).toBe(404)
  })
})

describe('what a registration and a change do', () => {
  test('an app is answered in the contract’s shape, fingerprints as a sorted set in the stored form', async () => {
    signedIn()
    const made = await call('POST', ROOT, {
      platform: 'android',
      packageName: 'com.example.app',
      sha256CertFingerprints: ['bb'.repeat(32), AA.toLowerCase()],
    })
    expect(made.status).toBe(201)
    expect(NativeAppSchema.parse(made.body)).toMatchObject({
      platform: 'android',
      sha256CertFingerprints: [AA, BB],
    })
    await call('POST', ROOT, IOS)
    const list = NativeAppListSchema.parse((await call('GET', ROOT)).body)
    expect(list.data.map((app) => app.platform)).toEqual(['android', 'ios'])
    expect((await call('GET', `${ROOT}/${made.body.id}`)).body).toEqual(made.body)
  })

  test('one app per platform and name in an environment; the same name elsewhere is another app', async () => {
    signedIn()
    expect((await call('POST', ROOT, IOS)).status).toBe(201)
    const again = await call('POST', ROOT, { ...IOS, teamId: 'ZZZZZZZZZZ' })
    expect(again.status).toBe(409)
    expect(again.body.code).toBe('resource.conflict')
    expect(again.body.params).toBeUndefined()
    expect(
      (
        await call('POST', ROOT, {
          platform: 'android',
          packageName: IOS.bundleId,
          sha256CertFingerprints: [AA],
        })
      ).status
    ).toBe(201)
    expect((await call('POST', ROOT, IOS, IDS.production)).status).toBe(201)
  })

  test('the cap is a conflict that carries the number', async () => {
    const fake = signedIn()
    for (let n = 0; n < 20; n += 1) {
      fake.state.nativeApps.push(fakeIosApp({ bundleId: `com.example.n${n}` }))
    }
    const full = await call('POST', ROOT, IOS)
    expect(full.status).toBe(409)
    expect(full.body.params).toEqual({ max: 20 })
    // Another environment's apps do not count.
    expect((await call('POST', ROOT, IOS, IDS.production)).status).toBe(201)
  })

  test('a field of the other platform is 422 on that field', async () => {
    const fake = signedIn()
    const ios = fakeIosApp()
    const android = fakeAndroidApp()
    fake.state.nativeApps.push(ios, android)
    const one = await call('PATCH', `${ROOT}/${ios.id}`, { sha256CertFingerprints: [AA] })
    expect(one.status).toBe(422)
    expect(fields(one.body)).toEqual(['sha256CertFingerprints'])
    const other = await call('PATCH', `${ROOT}/${android.id}`, { teamId: 'A1B2C3D4E5' })
    expect(other.status).toBe(422)
    expect(fields(other.body)).toEqual(['teamId'])
  })

  test('a change replaces the field; one that changes nothing moves nothing', async () => {
    const fake = signedIn()
    const ios = fakeIosApp({ updatedAt: '2026-01-01T00:00:00.000Z' })
    const android = fakeAndroidApp({
      sha256CertFingerprints: [AA],
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    fake.state.nativeApps.push(ios, android)
    const same = await call('PATCH', `${ROOT}/${ios.id}`, { teamId: 'A1B2C3D4E5' })
    expect(same.body.updatedAt).toBe('2026-01-01T00:00:00.000Z')
    const moved = await call('PATCH', `${ROOT}/${ios.id}`, { teamId: 'ZZZZZZZZZZ' })
    expect(moved.body).toMatchObject({ teamId: 'ZZZZZZZZZZ' })
    expect(moved.body.updatedAt).not.toBe('2026-01-01T00:00:00.000Z')
    const sameSet = await call('PATCH', `${ROOT}/${android.id}`, {
      sha256CertFingerprints: [AA.toLowerCase()],
    })
    expect(sameSet.body.updatedAt).toBe('2026-01-01T00:00:00.000Z')
    const wider = await call('PATCH', `${ROOT}/${android.id}`, {
      sha256CertFingerprints: [BB, AA],
    })
    expect(wider.body.sha256CertFingerprints).toEqual([AA, BB])
  })

  test('an app is found, changed and removed only under its own environment', async () => {
    const fake = signedIn()
    const ios = fakeIosApp()
    fake.state.nativeApps.push(ios)
    const path = `${ROOT}/${ios.id}`
    expect((await call('GET', path, undefined, IDS.production)).status).toBe(404)
    expect((await call('PATCH', path, { teamId: 'ZZZZZZZZZZ' }, IDS.production)).status).toBe(404)
    expect((await call('DELETE', path, undefined, IDS.production)).status).toBe(404)
    expect(fake.state.nativeApps).toHaveLength(1)
    expect((await call('GET', ROOT, undefined, IDS.production)).body).toEqual({ data: [] })
    expect((await call('DELETE', path)).status).toBe(204)
    expect(fake.state.nativeApps).toHaveLength(0)
  })
})
