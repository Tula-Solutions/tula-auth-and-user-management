import { expect, test } from 'bun:test'
import { DEFAULT_ENVIRONMENT_SETTINGS } from '@tula-tech/contract'
import { cacheEnvironmentSettings } from '~/adapters/cache/environment-settings'
import { createApp } from '~/index'
import * as Settings from '~/modules/settings/service'
import { createInstanceTestDeps, seedApiKey, TEST_TENANT } from '~/testing'

const AK = 'tula_ak_dev_agent000000000000000000000000000000'

const withOptIn = (on: boolean) => ({
  revision: 1,
  settings: {
    ...DEFAULT_ENVIRONMENT_SETTINGS,
    agents: { ...DEFAULT_ENVIRONMENT_SETTINGS.agents, proposalsInProduction: on },
  },
})

async function production() {
  const deps = createInstanceTestDeps()
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'production',
    createdAt: deps.clock.now(),
  })
  await seedApiKey(deps, AK)
  const base = deps.environmentSettings
  base.seed(TEST_TENANT.environmentId, withOptIn(true))
  // Another instance (or a replace that missed this cache) changes the base store behind it.
  Object.assign(deps, { environmentSettings: cacheEnvironmentSettings(base, deps.clock, 30_000) })
  await Settings.get(deps, TEST_TENANT)
  base.seed(TEST_TENANT.environmentId, withOptIn(false))
  return deps
}

// H-186: a decision that weakens or authorizes something reads settings past the cache.
test('a fresh read sees a change the cached read has not yet', async () => {
  const deps = await production()
  expect((await Settings.get(deps, TEST_TENANT)).settings.agents.proposalsInProduction).toBe(true)
  expect((await Settings.get(deps, TEST_TENANT, true)).settings.agents.proposalsInProduction).toBe(
    false
  )
})

test('a proposal in production is refused once the opt-in is off, though the cache says on', async () => {
  const deps = await production()
  const res = await createApp(deps).request('/v1/agent/proposals', {
    method: 'POST',
    headers: { authorization: `Bearer ${AK}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      operation: 'ban_user',
      target: { type: 'user', id: '00000000-0000-7000-8000-000000000001' },
    }),
  })
  expect(res.status).toBe(403)
  expect(await res.json()).toMatchObject({ params: { reason: 'production_environment' } })
})
