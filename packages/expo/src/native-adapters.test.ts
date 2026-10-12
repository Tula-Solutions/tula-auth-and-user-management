import { describe, expect, test } from 'bun:test'
import { createDpopProof, jwkThumbprint } from '@tula/contract/device-binding'
import { verifyProof } from '../../../apps/api/src/lib/dpop'
import { createDeviceBinding } from './device-binding'
import { type DeviceCryptoModuleLike, deviceKeyStoreOver } from './device-key-adapter'
import { DEVICE_KEY_ALIAS } from './device-key-store'
import {
  type AppleAuthenticationModuleLike,
  appleSheetOver,
  type GoogleSignInModuleLike,
  googleSheetOver,
} from './id-token-adapters'

// The adapters of the three native modules added with ADR 0051, each over a fake of its
// module: what a module's answers and failures become, and that nothing of a module's own
// text leaves an adapter. None of the modules is installed here, and none was run.

const CANARY = 'module-canary-9d41'

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a rejection')
}

/** An error as an Expo module rejects with one: a code, and a message of its own. */
function coded(code: string): Error {
  return Object.assign(new Error(`${code}: ${CANARY}`), { code })
}

describe('Sign in with Apple’s sheet over expo-apple-authentication', () => {
  function apple(
    signIn: AppleAuthenticationModuleLike['signInAsync'],
    available: () => Promise<boolean> = async () => true
  ) {
    const asked: unknown[] = []
    const sheet = appleSheetOver({
      isAvailableAsync: available,
      signInAsync(options) {
        asked.push(options)
        return signIn(options)
      },
      AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
    })
    return { sheet, asked }
  }

  test('asks for the name and the address with the nonce it was given, unchanged, and keeps the token and the names', async () => {
    const { sheet, asked } = apple(async () => ({
      identityToken: 'apple.id.token',
      fullName: { givenName: 'Maya', familyName: 'Okafor', nickname: 'M' } as never,
      user: 'apple-user-id',
      email: 'maya@example.com',
      authorizationCode: 'code',
    }))
    expect(await sheet.signIn({ nonce: 'hashed-nonce' })).toEqual({
      idToken: 'apple.id.token',
      givenName: 'Maya',
      familyName: 'Okafor',
    })
    expect(asked).toEqual([{ requestedScopes: [0, 1], nonce: 'hashed-nonce' }])
  })

  test('a later sign-in hands over no name: the token alone', async () => {
    const { sheet } = apple(async () => ({
      identityToken: 'apple.id.token',
      fullName: { givenName: null, familyName: '' },
    }))
    expect(await sheet.signIn({ nonce: 'n' })).toEqual({
      idToken: 'apple.id.token',
      givenName: undefined,
      familyName: undefined,
    })
    const none = apple(async () => ({ identityToken: 'apple.id.token', fullName: null }))
    expect((await none.sheet.signIn({ nonce: 'n' }))?.idToken).toBe('apple.id.token')
  })

  test('a dismissed sheet is null, never a failure', async () => {
    const { sheet } = apple(async () => {
      throw coded('ERR_REQUEST_CANCELED')
    })
    expect(await sheet.signIn({ nonce: 'n' })).toBeNull()
  })

  test.each([
    ['another code', () => coded('ERR_REQUEST_FAILED')],
    ['no code', () => new Error(CANARY)],
    ['a thrown string', () => CANARY],
  ])('a failure with %s is a failure with none of the module’s text', async (_name, thrown) => {
    const { sheet } = apple(async () => {
      throw thrown()
    })
    const error = await rejection(sheet.signIn({ nonce: 'n' }))
    expect(error.message).toBe('Sign in with Apple failed.')
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(CANARY)
    expect(error.cause).toBeUndefined()
  })

  test.each([[null], [''], [42], [undefined]])(
    'an identity token of %j is a failure',
    async (identityToken) => {
      const { sheet } = apple(async () => ({ identityToken, fullName: null }))
      expect((await rejection(sheet.signIn({ nonce: 'n' }))).message).toBe(
        'Sign in with Apple returned no identity token.'
      )
    }
  )

  test('is available only when the module says true; a module that cannot say is not', async () => {
    expect(
      await apple(
        async () => ({}),
        async () => true
      ).sheet.isAvailable()
    ).toBe(true)
    expect(
      await apple(
        async () => ({}),
        async () => false
      ).sheet.isAvailable()
    ).toBe(false)
    expect(
      await apple(
        async () => ({}),
        async () => 'yes' as never
      ).sheet.isAvailable()
    ).toBe(false)
    expect(
      await apple(
        async () => ({}),
        async () => {
          throw new Error(CANARY)
        }
      ).sheet.isAvailable()
    ).toBe(false)
  })
})

