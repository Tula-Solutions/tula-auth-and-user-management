import { beforeEach, describe, expect, test } from 'bun:test'
import { DEFAULT_ENVIRONMENT_SETTINGS } from '@tula-tech/contract'
import { MOCK_SAML_KEYS } from '~/adapters/oauth/mock-saml'
import { createApp } from '~/index'
import * as Audit from '~/modules/audit/service'
import * as Organizations from '~/modules/organization/service'
import * as Sso from '~/modules/sso-connection/service'
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
const ISSUER = 'https://idp.example.test'

let deps: TestDeps

function configure(sso: boolean, organizations = true) {
  deps.environmentSettings.seed(TEST_TENANT.environmentId, {
    revision: 1,
    settings: {
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      organizations: { ...DEFAULT_ENVIRONMENT_SETTINGS.organizations, enabled: organizations },
      sso: { enabled: sso },
    } as never,
  })
}

/** Verify a domain for an organization straight in the store (the mail round trip is not the subject). */
async function verified(organizationId: string, domain: string, expiresInMs = 86_400_000) {
  const id = Bun.randomUUIDv7()
  const none = Audit.none('fixture')
  const now = deps.clock.now()
  await deps.organizationDomains.claim(
    {
      id,
      ...TENANT,
      organizationId,
      domain,
      mode: 'suggest',
      codeHash: 'h',
      codeExpiresAt: new Date(now.getTime() + 60_000),
      at: now,
      limit: 10,
    },
    none
  )
  await deps.organizationDomains.verify(
    TENANT.environmentId,
    organizationId,
    id,
    'h',
    now,
    new Date(now.getTime() + expiresInMs),
    none
  )
}

async function org(slug = 'acme') {
  return Organizations.create(deps, TENANT, { name: 'Acme', slug }, TEST_ACTOR)
}

const input = (organizationId: string, extra: Record<string, unknown> = {}) => ({
  organizationId,
  protocol: 'oidc' as const,
  name: 'Okta',
  issuer: ISSUER,
  clientId: 'client-1',
  clientSecret: 'super-secret-value',
  defaultRole: 'member',
  domains: ['acme.test'],
  ...extra,
})

beforeEach(() => {
  deps = createInstanceTestDeps()
  const now = deps.clock.now()
  for (const id of [TEST_TENANT.environmentId, TEST_TENANT.productionEnvironmentId]) {
    deps.environments.add({
      id,
      projectId: TEST_TENANT.projectId,
      kind: 'development',
      createdAt: now,
    })
  }
  deps.outbound.point('idp.example.test', '93.184.216.34')
  configure(true)
})

