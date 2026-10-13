import { describe, expect, test } from 'bun:test'
import { VirtualAuthenticator } from '@tula/conformance'
import * as WebAuthn from '~/lib/webauthn'

const origin = 'https://app.northline.test'
const rpId = 'northline.test'

function creation(challenge: string, extra: object = {}) {
  return {
    rp: { id: rpId, name: 'Northline' },
    user: { id: 'dXNlci1oYW5kbGU', name: 'maya@northline.app', displayName: 'Maya' },
    challenge,
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    excludeCredentials: [],
    ...extra,
  }
}

async function registered(input: object = {}) {
  const authenticator = new VirtualAuthenticator()
  const challenge = WebAuthn.newChallenge()
  const response = await authenticator.create(creation(challenge), { origin, ...input })
  const credential = await WebAuthn.verifyRegistration(response, {
    challenge,
    origins: [origin],
    rpId,
  })
  if (!credential) {
    throw new Error('registration did not verify')
  }
  return { authenticator, credential }
}

describe('newChallenge', () => {
  test('is 32 random bytes as base64url, different every time', () => {
    const challenges = new Set(Array.from({ length: 50 }, () => WebAuthn.newChallenge()))
    expect(challenges.size).toBe(50)
    for (const challenge of challenges) {
      expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(Buffer.from(challenge, 'base64url')).toHaveLength(WebAuthn.CHALLENGE_BYTES)
    }
  })
})

describe('counterRegressed', () => {
  test.each([
    [0, 0, false],
    [0, 1, false],
    [5, 6, false],
    [5, 5, true],
    [5, 4, true],
    [5, 0, true],
    [2 ** 31, 2 ** 31 + 1, false],
  ])('stored %p, presented %p: %p', (stored, presented, expected) => {
    expect(WebAuthn.counterRegressed(stored, presented)).toBe(expected)
  })
})

describe('verifyRegistration', () => {
  test('accepts a response for the challenge, origin and relying party, with the user verified', async () => {
    const { authenticator, credential } = await registered()
    expect(credential).toMatchObject({
      credentialId: authenticator.credentialIds[0],
      signCount: 0,
      transports: ['internal'],
      aaguid: '00000000-0000-0000-0000-000000000000',
      backupEligible: false,
      backedUp: false,
    })
    expect(credential.publicKey).toBeInstanceOf(Uint8Array)
    expect(credential.publicKey.length).toBeGreaterThan(64)
  })

  test('records a synced credential as backup-eligible and backed up', async () => {
    expect((await registered({ synced: true })).credential).toMatchObject({
      backupEligible: true,
      backedUp: true,
    })
  })

  test.each<[string, object, Partial<WebAuthn.Expected>]>([
    ['another challenge', {}, { challenge: WebAuthn.newChallenge() }],
    ['another origin', {}, { origins: ['https://evil.test'] }],
    ['a look-alike origin', {}, { origins: ['https://app.northline.test.evil.test'] }],
    ['another relying party', {}, { rpId: 'evil.test' }],
    ['an RP ID hash for another relying party', { rpId: 'evil.test' }, {}],
    ['no user verification', { userVerified: false }, {}],
  ])('refuses a response made with %s', async (_, input, expectedOverride) => {
    const challenge = WebAuthn.newChallenge()
    const response = await new VirtualAuthenticator().create(creation(challenge), {
      origin,
      ...input,
    })
    expect(
      await WebAuthn.verifyRegistration(response, {
        challenge,
        origins: [origin],
        rpId,
        ...expectedOverride,
      })
    ).toBeNull()
  })

  test.each<[string, unknown]>([
    ['nothing', null],
    ['a string', 'credential'],
    ['an empty object', {}],
    [
      'garbage where the attestation belongs',
      {
        id: 'a',
        rawId: 'a',
        type: 'public-key',
        response: { clientDataJSON: 'e30', attestationObject: 'AAAA' },
      },
    ],
  ])('refuses %s without throwing', async (_, response) => {
    expect(
      await WebAuthn.verifyRegistration(response, { challenge: 'x', origins: [origin], rpId })
    ).toBeNull()
  })

  test('refuses a create response replayed as if it were for a get ceremony type', async () => {
    const authenticator = new VirtualAuthenticator()
    const challenge = WebAuthn.newChallenge()
    const made = await authenticator.create(creation(challenge), { origin })
    const assertion = await authenticator.get({ challenge, rpId }, { origin })
    // An assertion's client data (`webauthn.get`) in a registration response.
    expect(
      await WebAuthn.verifyRegistration(
        {
          ...made,
          response: { ...made.response, clientDataJSON: assertion.response.clientDataJSON },
        },
        { challenge, origins: [origin], rpId }
      )
    ).toBeNull()
  })
})