describe('Google’s sheet over react-native-nitro-google-signin', () => {
  const IDS = {
    webClientId: 'web.apps.googleusercontent.com',
    iosClientId: 'ios.apps.googleusercontent.com',
  }

  function google(
    present: GoogleSignInModuleLike['presentExplicitSignIn'],
    parts: Partial<GoogleSignInModuleLike> = {},
    ids: Parameters<typeof googleSheetOver>[1] = IDS
  ) {
    const calls: unknown[] = []
    const sheet = googleSheetOver(
      {
        configure(params) {
          calls.push(['configure', params])
        },
        async checkPlayServices(dialog) {
          calls.push(['checkPlayServices', dialog])
        },
        presentExplicitSignIn() {
          calls.push(['present'])
          return present()
        },
        ...parts,
      },
      ids
    )
    return { sheet, calls }
  }

  test('sets the nonce it was given, unchanged, with the client ids before every sheet, and keeps the token', async () => {
    const { sheet, calls } = google(async () => ({
      type: 'success',
      data: {
        idToken: 'google.id.token',
        user: { givenName: 'Maya', familyName: 'Okafor', email: 'maya@example.com' } as never,
        serverAuthCode: 'code',
      } as never,
    }))
    expect(await sheet.signIn({ nonce: 'server-nonce' })).toEqual({
      idToken: 'google.id.token',
      givenName: 'Maya',
      familyName: 'Okafor',
    })
    await sheet.signIn({ nonce: 'second-nonce' })
    expect(calls).toEqual([
      ['configure', { ...IDS, nonce: 'server-nonce' }],
      ['present'],
      ['configure', { ...IDS, nonce: 'second-nonce' }],
      ['present'],
    ])
  })

  test('without an iOS client id none is configured', async () => {
    const { sheet, calls } = google(
      async () => ({ type: 'success', data: { idToken: 't' } }),
      {},
      { webClientId: IDS.webClientId }
    )
    await sheet.signIn({ nonce: 'n' })
    expect(calls[0]).toEqual(['configure', { webClientId: IDS.webClientId, nonce: 'n' }])
  })

  test.each([
    ['cancelled as an answer', async () => ({ type: 'cancelled', data: null })],
    ['no saved credential', async () => ({ type: 'noSavedCredentialFound', data: null })],
    [
      'cancelled as a rejection',
      async () => {
        throw coded('SIGN_IN_CANCELLED')
      },
    ],
  ])('%s is null, never a failure', async (_name, present) => {
    expect(await google(present).sheet.signIn({ nonce: 'n' })).toBeNull()
  })

  test.each([
    [
      'a rejection of another code',
      async () => {
        throw coded('DEVELOPER_ERROR')
      },
      'Sign in with Google failed.',
    ],
    ['a success with no data', async () => ({ type: 'success', data: null }), 'no ID token'],
    [
      'a success with an empty token',
      async () => ({ type: 'success', data: { idToken: '' } }),
      'no ID token',
    ],
    [
      'an answer of an unknown type',
      async () => ({ type: 'later', data: { idToken: 't' } }),
      'no ID token',
    ],
    ['no answer', async () => undefined as never, 'no ID token'],
  ])('%s is a failure with none of the module’s text', async (_name, present, message) => {
    const error = await rejection(google(present).sheet.signIn({ nonce: 'n' }))
    expect(error.message).toContain(message)
    expect(error.message).not.toContain(CANARY)
    expect(error.cause).toBeUndefined()
  })

  test('a configure that throws is a failure, and no sheet is shown', async () => {
    const { sheet, calls } = google(async () => ({ type: 'success', data: { idToken: 't' } }), {
      configure() {
        throw new Error(CANARY)
      },
    })
    expect((await rejection(sheet.signIn({ nonce: 'n' }))).message).toBe(
      'Sign in with Google failed.'
    )
    expect(calls).toEqual([])
  })

  test('is available when Play Services answer, asked without Google’s own dialog; not when they do not', async () => {
    const there = google(async () => ({ type: 'cancelled' }))
    expect(await there.sheet.isAvailable()).toBe(true)
    expect(there.calls).toEqual([['checkPlayServices', false]])
    const missing = google(async () => ({ type: 'cancelled' }), {
      async checkPlayServices() {
        throw coded('PLAY_SERVICES_NOT_AVAILABLE')
      },
    })
    expect(await missing.sheet.isAvailable()).toBe(false)
    const unlinked = google(async () => ({ type: 'cancelled' }), {
      checkPlayServices() {
        throw new Error(CANARY)
      },
    })
    expect(await unlinked.sheet.isAvailable()).toBe(false)
  })
})

