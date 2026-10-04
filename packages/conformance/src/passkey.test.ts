import { describe, expect, test } from 'bun:test'
import { fromBase64Url, toBase64Url, VirtualAuthenticator } from './passkey'
import { runScenario, type Target } from './runner'
import { ScenarioSchema, StepSchema } from './scenario'

const origin = 'https://app.northline.test'
const creation = (extra: object = {}) => ({
  rp: { id: 'northline.test', name: 'Northline' },
  user: { id: 'dXNlci1oYW5kbGU', name: 'maya@northline.app', displayName: 'Maya' },
  challenge: 'Y2hhbGxlbmdlLTE',
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  excludeCredentials: [],
  ...extra,
})
const request = (extra: object = {}) => ({
  challenge: 'Y2hhbGxlbmdlLTI',
  rpId: 'northline.test',
  userVerification: 'required',
  ...extra,
})

const decoder = new TextDecoder()
const json = (encoded: string) => JSON.parse(decoder.decode(fromBase64Url(encoded)))
const sha256 = async (text: string) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))

/** The authenticator data inside an attestation object made by `create`. */
function authDataOf(attestationObject: string): Uint8Array {
  const bytes = fromBase64Url(attestationObject)
  const marker = new TextEncoder().encode('authData')
  const at = bytes.findIndex((_, index) => marker.every((byte, n) => bytes[index + n] === byte))
  const start = at + marker.length
  // 0x58 len8 or 0x59 len16.
  return bytes[start] === 0x58 ? bytes.slice(start + 2) : bytes.slice(start + 3)
}

/** DER `SEQUENCE { INTEGER r, INTEGER s }` back to the `r || s` Web Crypto verifies. */
function rawSignature(der: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(64)
  let offset = 2
  for (const position of [0, 32]) {
    const length = der[offset + 1] ?? 0
    const value = der.slice(offset + 2, offset + 2 + length)
    const trimmed = value.length > 32 ? value.slice(value.length - 32) : value
    out.set(trimmed, position + 32 - trimmed.length)
    offset += 2 + length
  }
  return out
}

describe('base64url', () => {
  test('round-trips bytes without padding and with the URL alphabet', () => {
    const bytes = new Uint8Array([251, 255, 0, 1, 2])
    expect(toBase64Url(bytes)).toBe('-_8AAQI')
    expect(fromBase64Url('-_8AAQI')).toEqual(bytes)
    expect(() => fromBase64Url('a+b=')).toThrow('not base64url')
  })
})

