import { beforeEach, expect, test } from 'bun:test'
import type { Tenant } from '~/dependencies'
import { ValidationError } from '~/exceptions'
import * as NativeApps from '~/modules/native-app/service'
import { createTestDeps, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

const tenant: Tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const AA = Array.from({ length: 32 }, () => 'AA').join(':')

let deps: TestDeps

beforeEach(() => {
  deps = createTestDeps()
  deps.environments.add({
    id: tenant.environmentId,
    projectId: tenant.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
})

test('an update whose fingerprints are all invalid is refused and keeps the stored set (H-180)', async () => {
  const app = await NativeApps.create(
    deps,
    tenant,
    { platform: 'android', packageName: 'com.example.app', sha256CertFingerprints: [AA] },
    TEST_ACTOR
  )
  await expect(
    NativeApps.update(
      deps,
      tenant,
      app.id,
      { sha256CertFingerprints: ['not-a-fingerprint'] },
      TEST_ACTOR
    )
  ).rejects.toBeInstanceOf(ValidationError)
  const kept = (await NativeApps.list(deps, tenant)).find((a) => a.id === app.id)
  expect(kept?.platform === 'android' && kept.sha256CertFingerprints).toEqual([AA])
})
