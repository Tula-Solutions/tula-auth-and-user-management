import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { DEFAULT_ENVIRONMENT_SETTINGS } from '@tula-tech/contract'
import * as Outbound from '~/lib/outbound'
import * as Audit from '~/modules/audit/service'
import * as Instance from '~/modules/instance/service'
import * as Jwks from '~/modules/jwks/service'
import * as Organizations from '~/modules/organization/service'
import type { SsoConnectionRecord } from '~/ports/sso-connection-store'
import { createTestDeps, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'
import type { DiagnosticCheck } from './schema'
import { METADATA_FETCHES_PER_RUN } from './sso'

let sequence = 0
const DAY = 86_400_000
// Recognisable strings of a stored connection: none may reach an answer.
const CANARY_NAME = 'canary-connection-name'
const CANARY_DOMAIN = 'canary-domain.test'
const CANARY_HOST = 'canary-idp.example.test'

const spies: { mockRestore(): void }[] = []
afterEach(() => {
  for (const spy of spies.splice(0)) {
    spy.mockRestore()
  }
})

/** Every metadata request gets this status; the body is a recognisable string no answer may repeat. */
function metadataAnswers(status: number) {
  spies.push(
    spyOn(Outbound, 'request').mockImplementation(
      async () => ({ status, headers: {}, body: new TextEncoder().encode('secret-body') }) as never
    )
  )
}

async function setup() {
  const deps = createTestDeps()
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  await Jwks.ensureKeys(deps, TEST_TENANT.environmentId)
  deps.environmentSettings.seed(TEST_TENANT.environmentId, {
    revision: 1,
    settings: {
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      organizations: { ...DEFAULT_ENVIRONMENT_SETTINGS.organizations, enabled: true },
      sso: { enabled: true },
    } as never,
  })
  deps.outbound.point(CANARY_HOST, '93.184.216.34')
  return deps
}

/** Claim and verify a domain for an organization straight in the store. */
async function verify(deps: TestDeps, organizationId: string, domain: string) {
  const none = Audit.none('fixture')
  const now = deps.clock.now()
  const id = Bun.randomUUIDv7()
  const scope = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }
  await deps.organizationDomains.claim(
    {
      id,
      ...scope,
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
    scope.environmentId,
    organizationId,
    id,
    'h',
    now,
    new Date(now.getTime() + 365 * DAY),
    none
  )
}

/** Store an active SAML connection whose certificate ends `endsInDays` from now. */
async function connect(
  deps: TestDeps,
  options: { endsInDays?: number; metadataUrl?: string | null; verified?: boolean } = {}
) {
  const { endsInDays = 365, metadataUrl = null, verified = true } = options
  sequence += 1
  const domain = `d${sequence}.${CANARY_DOMAIN}`
  const scope = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }
  const organization = await Organizations.create(
    deps,
    scope,
    { name: 'Acme', slug: `acme-${sequence}` },
    TEST_ACTOR
  )
  const organizationId = organization.id
  if (verified) {
    await verify(deps, organizationId, domain)
  }
  const now = deps.clock.now()
  const record: SsoConnectionRecord = {
    id: Bun.randomUUIDv7(),
    projectId: TEST_TENANT.projectId,
    environmentId: TEST_TENANT.environmentId,
    organizationId,
    protocol: 'saml',
    saml: {
      idpEntityId: `https://${CANARY_HOST}/entity`,
      ssoUrl: `https://${CANARY_HOST}/sso`,
      metadataUrl,
      certificates: [
        { pem: 'pem', notAfter: new Date(now.getTime() + endsInDays * DAY).toISOString() },
      ],
    },
    name: CANARY_NAME,
    status: 'active',
    issuer: '',
    clientId: '',
    clientSecretSealed: '',
    defaultRole: 'member',
    enforced: false,
    breakGlassRole: null,
    trustIdpMfa: false,
    attributeMapping: null,
    testedFingerprint: null,
    domains: [domain],
    createdAt: now,
    updatedAt: now,
  }
  const entry = Audit.none('fixture')
  await deps.ssoConnections.insert(record, entry)
  return record
}

async function sso(deps: TestDeps): Promise<DiagnosticCheck> {
  const answer = await Instance.diagnostics(deps)
  expect(JSON.stringify(answer)).not.toContain(CANARY_NAME)
  expect(JSON.stringify(answer)).not.toContain(CANARY_DOMAIN)
  expect(JSON.stringify(answer)).not.toContain(CANARY_HOST)
  return answer.checks.find((c) => c.id === 'sso_connections') as DiagnosticCheck
}

describe('the sso_connections check', () => {
  test('is skipped when no connection is active', async () => {
    const deps = await setup()
    expect((await sso(deps)).status).toBe('skipped')
  })

  test('is ok for a valid certificate, an answering metadata address and a verified domain', async () => {
    const deps = await setup()
    metadataAnswers(200)
    await connect(deps, { metadataUrl: `https://${CANARY_HOST}/metadata` })
    expect((await sso(deps)).status).toBe('ok')
  })

  test('fails for a certificate that has ended', async () => {
    const deps = await setup()
    await connect(deps, { endsInDays: -1 })
    const result = await sso(deps)
    expect(result.status).toBe('fail')
    expect(result.summary).toContain('has ended')
  })

  test('warns for a certificate that ends within 30 days, and not at 31', async () => {
    const deps = await setup()
    await connect(deps, { endsInDays: 29 })
    const result = await sso(deps)
    expect(result.status).toBe('warn')
    expect(result.summary).toContain('ends within 30 days')
    const later = await setup()
    await connect(later, { endsInDays: 31 })
    expect((await sso(later)).status).toBe('ok')
  })

  test('warns for a metadata address that does not answer', async () => {
    const deps = await setup()
    metadataAnswers(500)
    await connect(deps, { metadataUrl: `https://${CANARY_HOST}/metadata` })
    const result = await sso(deps)
    expect(result.status).toBe('warn')
    expect(result.summary).toContain('did not answer')
    expect(JSON.stringify(result)).not.toContain('secret-body')
  })

  test('warns for a bound domain its organization no longer verifies', async () => {
    const deps = await setup()
    await connect(deps, { verified: false })
    const result = await sso(deps)
    expect(result.status).toBe('warn')
    expect(result.summary).toContain('no longer verified')
  })

  test('requests at most the bound number of metadata addresses and says so', async () => {
    const deps = await setup()
    metadataAnswers(200)
    for (let i = 0; i < METADATA_FETCHES_PER_RUN + 1; i += 1) {
      await connect(deps, { metadataUrl: `https://${CANARY_HOST}/metadata` })
    }
    const result = await sso(deps)
    expect(result.status).toBe('warn')
    expect(result.summary).toContain('was not requested')
  })
})