describe('SSO connection admin service', () => {
  test('a draft is created with its secret sealed and never returned', async () => {
    const o = await org()
    await verified(o.id, 'acme.test')
    const made = await Sso.create(deps, TENANT, input(o.id), TEST_ACTOR)
    expect(made).toMatchObject({ status: 'draft', clientSecretSet: true, domains: ['acme.test'] })
    expect(JSON.stringify(made)).not.toContain('super-secret-value')
    const stored = await deps.ssoConnections.find(TENANT.environmentId, made.id)
    const opened = await deps.secretBox.open(
      Sso.SECRET_PURPOSE,
      stored?.clientSecretSealed as never,
      Sso.secretAad(TENANT.environmentId, made.id)
    )
    expect(new TextDecoder().decode(opened)).toBe('super-secret-value')
  })

  test('every entry point refuses while single sign-on or organizations are off', async () => {
    const o = await org()
    configure(false)
    await expect(Sso.list(deps, TENANT, o.id)).rejects.toMatchObject({ code: 'sso.disabled' })
    await expect(Sso.create(deps, TENANT, input(o.id), TEST_ACTOR)).rejects.toMatchObject({
      code: 'sso.disabled',
    })
    configure(true, false)
    await expect(Sso.get(deps, TENANT, Bun.randomUUIDv7())).rejects.toMatchObject({
      code: 'organization.disabled',
    })
  })

  test('a private issuer address is refused', async () => {
    const o = await org()
    await verified(o.id, 'acme.test')
    deps.outbound.point('internal.example.test', '10.0.0.5')
    await expect(
      Sso.create(deps, TENANT, input(o.id, { issuer: 'https://internal.example.test' }), TEST_ACTOR)
    ).rejects.toMatchObject({ code: 'sso.issuer_not_allowed' })
  })

  test('a domain that is unverified, lapsed or another organization’s is refused', async () => {
    const a = await org('acme')
    const b = await org('beta')
    await verified(b.id, 'beta.test')
    await verified(a.id, 'old.test', 1000)
    deps.clock.advance('1h')
    for (const domain of ['nope.test', 'beta.test', 'old.test']) {
      await expect(
        Sso.create(deps, TENANT, input(a.id, { domains: [domain] }), TEST_ACTOR)
      ).rejects.toMatchObject({ code: 'sso.domain_not_verified' })
    }
  })

  test('an unknown default role, an unknown organization and a taken name are refused', async () => {
    const o = await org()
    await verified(o.id, 'acme.test')
    await expect(
      Sso.create(deps, TENANT, input(o.id, { defaultRole: 'nope' }), TEST_ACTOR)
    ).rejects.toMatchObject({ code: 'organization.role_unknown' })
    await expect(
      Sso.create(deps, TENANT, input(Bun.randomUUIDv7()), TEST_ACTOR)
    ).rejects.toMatchObject({ status: 404 })
    await Sso.create(deps, TENANT, input(o.id), TEST_ACTOR)
    await expect(Sso.create(deps, TENANT, input(o.id), TEST_ACTOR)).rejects.toMatchObject({
      code: 'sso.name_taken',
    })
  })

  test('activation widens and is audited as weakened; a second active connection cannot take the domain', async () => {
    const o = await org()
    await verified(o.id, 'acme.test')
    const first = await Sso.create(deps, TENANT, input(o.id), TEST_ACTOR)
    const second = await Sso.create(deps, TENANT, input(o.id, { name: 'Other' }), TEST_ACTOR)
    await Sso.update(deps, TENANT, first.id, { status: 'active' }, TEST_ACTOR)
    const entry = deps.activityLog.entries.findLast((e) => e.type === 'sso_connection.updated')
    expect(entry?.data).toMatchObject({ changed: ['status'], status: 'active', weakened: true })
    expect(JSON.stringify(entry?.data)).not.toContain('acme.test')
    await expect(
      Sso.update(deps, TENANT, second.id, { status: 'active' }, TEST_ACTOR)
    ).rejects.toMatchObject({ code: 'sso.domain_taken' })
  })

  test('a connection never returns to a draft, and cannot activate without a domain', async () => {
    const o = await org()
    await verified(o.id, 'acme.test')
    const c = await Sso.create(deps, TENANT, input(o.id), TEST_ACTOR)
    const bare = await Sso.create(
      deps,
      TENANT,
      input(o.id, { name: 'Bare', domains: [] }),
      TEST_ACTOR
    )
    await expect(
      Sso.update(deps, TENANT, bare.id, { status: 'active' }, TEST_ACTOR)
    ).rejects.toMatchObject({ code: 'sso.domain_not_verified' })
    await Sso.update(deps, TENANT, c.id, { status: 'disabled' }, TEST_ACTOR)
    await expect(
      Sso.update(deps, TENANT, c.id, { status: 'draft' }, TEST_ACTOR)
    ).rejects.toMatchObject({ code: 'sso.invalid_transition' })
  })

  test('another environment’s connection is not found', async () => {
    const o = await org()
    await verified(o.id, 'acme.test')
    const c = await Sso.create(deps, TENANT, input(o.id), TEST_ACTOR)
    const other = { ...TENANT, environmentId: TEST_TENANT.productionEnvironmentId }
    configureOther(other.environmentId)
    await expect(Sso.get(deps, other, c.id)).rejects.toMatchObject({
      code: 'sso.connection_not_found',
    })
  })

  test('a connection that was never used is deleted and recorded', async () => {
    const o = await org()
    await verified(o.id, 'acme.test')
    const c = await Sso.create(deps, TENANT, input(o.id), TEST_ACTOR)
    await Sso.remove(deps, TENANT, c.id, TEST_ACTOR)
    expect(deps.activityLog.entries.some((e) => e.type === 'sso_connection.deleted')).toBe(true)
    await expect(Sso.get(deps, TENANT, c.id)).rejects.toMatchObject({
      code: 'sso.connection_not_found',
    })
  })
})

