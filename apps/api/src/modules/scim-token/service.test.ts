import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { DEFAULT_ENVIRONMENT_SETTINGS, SCIM_TOKEN_PREFIX } from '@tula-tech/contract'
import { Hono } from 'hono'
import type { AppEnv } from '~/dependencies'
import { onError } from '~/handlers'
import { createApp } from '~/index'
import * as logger from '~/lib/logger'
import { scimToken } from '~/middleware/scim-token'
import * as Organizations from '~/modules/organization/service'
import * as ScimTokens from '~/modules/scim-token/service'
import {
  createInstanceTestDeps,
  seedApiKey,
  TEST_ACTOR,
  TEST_TENANT,
  type TestDeps,
} from '~/testing'

const SK = 'tula_sk_dev_secret000000000000000000000000'
const AK = 'tula_ak_dev_agent000000000000000000000000000000'
const TENANT = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }

let deps: TestDeps

function configure(organizations = true) {
  deps.environmentSettings.seed(TEST_TENANT.environmentId, {
    revision: 1,
    settings: {
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      organizations: { ...DEFAULT_ENVIRONMENT_SETTINGS.organizations, enabled: organizations },
    } as never,
  })
}

const org = (slug = 'acme') =>
  Organizations.create(deps, TENANT, { name: 'Acme', slug }, TEST_ACTOR)

/** A tiny app behind the middleware, to see what it lets through. */
function guarded() {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('deps', deps as never)
    await next()
  })
  app.use('*', scimToken() as never)
  app.get('/', (c) => c.json((c as never as { var: { scim: unknown } }).var.scim))
  app.onError(onError)
  return app
}

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } })

beforeEach(async () => {
  deps = createInstanceTestDeps()
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  configure()
  await seedApiKey(deps, SK)
  await seedApiKey(deps, AK)
})

describe('SCIM token admin service', () => {
  test('a token is shown once, stored only as a hash, and listed without its secret', async () => {
    const o = await org()
    const made = await ScimTokens.create(
      deps,
      TENANT,
      { organizationId: o.id, name: 'Okta' },
      TEST_ACTOR
    )
    expect(made.token.startsWith(SCIM_TOKEN_PREFIX)).toBe(true)
    expect(ScimTokens.environmentOf(made.token)).toBe(TENANT.environmentId)
    const listed = await ScimTokens.list(deps, TENANT, o.id)
    expect(listed.map((one) => one.id)).toEqual([made.id])
    expect(JSON.stringify(listed)).not.toContain(made.token)
    const stored = await deps.scim.listTokens(TENANT.environmentId, o.id)
    expect(JSON.stringify(stored)).not.toContain(made.token)
    expect(made.prefix.length).toBeLessThan(made.token.length / 2)
  })

  test('creating and revoking are recorded with ids only', async () => {
    const o = await org()
    const made = await ScimTokens.create(
      deps,
      TENANT,
      { organizationId: o.id, name: 'Okta' },
      TEST_ACTOR
    )
    await ScimTokens.revoke(deps, TENANT, o.id, made.id, TEST_ACTOR)
    const types = (
      await deps.activityLog.listAudit(TENANT.environmentId, { page: 1, size: 50 })
    ).entries
      .map((entry) => entry.type)
      .filter((type) => type.startsWith('scim_token.'))
    expect(types.sort()).toEqual(['scim_token.created', 'scim_token.revoked'])
  })

  test('a second revocation, another organization’s token and a stranger are 404', async () => {
    const o = await org()
    const other = await org('globex')
    const made = await ScimTokens.create(
      deps,
      TENANT,
      { organizationId: o.id, name: 'Okta' },
      TEST_ACTOR
    )
    await expect(
      ScimTokens.revoke(deps, TENANT, other.id, made.id, TEST_ACTOR)
    ).rejects.toMatchObject({
      status: 404,
    })
    await ScimTokens.revoke(deps, TENANT, o.id, made.id, TEST_ACTOR)
    await expect(ScimTokens.revoke(deps, TENANT, o.id, made.id, TEST_ACTOR)).rejects.toMatchObject({
      status: 404,
    })
    await expect(
      ScimTokens.create(deps, TENANT, { organizationId: Bun.randomUUIDv7(), name: 'x' }, TEST_ACTOR)
    ).rejects.toMatchObject({ status: 404 })
  })

  test('an organization holds at most ten live tokens; a revoked one frees a place', async () => {
    const o = await org()
    const made: Array<{ id: string }> = []
    for (let i = 0; i < ScimTokens.MAX_LIVE_TOKENS; i++) {
      made.push(
        await ScimTokens.create(deps, TENANT, { organizationId: o.id, name: `t${i}` }, TEST_ACTOR)
      )
    }
    await expect(
      ScimTokens.create(deps, TENANT, { organizationId: o.id, name: 'more' }, TEST_ACTOR)
    ).rejects.toMatchObject({ status: 409 })
    await ScimTokens.revoke(deps, TENANT, o.id, made[0]?.id as string, TEST_ACTOR)
    await ScimTokens.create(deps, TENANT, { organizationId: o.id, name: 'more' }, TEST_ACTOR)
  })

  test('every entry point refuses while organizations are off', async () => {
    const o = await org()
    configure(false)
    await expect(ScimTokens.list(deps, TENANT, o.id)).rejects.toMatchObject({
      code: 'organization.disabled',
    })
  })

  test('environmentOf reads only tokens shaped like ours', () => {
    expect(ScimTokens.environmentOf('tula_sk_dev_x')).toBeNull()
    expect(ScimTokens.environmentOf(`${SCIM_TOKEN_PREFIX}nothex_abc`)).toBeNull()
    expect(ScimTokens.environmentOf(`${SCIM_TOKEN_PREFIX}${'a'.repeat(32)}_short`)).toBeNull()
  })
})

