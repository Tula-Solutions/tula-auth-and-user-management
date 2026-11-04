import { afterEach, describe, expect, test } from 'bun:test'
import openapi from '../../../../packages/contract/openapi.json'
import { type FakeApi, fakeOrganization, IDS, installFakeApi } from './fake-api'
import { FAKE_MAX_LIVE_SCIM_TOKENS } from './fake-scim'

// The fake's SCIM token routes answer as `apps/api/src/modules/scim-token` does where a screen
// can tell the difference: shapes held to the published OpenAPI document's schemas, refusals to
// the service's.

let api: FakeApi | undefined

afterEach(() => {
  api?.restore()
  api = undefined
})

const ORG = '00000000-0000-7000-8000-0000000aaa01'
const ROOT = '/v1/admin/scim-tokens'

function arranged(enabled = true): FakeApi {
  api = installFakeApi()
  api.state.signedIn = true
  api.state.settings.settings.organizations = {
    ...api.state.settings.settings.organizations,
    enabled,
  }
  api.state.organizations.push(fakeOrganization({ id: ORG, name: 'Acme', slug: 'acme' }))
  return api
}

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`http://localhost${path}`, {
    method,
    headers: {
      'x-tula-dashboard': '1',
      'x-tula-environment': IDS.development,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, body: text === '' ? {} : JSON.parse(text) }
}

const schemas = openapi.components.schemas as unknown as Record<string, { properties?: object }>
const keysOf = (name: string) => Object.keys(schemas[name]?.properties ?? {}).sort()

describe('the fake SCIM token routes', () => {
  test('a created token matches the contract, holds the secret once and the list never does', async () => {
    arranged()
    const created = await call('POST', ROOT, { organizationId: ORG, name: 'Okta' })
    expect(created.status).toBe(201)
    expect(Object.keys(created.body).sort()).toEqual(keysOf('CreatedScimToken'))
    const listed = await call('GET', `${ROOT}?organizationId=${ORG}`)
    expect(Object.keys(listed.body.tokens[0]).sort()).toEqual(keysOf('ScimToken'))
    expect(JSON.stringify(listed.body)).not.toContain(created.body.token)
  })

  test('the list is newest first and keeps revoked tokens', async () => {
    arranged()
    const first = await call('POST', ROOT, { organizationId: ORG, name: 'One' })
    await call('POST', ROOT, { organizationId: ORG, name: 'Two' })
    expect((await call('DELETE', `${ROOT}/${first.body.id}?organizationId=${ORG}`)).status).toBe(
      204
    )
    const { tokens } = (await call('GET', `${ROOT}?organizationId=${ORG}`)).body
    expect(tokens.map((t: { name: string }) => t.name)).toEqual(['Two', 'One'])
    expect(tokens[1].revokedAt).not.toBeNull()
  })

  test('a revoked token is a 404 the second time', async () => {
    arranged()
    const { body } = await call('POST', ROOT, { organizationId: ORG, name: 'One' })
    await call('DELETE', `${ROOT}/${body.id}?organizationId=${ORG}`)
    const again = await call('DELETE', `${ROOT}/${body.id}?organizationId=${ORG}`)
    expect(again.status).toBe(404)
  })

  test('an eleventh live token is refused, and a revoked one frees a place', async () => {
    arranged()
    let last = { id: '' }
    for (let i = 0; i < FAKE_MAX_LIVE_SCIM_TOKENS; i += 1) {
      last = (await call('POST', ROOT, { organizationId: ORG, name: `t${i}` })).body
    }
    const refused = await call('POST', ROOT, { organizationId: ORG, name: 'more' })
    expect([refused.status, refused.body.code]).toEqual([409, 'resource.conflict'])
    await call('DELETE', `${ROOT}/${last.id}?organizationId=${ORG}`)
    expect((await call('POST', ROOT, { organizationId: ORG, name: 'more' })).status).toBe(201)
  })

  test('an unknown organization is a 404 and every route answers organization.disabled while off', async () => {
    arranged()
    const other = '00000000-0000-7000-8000-0000000aaa99'
    expect((await call('GET', `${ROOT}?organizationId=${other}`)).status).toBe(404)
    api?.restore()
    arranged(false)
    expect((await call('GET', `${ROOT}?organizationId=${ORG}`)).body.code).toBe(
      'organization.disabled'
    )
  })
})