describe('VirtualAuthenticator', () => {
  test('create answers with client data for the challenge and origin and an attested P-256 key', async () => {
    const authenticator = new VirtualAuthenticator()
    const made = await authenticator.create(creation(), { origin })
    expect(made).toMatchObject({ type: 'public-key', rawId: made.id })
    expect(authenticator.credentialIds).toEqual([made.id])
    expect(json(made.response.clientDataJSON)).toEqual({
      type: 'webauthn.create',
      challenge: 'Y2hhbGxlbmdlLTE',
      origin,
      crossOrigin: false,
    })
    const authData = authDataOf(made.response.attestationObject)
    expect(authData.slice(0, 32)).toEqual(await sha256('northline.test'))
    // UP | UV | AT, counter 0, a zero AAGUID, then the 32-byte credential id.
    expect(authData[32]).toBe(0x45)
    expect([...authData.slice(33, 37)]).toEqual([0, 0, 0, 0])
    expect([...authData.slice(53, 55)]).toEqual([0, 32])
    expect(toBase64Url(authData.slice(55, 87))).toBe(made.id)
    // COSE_Key: a map of five, EC2, ES256, P-256.
    expect([...authData.slice(87, 95)]).toEqual([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21])
  })

  test('the flags follow the ceremony: no user verification, a synced credential, a counter', async () => {
    const authenticator = new VirtualAuthenticator()
    const made = await authenticator.create(creation(), {
      origin,
      userVerified: false,
      synced: true,
      counter: 7,
    })
    const authData = authDataOf(made.response.attestationObject)
    // UP | BE | BS | AT, and no UV.
    expect(authData[32]).toBe(0x59)
    expect([...authData.slice(33, 37)]).toEqual([0, 0, 0, 7])
    // A synced credential keeps saying so when it signs.
    const assertion = await authenticator.get(request(), { origin })
    expect(fromBase64Url(assertion.response.authenticatorData)[32]).toBe(0x1d)
  })

  test('get signs the authenticator data and the client data hash with the credential key', async () => {
    const authenticator = new VirtualAuthenticator()
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])
    expect(pair.publicKey.type).toBe('public')
    const made = await authenticator.create(creation(), { origin })
    const authData = authDataOf(made.response.attestationObject)
    // x and y sit after their CBOR byte-string heads (0x58 0x20).
    const x = authData.slice(97, 129)
    const y = authData.slice(132, 164)
    const publicKey = await crypto.subtle.importKey(
      'raw',
      new Uint8Array([4, ...x, ...y]),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    )
    for (let round = 0; round < 8; round++) {
      const assertion = await authenticator.get(request(), { origin, counter: round })
      expect(assertion.id).toBe(made.id)
      expect(assertion.response.userHandle).toBe('dXNlci1oYW5kbGU')
      expect(json(assertion.response.clientDataJSON)).toMatchObject({
        type: 'webauthn.get',
        challenge: 'Y2hhbGxlbmdlLTI',
        origin,
      })
      const data = fromBase64Url(assertion.response.authenticatorData)
      expect(data.length).toBe(37)
      expect(data[32]).toBe(0x05)
      expect(new DataView(data.buffer).getUint32(33)).toBe(round)
      const clientHash = new Uint8Array(
        await crypto.subtle.digest('SHA-256', fromBase64Url(assertion.response.clientDataJSON))
      )
      expect(
        await crypto.subtle.verify(
          { name: 'ECDSA', hash: 'SHA-256' },
          publicKey,
          rawSignature(fromBase64Url(assertion.response.signature)),
          new Uint8Array([...data, ...clientHash])
        )
      ).toBe(true)
    }
  })

  test('get picks the listed credential, or the newest one for the relying party', async () => {
    const authenticator = new VirtualAuthenticator()
    const first = await authenticator.create(creation(), { origin })
    const second = await authenticator.create(creation(), { origin })
    const other = await authenticator.create(creation({ rp: { id: 'other.test', name: 'O' } }), {
      origin,
    })
    expect((await authenticator.get(request(), { origin })).id).toBe(second.id)
    expect(
      (
        await authenticator.get(
          request({ allowCredentials: [{ type: 'public-key', id: first.id }] }),
          { origin }
        )
      ).id
    ).toBe(first.id)
    expect((await authenticator.get(request({ rpId: 'other.test' }), { origin })).id).toBe(other.id)
    // A wrong relying party can be signed for on purpose: the hash is the override's.
    const wrong = await authenticator.get(request(), { origin, rpId: 'evil.test' })
    expect(fromBase64Url(wrong.response.authenticatorData).slice(0, 32)).toEqual(
      await sha256('evil.test')
    )
    authenticator.forget(second.id)
    expect((await authenticator.get(request(), { origin })).id).toBe(first.id)
  })

  test.each<[string, () => Promise<unknown>, string]>([
    [
      'creation options without a challenge',
      () => new VirtualAuthenticator().create(creation({ challenge: undefined }), { origin }),
      'no challenge',
    ],
    [
      'creation options without a relying party',
      () => new VirtualAuthenticator().create(creation({ rp: undefined }), { origin }),
      'no relying-party id',
    ],
    [
      'creation options without a user',
      () => new VirtualAuthenticator().create(creation({ user: 'x' }), { origin }),
      'no user id',
    ],
    [
      'creation options that do not offer ES256',
      () =>
        new VirtualAuthenticator().create(
          creation({ pubKeyCredParams: [{ type: 'public-key', alg: -257 }] }),
          { origin }
        ),
      'ES256',
    ],
    [
      'creation options with no algorithms',
      () => new VirtualAuthenticator().create(creation({ pubKeyCredParams: 'x' }), { origin }),
      'ES256',
    ],
    [
      'request options with no credential to use',
      () => new VirtualAuthenticator().get(request(), { origin }),
      'holds no credential',
    ],
    [
      'request options that are not an object',
      () => new VirtualAuthenticator().get(null, { origin }),
      'no challenge',
    ],
  ])('%s are refused', async (_, run, message) => {
    await expect(run()).rejects.toThrow(message)
  })

  test('an authenticator refuses to make a second credential where one is excluded', async () => {
    const authenticator = new VirtualAuthenticator()
    const made = await authenticator.create(creation(), { origin })
    await expect(
      authenticator.create(
        creation({ excludeCredentials: [{ type: 'public-key', id: made.id }] }),
        { origin }
      )
    ).rejects.toThrow('already holds')
  })
})

