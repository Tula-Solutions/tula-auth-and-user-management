import { beforeEach, describe, expect, test } from 'bun:test'
import { DEFAULT_ENVIRONMENT_SETTINGS } from '@tula-tech/contract'
import * as Organizations from '~/modules/organization/service'
import * as Portal from '~/modules/setup-link/portal'
import { createInstanceTestDeps, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

const TENANT = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }

let deps: TestDeps

beforeEach(() => {
  deps = createInstanceTestDeps()
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  deps.outbound.point('idp.example.test', '93.184.216.34')
  deps.environmentSettings.seed(TEST_TENANT.environmentId, {
    revision: 1,
    settings: {
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      organizations: { ...DEFAULT_ENVIRONMENT_SETTINGS.organizations, enabled: true },
      sso: { enabled: true },
    } as never,
  })
})

describe('setup portal hardening (TULA-171)', () => {
  test('H-056: the portal view lists at most 50 connections', async () => {
    const org = await Organizations.create(deps, TENANT, { name: 'a', slug: 'a' }, TEST_ACTOR)
    const scope = { organizationId: org.id, expiresAt: new Date(deps.clock.now().getTime() + 1e6) }
    const input = {
      name: 'Okta',
      issuer: 'https://idp.example.test',
      clientId: 'c1',
      clientSecret: 'shh-secret',
    }
    for (let i = 0; i < 51; i++) {
      await Portal.createConnection(
        deps,
        TENANT,
        scope,
        { ...input, name: `Okta ${i}` } as never,
        TEST_ACTOR
      )
    }
    const view = await Portal.show(deps, TENANT, scope)
    expect(view.connections).toHaveLength(50)
  })
})
