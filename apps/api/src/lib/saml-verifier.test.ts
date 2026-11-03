import { describe, expect, test } from 'bun:test'
import { Glob } from 'bun'
import { MemoryProofReplayGuard } from '~/adapters/memory/proof-replay'
import {
  buildMockSamlResponse,
  MOCK_SAML_KEYS,
  type MockSamlOptions,
} from '~/adapters/oauth/mock-saml'
import { FakeRedis } from '~/adapters/redis/fake'
import { RedisProofReplayGuard } from '~/adapters/redis/proof-replay'
import type { ProofReplayGuard } from '~/ports/proof-replay'
import { createTestDeps } from '~/testing'
import { SAML_REFUSALS, type SamlExpectations, verify } from './saml-verifier'

const SP = 'https://auth.example.com/v1/environments/env_1/saml/metadata'
const ACS = 'https://auth.example.com/v1/environments/env_1/saml/acs'
const IDP = 'https://idp.example.com/entity'
const REQUEST = '_req1'

const expected: SamlExpectations = {
  spEntityId: SP,
  acsUrl: ACS,
  requestId: REQUEST,
  idpEntityId: IDP,
  certificates: [MOCK_SAML_KEYS.a.certificate, MOCK_SAML_KEYS.b.certificate],
}

function response(overrides: Partial<MockSamlOptions> = {}, now = new Date()): string {
  return buildMockSamlResponse({
    mockProviderEnabled: true,
    spEntityId: SP,
    acsUrl: ACS,
    idpEntityId: IDP,
    requestId: REQUEST,
    subject: 'ada@example.com',
    attributes: { email: ['ada@example.com'] },
    now,
    ...overrides,
  })
}

