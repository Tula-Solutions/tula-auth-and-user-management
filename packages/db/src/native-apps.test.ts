import { afterAll, beforeAll, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { nativeApps } from './schema'
import { withTenant } from './tenant'
import { createTestDatabase, createTestTenant, type TestDatabase, type TestTenant } from './testing'

let testDb: TestDatabase
let tenant: TestTenant
let other: TestTenant

beforeAll(async () => {
  testDb = await createTestDatabase()
  tenant = await createTestTenant(testDb.db)
  other = await createTestTenant(testDb.db)
})

afterAll(() => testDb.close())

type NewApp = typeof nativeApps.$inferInsert

/** A statement's outcome: Drizzle builders are thenables, not promises. */
async function refused(work: () => Promise<unknown>): Promise<string | null> {
  try {
    await work()
    return null
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause
    return String((cause as { message?: string } | undefined)?.message ?? error)
  }
}

/** A fingerprint in the stored form, every byte the same. */
const fingerprint = (byte: string) => Array.from({ length: 32 }, () => byte).join(':')
const AA = fingerprint('AA')

function ios(scope: TestTenant, overrides: Partial<NewApp> = {}): NewApp {
  return {
    id: Bun.randomUUIDv7(),
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    platform: 'ios',
    identifier: 'com.example.app',
    teamId: 'A1B2C3D4E5',
    ...overrides,
  }
}

function android(scope: TestTenant, overrides: Partial<NewApp> = {}): NewApp {
  return {
    id: Bun.randomUUIDv7(),
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    platform: 'android',
    identifier: 'com.example.app',
    sha256CertFingerprints: [AA],
    ...overrides,
  }
}

const insert = (row: NewApp) =>
  refused(() => withTenant(testDb.db, row.environmentId, (tx) => tx.insert(nativeApps).values(row)))

const clear = (scope: TestTenant) =>
  withTenant(testDb.db, scope.environmentId, (tx) => tx.delete(nativeApps))

test('an iOS app is stored with its team and no fingerprints, an Android app the other way round', async () => {
  const one = ios(tenant)
  const two = android(tenant)
  expect(await insert(one)).toBeNull()
  expect(await insert(two)).toBeNull()
  const rows = await withTenant(testDb.db, tenant.environmentId, (tx) =>
    tx
      .select()
      .from(nativeApps)
      .where(eq(nativeApps.id, one.id as string))
  )
  expect(rows[0]).toMatchObject({ teamId: 'A1B2C3D4E5', sha256CertFingerprints: [] })
  await clear(tenant)
})

test('an environment has one app per platform and identifier, and another environment its own', async () => {
  expect(await insert(ios(tenant))).toBeNull()
  expect(await insert(ios(tenant, { teamId: 'ZZZZZZZZZZ' }))).toContain(
    'native_apps_environment_platform_identifier_key'
  )
  // The same name on the other platform is another app.
  expect(await insert(android(tenant))).toBeNull()
  expect(await insert(android(tenant))).toContain('native_apps_environment_platform_identifier_key')
  expect(await insert(ios(other))).toBeNull()
  await clear(tenant)
  await clear(other)
})

test.each<[string, (scope: TestTenant) => NewApp, string]>([
  ['a platform nobody knows', (s) => ios(s, { platform: 'windows' as never }), 'platform_known'],
  ['an iOS app with no team', (s) => ios(s, { teamId: null }), 'ios_whole'],
  ['a team id in lower case', (s) => ios(s, { teamId: 'a1b2c3d4e5' }), 'ios_whole'],
  ['a team id of nine characters', (s) => ios(s, { teamId: 'A1B2C3D4E' }), 'ios_whole'],
  ['a team id with a line after it', (s) => ios(s, { teamId: 'A1B2C3D4E5\nX' }), 'ios_whole'],
  ['an iOS app with a fingerprint', (s) => ios(s, { sha256CertFingerprints: [AA] }), 'ios_whole'],
  ['an Android app with a team', (s) => android(s, { teamId: 'A1B2C3D4E5' }), 'android_whole'],
  [
    'an Android app with no fingerprint',
    (s) => android(s, { sha256CertFingerprints: [] }),
    'android_whole',
  ],
  [
    'an Android app with eleven fingerprints',
    (s) =>
      android(s, {
        sha256CertFingerprints: Array.from({ length: 11 }, (_, n) => fingerprint(`A${n % 10}`)),
      }),
    'android_whole',
  ],
  [
    'a fingerprint in lower case',
    (s) => android(s, { sha256CertFingerprints: [AA.toLowerCase()] }),
    'fingerprints_shape',
  ],
  [
    'a fingerprint of 31 bytes',
    (s) => android(s, { sha256CertFingerprints: [AA.slice(3)] }),
    'fingerprints_shape',
  ],
  [
    'a fingerprint with no colons',
    (s) => android(s, { sha256CertFingerprints: ['AA'.repeat(32)] }),
    'fingerprints_shape',
  ],
  [
    'a good fingerprint beside one that is not',
    (s) => android(s, { sha256CertFingerprints: [AA, 'nonsense'] }),
    'fingerprints_shape',
  ],
  [
    'a fingerprint with a comma inside',
    (s) => android(s, { sha256CertFingerprints: [`${AA},`] }),
    'fingerprints_shape',
  ],
  ['an identifier of one segment', (s) => ios(s, { identifier: 'app' }), 'identifier_shape'],
  [
    'an identifier with a quote',
    (s) => ios(s, { identifier: 'com.example."app' }),
    'identifier_shape',
  ],
  [
    'an identifier with a line break',
    (s) => android(s, { identifier: 'com.example.app\ncom.evil.app' }),
    'identifier_shape',
  ],
  [
    'an identifier past 255 characters',
    (s) => android(s, { identifier: `com.${'a'.repeat(252)}` }),
    'identifier_shape',
  ],
])('the database itself refuses %s', async (_name, row, constraint) => {
  expect(await insert(row(tenant))).toContain(`native_apps_${constraint}`)
})

test('a null among the fingerprints is refused', async () => {
  const outcome = await refused(() =>
    withTenant(testDb.db, tenant.environmentId, (tx) =>
      tx.insert(nativeApps).values(
        android(tenant, {
          sha256CertFingerprints: [AA, null as unknown as string],
        })
      )
    )
  )
  expect(outcome).toContain('native_apps_fingerprints_shape')
})

test('an update cannot give an app a shape an insert would be refused for', async () => {
  expect(await insert(android(tenant))).toBeNull()
  const outcome = await refused(() =>
    withTenant(testDb.db, tenant.environmentId, (tx) =>
      tx.update(nativeApps).set({ sha256CertFingerprints: ['nonsense'] })
    )
  )
  expect(outcome).toContain('native_apps_fingerprints_shape')
  expect(
    await refused(() =>
      withTenant(testDb.db, tenant.environmentId, (tx) =>
        tx.update(nativeApps).set({ sha256CertFingerprints: [] })
      )
    )
  ).toContain('native_apps_android_whole')
  await clear(tenant)
})

test('an app is seen only inside its own environment, and not at all outside one', async () => {
  expect(await insert(ios(tenant))).toBeNull()
  const theirs = await withTenant(testDb.db, other.environmentId, (tx) =>
    tx.select().from(nativeApps)
  )
  expect(theirs).toEqual([])
  expect(await testDb.db.select().from(nativeApps)).toEqual([])
  // A row of one environment cannot be written while another is set.
  expect(
    await refused(() =>
      withTenant(testDb.db, other.environmentId, (tx) => tx.insert(nativeApps).values(ios(tenant)))
    )
  ).toContain('row-level security')
  await clear(tenant)
})

test('the runtime role updates a team and fingerprints, and cannot rewrite what an app is or whose it is', async () => {
  expect(await insert(ios(tenant))).toBeNull()
  const update = (set: Partial<NewApp>) =>
    refused(() =>
      withTenant(testDb.db, tenant.environmentId, (tx) => tx.update(nativeApps).set(set))
    )
  expect(
    await update({ teamId: 'ZZZZZZZZZZ', updatedAt: new Date('2026-10-08T10:00:00.000Z') })
  ).toBeNull()
  for (const set of [
    { identifier: 'com.other.app' },
    { platform: 'android' as const },
    { id: Bun.randomUUIDv7() },
    { projectId: other.projectId },
    { environmentId: other.environmentId },
    { createdAt: new Date('2020-01-01T00:00:00.000Z') },
  ]) {
    expect(await update(set)).toContain('permission denied')
  }
  await clear(tenant)
})