function configureOther(environmentId: string) {
  deps.environmentSettings.seed(environmentId, {
    revision: 1,
    settings: {
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      organizations: { ...DEFAULT_ENVIRONMENT_SETTINGS.organizations, enabled: true },
      sso: { enabled: true },
    } as never,
  })
}

describe('SSO connection routes', () => {
  test('an agent key may read but not write', async () => {
    await seedApiKey(deps, SK)
    await seedApiKey(deps, AK)
    const o = await org()
    const app = createApp(deps)
    const call = (method: string, path: string, key: string, body?: unknown) =>
      app.request(`/v1/admin/sso-connections${path}`, {
        method,
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      })
    expect((await call('GET', `?organizationId=${o.id}`, AK)).status).toBe(200)
    expect((await call('POST', '', AK, input(o.id, { domains: [] }))).status).toBe(401)
    const created = await call('POST', '', SK, input(o.id, { domains: [] }))
    expect(created.status).toBe(201)
    expect(JSON.stringify(await created.json())).not.toContain('super-secret-value')
  })
})

describe('SAML connections', () => {
  const bare = (pem: string) => pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')
  const metadata = (head = '') =>
    `${head}<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="https://idp.example.test/e">` +
    '<md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">' +
    `<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${bare(MOCK_SAML_KEYS.a.certificate)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>` +
    '<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.test/sso"/>' +
    '</md:IDPSSODescriptor></md:EntityDescriptor>'
  const saml = (organizationId: string, saml: Record<string, unknown>, extra = {}) =>
    ({
      organizationId,
      protocol: 'saml' as const,
      name: 'Okta SAML',
      defaultRole: 'member',
      domains: ['acme.test'],
      saml,
      ...extra,
    }) as never

  test('metadata XML gives the settings, with an expiry kept per certificate', async () => {
    const o = await org()
    await verified(o.id, 'acme.test')
    const made = await Sso.create(deps, TENANT, saml(o.id, { metadataXml: metadata() }), TEST_ACTOR)
    expect(made.protocol).toBe('saml')
    expect(made.clientSecretSet).toBe(false)
    expect(made.saml).toMatchObject({
      idpEntityId: 'https://idp.example.test/e',
      ssoUrl: 'https://idp.example.test/sso',
      acsUrl: expect.stringContaining(`/sso/saml/${made.id}/acs`),
      spEntityId: expect.stringContaining(`/sso/saml/${made.id}/metadata`),
    })
    expect(made.saml?.certificates).toHaveLength(1)
    expect(made.saml?.certificates[0]).toMatchObject({ expired: false })
    expect(made.saml?.certificates[0]?.notAfter).toBeString()
    const stored = await deps.ssoConnections.find(TENANT.environmentId, made.id)
    expect(new Date(stored?.saml?.certificates[0]?.notAfter ?? '').getTime()).toBeGreaterThan(0)
  })

  test('a certificate past its expiry is shown as expired', async () => {
    const o = await org()
    await verified(o.id, 'acme.test')
    const made = await Sso.create(deps, TENANT, saml(o.id, { metadataXml: metadata() }), TEST_ACTOR)
    for (let i = 0; i < 101; i++) {
      deps.clock.advance('365d')
    }
    const read = await Sso.get(deps, TENANT, made.id)
    expect(read.saml?.certificates[0]?.expired).toBe(true)
  })

  test('values by hand take one or two certificates, and not three', async () => {
    const o = await org()
    await verified(o.id, 'acme.test')
    const pems = [MOCK_SAML_KEYS.a.certificate, MOCK_SAML_KEYS.b.certificate]
    const made = await Sso.create(
      deps,
      TENANT,
      saml(o.id, {
        idpEntityId: 'https://idp.example.test/e',
        ssoUrl: 'https://idp.example.test/sso',
        certificates: pems,
      }),
      TEST_ACTOR
    )
    expect(made.saml?.certificates).toHaveLength(2)
    await expect(
      Sso.create(
        deps,
        TENANT,
        saml(
          o.id,
          { idpEntityId: 'x', ssoUrl: 'https://idp.example.test/sso', certificates: ['garbage'] },
          { name: 'Two' }
        ),
        TEST_ACTOR
      )
    ).rejects.toMatchObject({ code: 'sso.saml_invalid' })
  })

  test('metadata with a DTD or an entity is refused', async () => {
    const o = await org()
    await verified(o.id, 'acme.test')
    await expect(
      Sso.create(
        deps,
        TENANT,
        saml(o.id, {
          metadataXml: metadata('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>'),
        }),
        TEST_ACTOR
      )
    ).rejects.toMatchObject({ code: 'sso.saml_invalid', params: { reason: 'forbidden_xml' } })
  })

  test('no source, or two, is refused', async () => {
    const o = await org()
    await verified(o.id, 'acme.test')
    await expect(Sso.create(deps, TENANT, saml(o.id, {}), TEST_ACTOR)).rejects.toMatchObject({
      code: 'sso.saml_invalid',
    })
    await expect(
      Sso.create(
        deps,
        TENANT,
        saml(o.id, { metadataXml: metadata(), metadataUrl: 'https://idp.example.test/m' }),
        TEST_ACTOR
      )
    ).rejects.toMatchObject({ code: 'sso.saml_invalid' })
  })

  test('OIDC fields on a SAML connection are malformed', async () => {
    const o = await org()
    await verified(o.id, 'acme.test')
    await expect(
      Sso.create(
        deps,
        TENANT,
        saml(o.id, { metadataXml: metadata() }, { clientId: 'c' }),
        TEST_ACTOR
      )
    ).rejects.toMatchObject({ code: 'request.malformed' })
  })

  test('a metadata address at a private address is refused', async () => {
    const o = await org()
    await verified(o.id, 'acme.test')
    deps.outbound.point('internal.example.test', '10.0.0.5')
    await expect(
      Sso.create(
        deps,
        TENANT,
        saml(o.id, { metadataUrl: 'https://internal.example.test/m' }),
        TEST_ACTOR
      )
    ).rejects.toMatchObject({ code: 'sso.issuer_not_allowed' })
  })

  test('a metadata address is fetched, kept, and refreshed from the same address', async () => {
    const o = await org()
    await verified(o.id, 'acme.test')
    let body = metadata()
    let status = 200
    const server = Bun.serve({ port: 0, fetch: () => new Response(body, { status }) })
    try {
      deps.outbound.point('localhost', '127.0.0.1')
      const url = `http://localhost:${server.port}/metadata`
      const made = await Sso.create(deps, TENANT, saml(o.id, { metadataUrl: url }), TEST_ACTOR)
      expect(made.saml?.metadataUrl).toBe(url)
      body = metadata().replace('/sso"', '/sso2"')
      const refreshed = await Sso.refreshMetadata(deps, TENANT, made.id, TEST_ACTOR)
      expect(refreshed.saml?.ssoUrl).toBe('https://idp.example.test/sso2')
      status = 500
      await expect(Sso.refreshMetadata(deps, TENANT, made.id, TEST_ACTOR)).rejects.toMatchObject({
        code: 'sso.saml_invalid',
        params: { reason: 'fetch_failed' },
      })
    } finally {
      server.stop(true)
    }
  })

  test('refresh needs a metadata address, and an update swaps the certificates', async () => {
    const o = await org()
    await verified(o.id, 'acme.test')
    const made = await Sso.create(deps, TENANT, saml(o.id, { metadataXml: metadata() }), TEST_ACTOR)
    await expect(Sso.refreshMetadata(deps, TENANT, made.id, TEST_ACTOR)).rejects.toMatchObject({
      code: 'sso.saml_invalid',
      params: { reason: 'no_metadata_url' },
    })
    const updated = await Sso.update(
      deps,
      TENANT,
      made.id,
      {
        saml: {
          idpEntityId: 'https://idp.example.test/e',
          ssoUrl: 'https://idp.example.test/sso',
          certificates: [MOCK_SAML_KEYS.a.certificate, MOCK_SAML_KEYS.b.certificate],
        },
      } as never,
      TEST_ACTOR
    )
    expect(updated.saml?.certificates).toHaveLength(2)
  })

  test('SAML settings on an OIDC connection are malformed', async () => {
    const o = await org()
    await verified(o.id, 'acme.test')
    const made = await Sso.create(deps, TENANT, input(o.id), TEST_ACTOR)
    await expect(
      Sso.update(deps, TENANT, made.id, { saml: { metadataXml: metadata() } } as never, TEST_ACTOR)
    ).rejects.toMatchObject({ code: 'request.malformed' })
  })
})
