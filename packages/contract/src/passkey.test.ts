import { describe, expect, test } from 'bun:test'
import { SecondFactorRequestSchema } from './flow'
import { StepUpRequestSchema } from './mfa'
import {
  MAX_PASSKEY_NAME_LENGTH,
  MAX_PASSKEYS_PER_USER,
  PASSKEY_ALGORITHMS,
  PASSKEY_CHALLENGE_TTL_MS,
  PasskeyAssertionCredentialSchema,
  PasskeyRegisterRequestSchema,
  PasskeyRegistrationCredentialSchema,
  PasskeyRenameRequestSchema,
  PasskeySchema,
} from './passkey'

const assertion = {
  id: 'Y3JlZGVudGlhbA',
  rawId: 'Y3JlZGVudGlhbA',
  type: 'public-key',
  response: {
    clientDataJSON: 'e30',
    authenticatorData: 'YXV0aA',
    signature: 'c2ln',
    userHandle: 'aGFuZGxl',
  },
  clientExtensionResults: {},
}

const registration = {
  id: 'Y3JlZGVudGlhbA',
  rawId: 'Y3JlZGVudGlhbA',
  type: 'public-key',
  response: { clientDataJSON: 'e30', attestationObject: 'YXR0', transports: ['internal'] },
  authenticatorAttachment: 'platform',
  clientExtensionResults: { credProps: { rk: true } },
}

describe('passkey constants', () => {
  test('ten passkeys a user, five minutes a challenge, ES256 then EdDSA then RS256', () => {
    expect(MAX_PASSKEYS_PER_USER).toBe(10)
    expect(PASSKEY_CHALLENGE_TTL_MS).toBe(300_000)
    expect(PASSKEY_ALGORITHMS).toEqual([-7, -8, -257])
  })
})

describe('PasskeySchema', () => {
  test('a passkey is a name, whether it is synced and two dates: no key and no credential id', () => {
    const passkey = {
      id: '0198c1de-0000-7000-8000-000000000001',
      name: 'MacBook',
      synced: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: null,
    }
    expect(PasskeySchema.parse({ ...passkey, publicKey: 'x', credentialId: 'y' })).toEqual(passkey)
  })
})

describe('browser responses', () => {
  test('a registration keeps members this version does not know', () => {
    expect(PasskeyRegistrationCredentialSchema.parse(registration)).toEqual(registration as never)
  })

  test('an assertion keeps members this version does not know, and may have no user handle', () => {
    expect(PasskeyAssertionCredentialSchema.parse(assertion)).toEqual(assertion as never)
    const { userHandle: _handle, ...response } = assertion.response
    expect(PasskeyAssertionCredentialSchema.safeParse({ ...assertion, response }).success).toBe(
      true
    )
  })

  test.each<[string, unknown]>([
    ['another type', { ...assertion, type: 'password' }],
    ['no signature', { ...assertion, response: { ...assertion.response, signature: undefined } }],
    ['padded base64', { ...assertion, id: 'Y3JlZA==' }],
    ['standard base64', { ...assertion, id: 'a+b/' }],
    ['an empty id', { ...assertion, id: '' }],
    ['an id past 1023 bytes', { ...assertion, id: 'a'.repeat(1367) }],
    ['a response that is not an object', { ...assertion, response: 'x' }],
  ])('an assertion with %s is refused', (_, body) => {
    expect(PasskeyAssertionCredentialSchema.safeParse(body).success).toBe(false)
  })

  test('a registration without an attestation object is refused', () => {
    expect(
      PasskeyRegistrationCredentialSchema.safeParse({
        ...registration,
        response: { clientDataJSON: 'e30' },
      }).success
    ).toBe(false)
  })
})

describe('requests', () => {
  test('a name is trimmed, and must have between one and 64 characters', () => {
    expect(PasskeyRenameRequestSchema.parse({ name: '  Phone ' })).toEqual({ name: 'Phone' })
    expect(PasskeyRenameRequestSchema.safeParse({ name: '   ' }).success).toBe(false)
    expect(
      PasskeyRenameRequestSchema.safeParse({ name: 'a'.repeat(MAX_PASSKEY_NAME_LENGTH + 1) })
        .success
    ).toBe(false)
    expect(PasskeyRegisterRequestSchema.safeParse({ credential: registration }).success).toBe(true)
  })

  test('a passkey is a second factor and a step-up method, proven with an assertion', () => {
    const proof = { method: 'passkey', credential: assertion }
    expect(SecondFactorRequestSchema.safeParse(proof).success).toBe(true)
    expect(StepUpRequestSchema.safeParse(proof).success).toBe(true)
    expect(SecondFactorRequestSchema.safeParse({ method: 'passkey' }).success).toBe(false)
    expect(StepUpRequestSchema.safeParse({ method: 'passkey', credential: {} }).success).toBe(false)
  })
})