describe('the passkey step', () => {
  const scenario = (steps: unknown[]) =>
    ScenarioSchema.parse({ name: 'test', description: 'A test scenario.', steps })

  function target() {
    const bodies: unknown[] = []
    const made: Target = {
      baseUrl: 'http://tula.test',
      publishableKey: 'tula_pk_test',
      secretKey: 'tula_sk_test',
      fetch: async (sent) => {
        const text = await sent.text()
        bodies.push(text ? JSON.parse(text) : undefined)
        const path = new URL(sent.url).pathname
        return Response.json(
          path.endsWith('/options') ? creation() : path.endsWith('/start') ? request() : {}
        )
      },
      emailCode: async () => '123459',
      wait: async () => {},
    }
    return { target: made, bodies }
  }

  const fetchOptions = (name: string, path: string, variable: string) => ({
    name,
    request: { method: 'POST', path },
    expect: { status: 200 },
    captureJson: { [variable]: '' },
  })
  const send = (name: string, variable: string) => ({
    name,
    request: {
      method: 'POST',
      path: '/submit',
      body: { credential: { $json: `{{${variable}}}` } },
    },
    expect: { status: 200 },
  })

  test('one named authenticator registers in one step and signs in a later one', async () => {
    const { target: fake, bodies } = target()
    const result = await runScenario(
      scenario([
        fetchOptions('creation options', '/options', 'creationOptions'),
        {
          name: 'the phone makes a passkey',
          passkey: {
            authenticator: 'phone',
            create: '{{creationOptions}}',
            origin,
            capture: 'registration',
            synced: true,
          },
        },
        send('register', 'registration'),
        fetchOptions('request options', '/start', 'requestOptions'),
        {
          name: 'the phone signs',
          passkey: {
            authenticator: 'phone',
            get: '{{requestOptions}}',
            origin,
            capture: 'assertion',
            counter: 3,
            userVerified: false,
          },
        },
        send('sign in', 'assertion'),
      ]),
      fake
    )
    expect(result.status).toBe('passed')
    const registration = (bodies[1] as { credential: { id: string } }).credential
    const assertion = (
      bodies[3] as { credential: { id: string; response: { authenticatorData: string } } }
    ).credential
    expect(assertion.id).toBe(registration.id)
    const data = fromBase64Url(assertion.response.authenticatorData)
    // UP | BE | BS, no UV; counter 3.
    expect(data[32]).toBe(0x19)
    expect(data[36]).toBe(3)
  })

  test('another authenticator holds nothing: the step fails without quoting the options', async () => {
    const { target: fake } = target()
    const result = await runScenario(
      scenario([
        fetchOptions('request options', '/start', 'requestOptions'),
        {
          name: 'a laptop with no passkey',
          passkey: { authenticator: 'laptop', get: '{{requestOptions}}', origin, capture: 'a' },
        },
      ]),
      fake
    )
    expect(result.status).toBe('failed')
    expect(JSON.stringify(result)).toContain('holds no credential')
    expect(JSON.stringify(result)).not.toContain('Y2hhbGxlbmdlLTI')
  })

  test('options that are not JSON fail the step without being printed', async () => {
    const { target: fake } = target()
    const result = await runScenario(
      ScenarioSchema.parse({
        name: 'test',
        description: 'A test scenario.',
        variables: { options: 'secret-not-json' },
        steps: [
          {
            name: 'sign',
            passkey: { authenticator: 'phone', get: '{{options}}', origin, capture: 'a' },
          },
        ],
      }),
      fake
    )
    expect(result.status).toBe('failed')
    expect(JSON.stringify(result)).toContain('not valid JSON')
    expect(JSON.stringify(result)).not.toContain('secret-not-json')
  })

  test('a passkey step takes exactly one of create and get, and no unknown key', () => {
    const base = { authenticator: 'phone', origin, capture: 'c' }
    const parse = (passkey: object) => StepSchema.safeParse({ name: 'x', passkey }).success
    expect(parse({ ...base, create: '{{o}}' })).toBe(true)
    expect(parse({ ...base, get: '{{o}}' })).toBe(true)
    expect(parse(base)).toBe(false)
    expect(parse({ ...base, create: '{{o}}', get: '{{o}}' })).toBe(false)
    expect(parse({ ...base, get: '{{o}}', counter: -1 })).toBe(false)
    expect(parse({ ...base, get: '{{o}}', rpId: 'evil.test' })).toBe(false)
  })
})
