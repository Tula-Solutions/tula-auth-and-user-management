import { describe, expect, test } from 'bun:test'
import { ServiceException } from '~/exceptions'
import * as Webhooks from '~/modules/webhook/service'
import { createTestDeps, TEST_ACTOR, TEST_TENANT } from '~/testing'

// H-213 (ADR 0034): update() judges an address only when it changes. An endpoint saved while
// the guard allowed it (a loopback address in the `local` tier) can still be switched off or
// retitled under a stricter guard; the send path re-checks with Outbound.request every time.
const tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const url = 'http://127.0.0.1:9/hook'

async function endpointSavedUnderLocalTier() {
  const deps = createTestDeps()
  const created = await Webhooks.create(
    deps,
    tenant,
    { url, eventTypes: ['user.deleted'], enabled: true },
    TEST_ACTOR
  )
  return { created, strict: { ...deps, outbound: { tier: 'prod' as const } } }
}

describe('update() and an address that did not change', () => {
  test('is not judged again, so a stricter guard does not block switching it off', async () => {
    const { created, strict } = await endpointSavedUnderLocalTier()
    const updated = await Webhooks.update(
      strict,
      tenant,
      created.id,
      { url, enabled: false },
      TEST_ACTOR
    )
    expect(updated.enabled).toBe(false)
    expect(updated.url).toBe(url)
  })

  test('a changed address is judged by the same guard', async () => {
    const { created, strict } = await endpointSavedUnderLocalTier()
    const error = await Webhooks.update(
      strict,
      tenant,
      created.id,
      { url: 'http://127.0.0.1:9/other' },
      TEST_ACTOR
    ).then(
      () => null,
      (caught: unknown) => caught
    )
    expect(error).toBeInstanceOf(ServiceException)
    expect((error as ServiceException).code).toBe('webhook.url_not_allowed')
  })
})