describe('SAML response verifier', () => {
  test('accepts a response signed by the first configured certificate', async () => {
    const deps = createTestDeps()
    const verdict = await verify(deps, response({ now: deps.clock.now() }), expected)
    expect(verdict.ok).toBe(true)
    if (verdict.ok) {
      expect(verdict.assertion.subject).toBe('ada@example.com')
      expect(verdict.assertion.attributes).toEqual({ email: ['ada@example.com'] })
      expect(verdict.assertion.sessionIndex).toBe('_s1')
    }
  })

  test('accepts a response signed by the second configured certificate', async () => {
    const deps = createTestDeps()
    const verdict = await verify(deps, response({ now: deps.clock.now(), key: 'b' }), expected)
    expect(verdict.ok).toBe(true)
  })

  const rows: [string, Partial<MockSamlOptions>, string][] = (
    [
      ['wrong audience', { failure: 'wrong_audience' }, 'audience_mismatch'],
      ['wrong recipient', { failure: 'wrong_recipient' }, 'recipient_mismatch'],
      ['wrong destination', { failure: 'wrong_destination' }, 'destination_mismatch'],
      ['missing InResponseTo', { failure: 'missing_in_response_to' }, 'in_response_to_missing'],
      ['mismatched InResponseTo', { failure: 'wrong_in_response_to' }, 'in_response_to_mismatch'],
      ['expired', { failure: 'expired' }, 'expired'],
      ['not yet valid', { failure: 'not_yet_valid' }, 'not_yet_valid'],
      ['unsigned', { failure: 'unsigned' }, 'unsigned'],
      [
        'signed response around an unsigned assertion',
        { failure: 'response_signed_assertion_unsigned' },
        'assertion_unsigned',
      ],
      ['a second, unsigned assertion', { failure: 'second_assertion' }, 'multiple_assertions'],
      ['a comment injected in the NameID', { failure: 'comment_in_name_id' }, 'name_id_invalid'],
      ['a DOCTYPE', { failure: 'doctype' }, 'forbidden_xml'],
      ['an external entity', { failure: 'entity' }, 'forbidden_xml'],
      ['a different issuer', { failure: 'wrong_issuer' }, 'issuer_mismatch'],
      ['a failed status', { failure: 'status_failure' }, 'status_not_success'],
      ['a certificate that is not configured', { key: 'c' }, 'certificate_not_configured'],
    ] satisfies [string, Partial<MockSamlOptions>, string][]
  ).map((r) => r)

  for (const [name, options, reason] of rows) {
    test(`refuses ${name} as ${reason}`, async () => {
      const deps = createTestDeps()
      const verdict = await verify(deps, response({ now: deps.clock.now(), ...options }), expected)
      expect(verdict).toEqual({ ok: false, reason: reason as never })
    })
  }

  test('each refusal row has its own code', () => {
    const codes = rows.map((r) => r[2])
    // Rows that share a code are the doctype/entity pair only.
    expect(new Set(codes).size).toBe(codes.length - 1)
    for (const code of codes) {
      expect(SAML_REFUSALS as readonly string[]).toContain(code)
    }
  })

  test('refuses an unsolicited response (no request id expected)', async () => {
    const deps = createTestDeps()
    const verdict = await verify(deps, response({ now: deps.clock.now(), requestId: undefined }), {
      ...expected,
      requestId: null,
    })
    expect(verdict).toEqual({ ok: false, reason: 'unsolicited' })
  })

  test('refuses a response whose signature was tampered with', async () => {
    const deps = createTestDeps()
    const xml = Buffer.from(response({ now: deps.clock.now() }), 'base64').toString()
    const tampered = xml.replace('ada@example.com</saml:NameID>', 'eve@example.com</saml:NameID>')
    expect(tampered).not.toBe(xml)
    const verdict = await verify(deps, Buffer.from(tampered).toString('base64'), expected)
    expect(verdict.ok).toBe(false)
  })

  test('refuses garbage and an oversized body without throwing', async () => {
    const deps = createTestDeps()
    expect((await verify(deps, 'not base64 <<', expected)).ok).toBe(false)
    expect((await verify(deps, 'A'.repeat(600 * 1024), expected)).ok).toBe(false)
  })

  describe('time, with a 2-minute skew', () => {
    test('accepts an assertion that is 1 minute past its end', async () => {
      const deps = createTestDeps()
      const issued = deps.clock.now()
      const body = response({ now: issued })
      deps.clock.advance('6m') // the mock lasts 5 minutes: 1 minute past
      expect((await verify(deps, body, expected)).ok).toBe(true)
    })

    test('refuses an assertion that is 3 minutes past its end', async () => {
      const deps = createTestDeps()
      const body = response({ now: deps.clock.now() })
      deps.clock.advance('8m')
      expect(await verify(deps, body, expected)).toEqual({ ok: false, reason: 'expired' })
    })
  })

  describe('replay, over each guard', () => {
    const guards = {
      memory: (deps: ReturnType<typeof createTestDeps>): ProofReplayGuard =>
        new MemoryProofReplayGuard(deps.clock),
      redis: (deps: ReturnType<typeof createTestDeps>) =>
        new RedisProofReplayGuard(new FakeRedis(deps.clock), deps.clock),
    }
    for (const [name, make] of Object.entries(guards)) {
      test(`refuses the same assertion twice (${name})`, async () => {
        const base = createTestDeps()
        const deps = { ...base, proofReplay: make(base) }
        const body = response({ now: deps.clock.now(), assertionId: '_fixed' })
        expect((await verify(deps, body, expected)).ok).toBe(true)
        expect(await verify(deps, body, expected)).toEqual({ ok: false, reason: 'replayed' })
      })

      test(`a refused response burns no id (${name})`, async () => {
        const base = createTestDeps()
        const deps = { ...base, proofReplay: make(base) }
        const bad = response({
          now: deps.clock.now(),
          assertionId: '_burn',
          failure: 'wrong_audience',
        })
        expect((await verify(deps, bad, expected)).ok).toBe(false)
        const good = response({ now: deps.clock.now(), assertionId: '_burn' })
        expect((await verify(deps, good, expected)).ok).toBe(true)
      })
    }
  })
})

describe('the mock SAML signer', () => {
  test('builds nothing when the mock provider is off', () => {
    expect(() => response({ mockProviderEnabled: false })).toThrow(/OAUTH_MOCK_PROVIDER/)
  })

  test('is imported by nothing outside tests and the mock provider', async () => {
    const importers: string[] = []
    for await (const file of new Glob('**/*.ts').scan({ cwd: `${import.meta.dir}/..` })) {
      if (file.includes('mock-saml') || file.endsWith('.test.ts')) {
        continue
      }
      const text = await Bun.file(`${import.meta.dir}/../${file}`).text()
      // The mock keys are also the dev-only OIDC provider's signing key (modules/sso/dev-router.ts, mounted
      // only with the mock provider), which also serves the SAML mock IdP; nothing else imports the signer.
      if (file !== 'modules/sso/dev-router.ts' && /mock-saml(?!-keys)/.test(text)) {
        importers.push(file)
      }
    }
    expect(importers).toEqual([])
  })
})
