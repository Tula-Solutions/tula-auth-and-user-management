import { afterEach, describe, expect, test } from 'bun:test'
import { SsoConnectionListSchema, SsoConnectionSchema } from '@tula-tech/contract'
import { type FakeApi, fakeDomain, fakeOrganization, IDS, installFakeApi } from './fake-api'

// The fake's SSO routes answer as `apps/api/src/modules/sso-connection` does where a screen can
// tell the difference: shapes held to the contract's schemas, refusals to its codes.

let api: FakeApi | undefined

afterEach(() => {
  api?.restore()
  api = undefined
})

const ORG = '00000000-0000-7000-8000-0000000aaa01'
const ROOT = '/v1/admin/sso-connections'

function arranged(enabled = true): FakeApi {
  api = installFakeApi()
  api.state.signedIn = true
  api.state.settings.settings.sso = { enabled }
  api.state.organizations.push(fakeOrganization({ id: ORG, name: 'Acme', slug: 'acme' }))
  api.state.domains.push(fakeDomain({ organizationId: ORG, domain: 'acme.com' }))
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

const OIDC = {
  organizationId: ORG,
  protocol: 'oidc',
  name: 'Okta',
  issuer: 'https://login.example.com',
  clientId: 'abc',
  clientSecret: 'shh',
  domains: ['acme.com'],
}

describe('the fake SSO routes', () => {
  test('a created connection is a draft, matches the contract and never returns the secret', async () => {
    arranged()
    const created = await call('POST', ROOT, OIDC)
    expect(created.status).toBe(201)
    expect(SsoConnectionSchema.parse(created.body).status).toBe('draft')
    expect(JSON.stringify(created.body)).not.toContain('shh')
    const listed = await call('GET', `${ROOT}?organizationId=${ORG}`)
    expect(SsoConnectionListSchema.parse(listed.body).connections).toHaveLength(1)
  })

  test('a SAML connection carries the service provider values', async () => {
    arranged()
    const created = await call('POST', ROOT, {
      organizationId: ORG,
      protocol: 'saml',
      name: 'Entra',
      saml: { metadataUrl: 'https://idp.example.com/metadata' },
    })
    const saml = SsoConnectionSchema.parse(created.body).saml
    expect(saml?.acsUrl).toContain('/acs')
    expect(saml?.certificates).toHaveLength(1)
  })

  test.each([
    ['sso.name_taken', 409, { ...OIDC, domains: [] }],
    ['sso.domain_taken', 409, { ...OIDC, name: 'Other' }],
    ['sso.domain_not_verified', 422, { ...OIDC, name: 'Third', domains: ['nope.com'] }],
  ])('a second create is refused with %s', async (code, status, body) => {
    arranged()
    await call('POST', ROOT, OIDC)
    const refused = await call('POST', ROOT, body)
    expect(refused.status).toBe(status)
    expect(refused.body.code).toBe(code)
  })

  test('every route answers sso.disabled while single sign-on is off', async () => {
    arranged(false)
    expect((await call('GET', `${ROOT}?organizationId=${ORG}`)).body.code).toBe('sso.disabled')
    expect((await call('POST', ROOT, OIDC)).status).toBe(403)
  })

  test('a connection people signed in through is not deleted', async () => {
    const current = arranged()
    const { body } = await call('POST', ROOT, OIDC)
    const stored = current.state.ssoConnections[0]
    if (stored) {
      stored.used = true
    }
    const refused = await call('DELETE', `${ROOT}/${body.id}`)
    expect(refused.body.code).toBe('sso.connection_in_use')
    if (stored) {
      stored.used = false
    }
    expect((await call('DELETE', `${ROOT}/${body.id}`)).status).toBe(204)
  })

  test('an update keeps a secret that is not sent and replaces one that is', async () => {
    const current = arranged()
    const { body } = await call('POST', ROOT, OIDC)
    await call('PATCH', `${ROOT}/${body.id}`, { name: 'Renamed' })
    expect(current.state.ssoConnections[0]?.secret).toBe('shh')
    await call('PATCH', `${ROOT}/${body.id}`, { clientSecret: 'new' })
    expect(current.state.ssoConnections[0]?.secret).toBe('new')
  })
})