describe('verifyAssertion', () => {
  const sign = async (authenticator: VirtualAuthenticator, challenge: string, input: object = {}) =>
    authenticator.get({ challenge, rpId, userVerification: 'required' }, { origin, ...input })

  test('accepts a signature by the stored key and reports the counter and backup flags', async () => {
    const { authenticator, credential } = await registered()
    const challenge = WebAuthn.newChallenge()
    expect(
      await WebAuthn.verifyAssertion(
        await sign(authenticator, challenge, { counter: 9 }),
        { challenge, origins: [origin], rpId },
        credential
      )
    ).toEqual({ signCount: 9, backupEligible: false, backedUp: false })
    expect(
      await WebAuthn.verifyAssertion(
        await sign(authenticator, challenge, { synced: true }),
        { challenge, origins: [origin], rpId },
        credential
      )
    ).toEqual({ signCount: 0, backupEligible: true, backedUp: true })
  })

  test('does not judge the counter: a lower one still verifies, for the caller to refuse', async () => {
    const { authenticator, credential } = await registered()
    const challenge = WebAuthn.newChallenge()
    const verified = await WebAuthn.verifyAssertion(
      await sign(authenticator, challenge, { counter: 1 }),
      { challenge, origins: [origin], rpId },
      { ...credential }
    )
    expect(verified?.signCount).toBe(1)
  })

  test.each<[string, object, Partial<WebAuthn.Expected>]>([
    ['another challenge', {}, { challenge: WebAuthn.newChallenge() }],
    ['another origin', {}, { origins: ['https://evil.test'] }],
    ['another relying party', {}, { rpId: 'evil.test' }],
    ['an RP ID hash for another relying party', { rpId: 'evil.test' }, {}],
    ['no user verification', { userVerified: false }, {}],
  ])('refuses an assertion made with %s', async (_, input, expectedOverride) => {
    const { authenticator, credential } = await registered()
    const challenge = WebAuthn.newChallenge()
    expect(
      await WebAuthn.verifyAssertion(
        await sign(authenticator, challenge, input),
        { challenge, origins: [origin], rpId, ...expectedOverride },
        credential
      )
    ).toBeNull()
  })

  test('refuses a signature by another key, and a tampered signature or authenticator data', async () => {
    const { authenticator, credential } = await registered()
    const other = await registered()
    const challenge = WebAuthn.newChallenge()
    const assertion = await sign(authenticator, challenge)
    const expected = { challenge, origins: [origin], rpId }
    expect(await WebAuthn.verifyAssertion(assertion, expected, other.credential)).toBeNull()
    const flipped = Buffer.from(assertion.response.signature, 'base64url')
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 0x01
    expect(
      await WebAuthn.verifyAssertion(
        {
          ...assertion,
          response: { ...assertion.response, signature: flipped.toString('base64url') },
        },
        expected,
        credential
      )
    ).toBeNull()
    // Authenticator data from another assertion (a higher counter) under this signature.
    const later = await sign(authenticator, challenge, { counter: 50 })
    expect(
      await WebAuthn.verifyAssertion(
        {
          ...assertion,
          response: { ...assertion.response, authenticatorData: later.response.authenticatorData },
        },
        expected,
        credential
      )
    ).toBeNull()
    // The untouched one still verifies.
    expect(await WebAuthn.verifyAssertion(assertion, expected, credential)).not.toBeNull()
  })

  test.each<[string, unknown]>([
    ['nothing', null],
    ['an empty object', {}],
    ['a registration response', { id: 'a', rawId: 'a', type: 'public-key', response: {} }],
  ])('refuses %s without throwing', async (_, response) => {
    const { credential } = await registered()
    expect(
      await WebAuthn.verifyAssertion(
        response,
        { challenge: 'x', origins: [origin], rpId },
        credential
      )
    ).toBeNull()
  })

  test('refuses a stored key that is not a COSE key, without throwing', async () => {
    const { authenticator, credential } = await registered()
    const challenge = WebAuthn.newChallenge()
    expect(
      await WebAuthn.verifyAssertion(
        await sign(authenticator, challenge),
        { challenge, origins: [origin], rpId },
        { ...credential, publicKey: new Uint8Array([1, 2, 3]) }
      )
    ).toBeNull()
  })
})