/** A DER `SEQUENCE { INTEGER r, INTEGER s }` from a raw `r` then `s`. */
function der(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array) => {
    let at = 0
    while (at < bytes.length - 1 && bytes[at] === 0) {
      at += 1
    }
    const trimmed = bytes.subarray(at)
    const padded = (trimmed[0] as number) & 0x80 ? [0, ...trimmed] : [...trimmed]
    return [0x02, padded.length, ...padded]
  }
  const body = [...integer(raw.subarray(0, 32)), ...integer(raw.subarray(32))]
  return Uint8Array.from([0x30, body.length, ...body])
}

/** An error as `@pagopa/io-react-native-crypto` rejects with one: its message is the word. */
function word(message: string): Error {
  return new Error(message)
}

/**
 * The module as its sources describe it, over WebCrypto keys: `getPublicKeyFixed` rejects
 * with `PUBLIC_KEY_NOT_FOUND` for a tag with no key, `generate` refuses a tag that has one,
 * `sign` answers base64 DER.
 */
function cryptoModule() {
  const keys = new Map<string, CryptoKeyPair>()
  const calls: string[] = []
  const jwkOf = async (pair: CryptoKeyPair) => {
    const { x, y } = await crypto.subtle.exportKey('jwk', pair.publicKey)
    return { kty: 'EC', crv: 'P-256', x, y }
  }
  const module: DeviceCryptoModuleLike & {
    keys: Map<string, CryptoKeyPair>
    calls: string[]
    signed: string[]
  } = {
    keys,
    calls,
    signed: [],
    async getPublicKeyFixed(tag) {
      calls.push(`get ${tag}`)
      const pair = keys.get(tag)
      if (!pair) {
        throw word('PUBLIC_KEY_NOT_FOUND')
      }
      return jwkOf(pair)
    },
    async generate(tag) {
      calls.push(`generate ${tag}`)
      if (keys.has(tag)) {
        throw word('KEY_ALREADY_EXISTS')
      }
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
        'sign',
      ])
      keys.set(tag, pair)
      return jwkOf(pair)
    },
    async sign(message, tag) {
      calls.push(`sign ${tag}`)
      module.signed.push(message)
      const pair = keys.get(tag)
      if (!pair) {
        throw word('PUBLIC_KEY_NOT_FOUND')
      }
      const raw = new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          pair.privateKey,
          new TextEncoder().encode(message)
        )
      )
      return Buffer.from(der(raw)).toString('base64')
    },
    async deleteKey(tag) {
      calls.push(`delete ${tag}`)
      keys.delete(tag)
    },
  }
  return module
}