describe('SCIM token admin routes', () => {
  test('create answers the secret once with no-store; list never does', async () => {
    const o = await org()
    const app = createApp(deps)
    const created = await app.request('/v1/admin/scim-tokens', {
      method: 'POST',
      headers: { authorization: `Bearer ${SK}`, 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: o.id, name: 'Okta' }),
    })
    expect(created.status).toBe(201)
    expect(created.headers.get('cache-control')).toBe('no-store')
    const body = (await created.json()) as { token: string; id: string }
    expect(body.token.startsWith(SCIM_TOKEN_PREFIX)).toBe(true)
    const listed = await app.request(`/v1/admin/scim-tokens?organizationId=${o.id}`, {
      headers: { authorization: `Bearer ${SK}` },
    })
    expect(JSON.stringify(await listed.json())).not.toContain(body.token)
    const revoked = await app.request(`/v1/admin/scim-tokens/${body.id}?organizationId=${o.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${SK}` },
    })
    expect(revoked.status).toBe(204)
  })

  test('an agent key cannot create or revoke, and a SCIM token opens no admin route', async () => {
    const o = await org()
    const app = createApp(deps)
    const made = await ScimTokens.create(
      deps,
      TENANT,
      { organizationId: o.id, name: 'Okta' },
      TEST_ACTOR
    )
    const create = (key: string) =>
      app.request('/v1/admin/scim-tokens', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId: o.id, name: 'x' }),
      })
    expect((await create(AK)).status).toBe(401)
    expect((await create(made.token)).status).toBe(401)
    const read = await app.request(`/v1/admin/scim-tokens?organizationId=${o.id}`, {
      headers: { authorization: `Bearer ${made.token}` },
    })
    expect(read.status).toBe(401)
    const agent = await app.request('/v1/agent/proposals', {
      method: 'POST',
      headers: { authorization: `Bearer ${made.token}`, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(agent.status).toBe(401)
  })
})

describe('scimToken middleware', () => {
  async function token() {
    const o = await org()
    const made = await ScimTokens.create(
      deps,
      TENANT,
      { organizationId: o.id, name: 'Okta' },
      TEST_ACTOR
    )
    return { o, ...made }
  }

  test('a live token resolves its organization and records its use', async () => {
    const { o, id, token: secret } = await token()
    const res = await guarded().request('/', bearer(secret))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ organizationId: o.id, tokenId: id })
    expect((await deps.scim.listTokens(TENANT.environmentId, o.id))[0]?.lastUsedAt).toEqual(
      deps.clock.now()
    )
  })

  test('a failed write of the last use never fails a valid request', async () => {
    const { token: secret } = await token()
    const touch = spyOn(deps.scim, 'touchToken').mockRejectedValue(new Error('db down'))
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    const res = await guarded().request('/', bearer(secret))
    expect(res.status).toBe(200)
    expect(warn).toHaveBeenCalledTimes(1)
    touch.mockRestore()
    warn.mockRestore()
  })

  test('a revoked, unknown, malformed or foreign key is the same 401', async () => {
    const { o, id, token: secret } = await token()
    await ScimTokens.revoke(deps, TENANT, o.id, id, TEST_ACTOR)
    const flipped = `${secret.slice(0, -1)}${secret.endsWith('a') ? 'b' : 'a'}`
    for (const presented of [secret, flipped, SK, AK, 'tula_scim_', '']) {
      const res = await guarded().request('/', bearer(presented))
      expect(res.status).toBe(401)
      expect(((await res.json()) as { code: string }).code).toBe('auth.invalid_key')
    }
    expect((await guarded().request('/')).status).toBe(401)
  })

  test('a token of one environment does not open another’s', async () => {
    const { token: secret } = await token()
    const other = secret.replace(
      /^tula_scim_[0-9a-f]{32}/,
      `${SCIM_TOKEN_PREFIX}${TEST_TENANT.productionEnvironmentId.replaceAll('-', '')}`
    )
    expect((await guarded().request('/', bearer(other))).status).toBe(401)
  })

  test('requests beyond the per-token limit are refused with 429', async () => {
    const { token: secret } = await token()
    const app = guarded()
    let last = 0
    for (let i = 0; i < 601; i++) {
      last = (await app.request('/', bearer(secret))).status
    }
    expect(last).toBe(429)
  })
})
