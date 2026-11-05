import { beforeEach, describe, expect, test } from 'bun:test'
import { DEFAULT_ENVIRONMENT_SETTINGS, SETUP_LINK_HEADER } from '@tula-tech/contract'
import { createApp } from '~/index'
import * as Organizations from '~/modules/organization/service'
import * as Portal from '~/modules/setup-link/portal'
import * as SetupLinks from '~/modules/setup-link/service'
import * as SsoConnections from '~/modules/sso-connection/service'
import {
  createInstanceTestDeps,
  seedApiKey,
  TEST_ACTOR,
  TEST_TENANT,
  type TestDeps,
} from '~/testing'

const TENANT = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }

const PK = 'tula_pk_dev_publishable0000000000000000000'

let deps: TestDeps

beforeEach(async () => {
  deps = createInstanceTestDeps()
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  await seedApiKey(deps, PK)
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
    // The admin path has no cap, so it can build the 51 the portal view must still cut to 50.
    for (let i = 0; i < 51; i++) {
      await SsoConnections.create(
        deps,
        TENANT,
        { ...input, name: `Okta ${i}`, organizationId: org.id, defaultRole: 'member' } as never,
        TEST_ACTOR
      )
    }
    const view = await Portal.show(deps, TENANT, scope)
    expect(view.connections).toHaveLength(50)
  })

  // H-061: the middleware checks only the link; each portal route must still refuse when SSO is
  // off, so a new route cannot skip the check unnoticed. The list is the router's route table.
  test('H-061: with SSO switched off every portal route answers sso.disabled', async () => {
    const org = await Organizations.create(deps, TENANT, { name: 'a', slug: 'a' }, TEST_ACTOR)
    const made = await SetupLinks.create(
      deps,
      TENANT,
      { organizationId: org.id, name: 'IT', expiresInDays: 7 } as never,
      TEST_ACTOR
    )
    deps.environmentSettings.seed(TEST_TENANT.environmentId, {
      revision: 2,
      settings: {
        ...DEFAULT_ENVIRONMENT_SETTINGS,
        organizations: { ...DEFAULT_ENVIRONMENT_SETTINGS.organizations, enabled: true },
        sso: { enabled: false },
      } as never,
    })
    const id = Bun.randomUUIDv7()
    const routes: [string, string][] = [
      ['GET', ''],
      ['POST', '/connections'],
      ['POST', '/scim-tokens'],
      ['GET', `/connections/${id}`],
      ['PATCH', `/connections/${id}`],
      ['POST', `/connections/${id}/refresh-metadata`],
      ['GET', `/connections/${id}/group-roles`],
      ['PUT', `/connections/${id}/group-roles`],
      ['POST', `/connections/${id}/tests`],
      ['GET', `/connections/${id}/tests/${id}`],
    ]
    for (const [method, path] of routes) {
      const res = await createApp(deps).request(`/v1/setup${path}`, {
        method,
        headers: { [SETUP_LINK_HEADER]: made.token, 'content-type': 'application/json' },
        ...(method === 'GET' ? {} : { body: '{}' }),
      })
      const json = (await res.json()) as { code?: string }
      // An id route checks ownership first and a write route validates its body first, so neither reaches the SSO check with an empty body.
      expect(`${method} ${path} ${json.code}`).toMatch(
        / (sso\.disabled|sso\.connection_not_found|validation\.failed)$/
      )
    }
  })
})

describe('setup portal per-link limits (TULA-171)', () => {
  test('H-048: one link exhausting its SCIM-token budget leaves another link in the environment untouched', async () => {
    const mint = async (slug: string) => {
      const org = await Organizations.create(deps, TENANT, { name: slug, slug }, TEST_ACTOR)
      return SetupLinks.create(
        deps,
        TENANT,
        { organizationId: org.id, name: 'IT', expiresInDays: 7 } as never,
        TEST_ACTOR
      )
    }
    const [a, b] = [await mint('a'), await mint('b')]
    const post = (token: string) =>
      createApp(deps).request('/v1/setup/scim-tokens', {
        method: 'POST',
        headers: { [SETUP_LINK_HEADER]: token, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Okta' }),
      })
    const statuses: number[] = []
    for (let i = 0; i < 14; i++) {
      statuses.push((await post(a.token)).status)
    }
    expect(statuses).toContain(429)
    expect((await post(b.token)).status).not.toBe(429)
  })
})

describe('setup portal connection cap (TULA-171)', () => {
  test('H-047: a link holder cannot create more than 50 connections for the organization', async () => {
    const org = await Organizations.create(deps, TENANT, { name: 'a', slug: 'a' }, TEST_ACTOR)
    const scope = { organizationId: org.id, expiresAt: new Date(deps.clock.now().getTime() + 1e6) }
    const input = {
      name: 'Okta',
      issuer: 'https://idp.example.test',
      clientId: 'c1',
      clientSecret: 'shh-secret',
    }
    for (let i = 0; i < 50; i++) {
      await Portal.createConnection(
        deps,
        TENANT,
        scope,
        { ...input, name: `Okta ${i}` } as never,
        TEST_ACTOR
      )
    }
    await expect(
      Portal.createConnection(deps, TENANT, scope, input as never, TEST_ACTOR)
    ).rejects.toMatchObject({ status: 409 })
  })
})