describe('the device key store over @pagopa/io-react-native-crypto', () => {
  test('makes a key when there is none, finds it afterwards, and says which it was', async () => {
    const module = cryptoModule()
    const store = deviceKeyStoreOver(module)
    const made = await store.obtain(DEVICE_KEY_ALIAS)
    expect(made.created).toBe(true)
    expect(Object.keys(made.publicJwk).sort()).toEqual(['crv', 'kty', 'x', 'y'])
    const found = await store.obtain(DEVICE_KEY_ALIAS)
    expect(found).toEqual({ publicJwk: made.publicJwk, created: false })
    expect(module.calls).toEqual([
      `get ${DEVICE_KEY_ALIAS}`,
      `generate ${DEVICE_KEY_ALIAS}`,
      `get ${DEVICE_KEY_ALIAS}`,
      `get ${DEVICE_KEY_ALIAS}`,
    ])
  })

  test('a proof signed through it is one the server’s verifier accepts, many times over', async () => {
    const module = cryptoModule()
    const { source } = createDeviceBinding({
      store: deviceKeyStoreOver(module),
      storage: { get: async () => null, set: async () => {}, remove: async () => {} },
    })
    const key = await source?.('startSignIn')
    if (!key) {
      throw new Error('no key')
    }
    // Enough signatures that `r` or `s` comes out short or with a high bit several times:
    // the two cases the DER form writes differently.
    for (let at = 0; at < 60; at += 1) {
      const url = 'https://auth.example.com/v1/client/sign-ins'
      const proof = await createDpopProof(key, { method: 'POST', url })
      const verified = await verifyProof(proof, { method: 'POST', url, now: new Date() })
      expect(verified.ok, `proof ${at}`).toBe(true)
      if (verified.ok) {
        expect(verified.proof.thumbprint).toBe(await jwkThumbprint(key.publicJwk))
      }
    }
    // The module was handed the proof's signing input as text: two base64url parts.
    expect(module.signed[0]).toMatch(/^[\w-]+\.[\w-]+$/)
  })

  test('“not found” is a key that is gone only when a key could be made: a lookup that failed for another reason is a rejection', async () => {
    const module = cryptoModule()
    const store = deviceKeyStoreOver(module)
    await store.obtain(DEVICE_KEY_ALIAS)
    // A locked device, as the iOS module reports it: the lookup says "not found", and
    // `generate` refuses because something is there.
    const locked = { ...module }
    locked.getPublicKeyFixed = async () => {
      throw word('PUBLIC_KEY_NOT_FOUND')
    }
    const error = await rejection(deviceKeyStoreOver(locked).obtain(DEVICE_KEY_ALIAS))
    expect(error.message).toBe('The device key store failed.')
    expect(module.keys.size).toBe(1)
  })

  test.each([
    ['KEYCHAIN_LOAD_FAILED'],
    ['KEYSTORE_LOAD_FAILED'],
    ['UNKNOWN_EXCEPTION'],
    [`something else ${CANARY}`],
  ])('a lookup that rejects with %s is a rejection, and no key is made', async (message) => {
    const module = cryptoModule()
    module.getPublicKeyFixed = async () => {
      throw word(message)
    }
    const error = await rejection(deviceKeyStoreOver(module).obtain(DEVICE_KEY_ALIAS))
    expect(error.message).toBe('The device key store failed.')
    expect(error.cause).toBeUndefined()
    expect(module.calls).toEqual([])
  })

  test('a device that can only make an RSA key has no key store: the key is deleted, and the store says so from then on', async () => {
    const module = cryptoModule()
    const rsa = { kty: 'RSA', alg: 'RS256', e: 'AQAB', n: 'modulus' }
    let made = false
    module.getPublicKeyFixed = async () => {
      if (!made) {
        throw word('PUBLIC_KEY_NOT_FOUND')
      }
      return rsa
    }
    module.generate = async () => {
      made = true
      return rsa
    }
    const store = deviceKeyStoreOver(module)
    expect(await store.isAvailable()).toBe(true)
    await rejection(store.obtain(DEVICE_KEY_ALIAS))
    expect(module.calls).toEqual([`delete ${DEVICE_KEY_ALIAS}`])
    expect(await store.isAvailable()).toBe(false)
  })

  test.each([['WRONG_KEY_CONFIGURATION'], ['UNSUPPORTED_DEVICE'], ['API_LEVEL_NOT_SUPPORTED']])(
    'nothing under the tag and a key that cannot be made (%s): no key store from then on',
    async (message) => {
      const module = cryptoModule()
      module.generate = async () => {
        throw word(message)
      }
      const store = deviceKeyStoreOver(module)
      expect(await store.isAvailable()).toBe(true)
      const error = await rejection(store.obtain(DEVICE_KEY_ALIAS))
      expect(error.message).toBe('The device key store failed.')
      expect(await store.isAvailable()).toBe(false)
    }
  )

  test.each([
    ['KEY_ALREADY_EXISTS'],
    ['KEYSTORE_LOAD_FAILED'],
    ['UNKNOWN_EXCEPTION'],
    [`something else ${CANARY}`],
  ])(
    'a key that was not made for another reason (%s) says nothing about the device: the store is still there',
    async (message) => {
      const module = cryptoModule()
      module.generate = async () => {
        throw word(message)
      }
      const store = deviceKeyStoreOver(module)
      await rejection(store.obtain(DEVICE_KEY_ALIAS))
      expect(await store.isAvailable()).toBe(true)
    }
  )

  test('a key that is there and is not P-256 is a rejection, and is left alone', async () => {
    const module = cryptoModule()
    module.getPublicKeyFixed = async () => ({ kty: 'EC', crv: 'P-384', x: 'x', y: 'y' })
    await rejection(deviceKeyStoreOver(module).obtain(DEVICE_KEY_ALIAS))
    expect(module.calls).toEqual([])
  })

  test('is available with or without a key; not where the module throws at the call or names a device that cannot', async () => {
    const module = cryptoModule()
    expect(await deviceKeyStoreOver(module).isAvailable()).toBe(true)
    await module.generate(DEVICE_KEY_ALIAS)
    expect(await deviceKeyStoreOver(module).isAvailable()).toBe(true)

    // Expo Go: the module is a proxy that throws a linking error at every call.
    const unlinked = deviceKeyStoreOver({
      getPublicKeyFixed() {
        throw new Error(`The package doesn't seem to be linked ${CANARY}`)
      },
    } as never)
    expect(await unlinked.isAvailable()).toBe(false)

    for (const message of ['UNSUPPORTED_DEVICE', 'API_LEVEL_NOT_SUPPORTED']) {
      const unable = cryptoModule()
      unable.getPublicKeyFixed = async () => {
        throw word(message)
      }
      expect(await deviceKeyStoreOver(unable).isAvailable(), message).toBe(false)
    }
    // A rejection that names neither is a key store that is there and could not answer:
    // looking for the key will say so.
    const busy = cryptoModule()
    busy.getPublicKeyFixed = async () => {
      throw word('KEYCHAIN_LOAD_FAILED')
    }
    expect(await deviceKeyStoreOver(busy).isAvailable()).toBe(true)
  })

  test.each([
    ['a rejection', async () => Promise.reject(word(`UNABLE_TO_SIGN ${CANARY}`))],
    ['text that is not base64', async () => '***'],
    [
      'bytes that are no DER signature',
      async () => Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]).toString('base64'),
    ],
    [
      'a DER sequence of the wrong length',
      async () => Buffer.from([0x30, 0x10, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]).toString('base64'),
    ],
    [
      'an integer longer than 32 bytes',
      async () =>
        Buffer.from([
          0x30,
          0x27,
          0x02,
          0x22,
          1,
          ...new Array(33).fill(7),
          0x02,
          0x01,
          0x01,
        ]).toString('base64'),
    ],
    [
      'an empty integer',
      async () => Buffer.from([0x30, 0x05, 0x02, 0x00, 0x02, 0x01, 0x01, 0x00]).toString('base64'),
    ],
    [
      'trailing bytes',
      async () =>
        Buffer.from([0x30, 0x08, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, 0x00, 0x00]).toString(
          'base64'
        ),
    ],
    ['no text at all', async () => 7 as never],
  ])('a signature that is %s is a failure with none of the module’s text', async (_name, sign) => {
    const module = cryptoModule()
    module.sign = sign
    const error = await rejection(
      deviceKeyStoreOver(module).sign(DEVICE_KEY_ALIAS, new Uint8Array([0x61, 0x2e, 0x62]))
    )
    expect(error.message).toBe('The device key store failed.')
    expect(error.cause).toBeUndefined()
  })

  test('a short DER signature is padded to 32 bytes a half', async () => {
    const module = cryptoModule()
    module.sign = async () =>
      Buffer.from([0x30, 0x06, 0x02, 0x01, 0x05, 0x02, 0x01, 0x09]).toString('base64')
    const raw = await deviceKeyStoreOver(module).sign(DEVICE_KEY_ALIAS, new Uint8Array([0x61]))
    expect(raw).toHaveLength(64)
    expect(raw[31]).toBe(5)
    expect(raw[63]).toBe(9)
    expect(raw.filter((byte) => byte !== 0)).toHaveLength(2)
  })

  test('bytes that are not ASCII are refused before the module is asked', async () => {
    const module = cryptoModule()
    await rejection(deviceKeyStoreOver(module).sign(DEVICE_KEY_ALIAS, new Uint8Array([0x61, 0xc3])))
    expect(module.calls).toEqual([])
  })
})
