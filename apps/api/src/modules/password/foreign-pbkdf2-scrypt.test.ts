import { describe, expect, test } from 'bun:test'
import type { FirebaseScryptParams } from '@tula-tech/contract'
import { createSecretBox } from '~/lib/secret-box'
import * as Foreign from '~/modules/password/foreign-hash'
import { createTestDeps } from '~/testing'

// PBKDF2-SHA256 and Firebase's scrypt (ADR 0066, TULA-118).

const secretBox = createTestDeps().secretBox
const ENV = '019c0000-0000-7000-8000-000000000001'
const USER = '019c0000-0000-7000-8000-0000000000aa'
const user = { environmentId: ENV, userId: USER }

const PASSWORD = 'correct horse battery staple'

// Made with Python's hashlib, not with this code.
const DJANGO = 'pbkdf2_sha256$260000$Xp9aBcDeFgHi$tPuMiTl59uBGuxPihVmXj2h4nxk2jFn28PP+eoHlEI0='
const SALT_B64 = 'EBESExQVFhcYGRobHB0eHw=='
const HASH_B64 = 'p/4+uPiYOTMFowloGb8J76VHmERbJ/JX0Ljq6Dl9Ykg='
const PASSLIB =
  '$pbkdf2-sha256$600000$EBESExQVFhcYGRobHB0eHw$p/4.uPiYOTMFowloGb8J76VHmERbJ/JX0Ljq6Dl9Ykg'
const PHC =
  '$pbkdf2-sha256$i=600000,l=32$EBESExQVFhcYGRobHB0eHw$p/4+uPiYOTMFowloGb8J76VHmERbJ/JX0Ljq6Dl9Ykg'
const NORMAL =
  '$pbkdf2-sha256$i=600000$EBESExQVFhcYGRobHB0eHw$p/4+uPiYOTMFowloGb8J76VHmERbJ/JX0Ljq6Dl9Ykg'

// firebase/scrypt's README example.
const FIREBASE: FirebaseScryptParams = {
  signerKey:
    'jxspr8Ki0RYycVU8zykbdLGjFQ3McFUH0uiiTvC8pVMXAn210wjLNmdZJzxUECKbm0QsEmYUSDzZvpjeJ9WmXA==',
  saltSeparator: 'Bw==',
  rounds: 8,
  memCost: 14,
}
const FB_PASSWORD = 'user1password'
const FB_SALT = '42xEC+ixf3L2lw=='
const FB_HASH =
  'lSrfV15cpx95/sZS2W9c9Kp6i/LVgQNDNC/qzrCnh1SAyZvqmZqAjTdn3aoItz+VHjoZilo78198JAdRuid5lQ=='
const fbRow = (overrides: { hash?: string; salt?: string | number } = {}) => ({
  algorithm: 'firebase_scrypt',
  hash: overrides.hash ?? FB_HASH,
  params: { salt: overrides.salt ?? FB_SALT },
})

const opener = () => Foreign.opener({ secretBox }, ENV, USER)

async function stored(firebase = FIREBASE, row = fbRow()): Promise<string> {
  const result = await Foreign.prepare({ secretBox }, user, row, firebase)
  if (!result.ok) {
    throw new Error(`refused: ${result.code}`)
  }
  return result.stored
}

describe('PBKDF2-HMAC-SHA256 against published vectors', () => {
  const hex = async (p: string, s: string, c: number, n: number) =>
    (await Foreign.pbkdf2Sha256(p, Buffer.from(s), c, n)).toString('hex')

  test('RFC 7914 section 11', async () => {
    expect(await hex('passwd', 'salt', 1, 64)).toBe(
      '55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783'
    )
    expect(await hex('Password', 'NaCl', 80_000, 64)).toBe(
      '4ddcd8f60b98be21830cee5ef22701f9641a4418d04c0414aeff08876b34ab56a1d425a1225833549adb841b51c9b3176a272bdebba1d078478f62b397f33c8d'
    )
  })

  test('the widely published "password" / "salt" vectors', async () => {
    expect(await hex('password', 'salt', 1, 32)).toBe(
      '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b'
    )
    expect(await hex('password', 'salt', 2, 32)).toBe(
      'ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43'
    )
    expect(await hex('password', 'salt', 4096, 32)).toBe(
      'c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a'
    )
  })
})

describe('PBKDF2-SHA256: the forms that are accepted', () => {
  test.each([
    ['Django', 'pbkdf2_sha256', DJANGO, undefined],
    ['passlib', 'pbkdf2_sha256', PASSLIB, undefined],
    ['PHC with a length', 'pbkdf2_sha256', PHC, undefined],
    ['PHC as this server stores it', 'pbkdf2_sha256', NORMAL, undefined],
    [
      'a derived key with params',
      'pbkdf2_sha256',
      HASH_B64,
      { iterations: 600_000, salt: SALT_B64 },
    ],
  ])('%s', (_name, algorithm, hash, params) => {
    const result = Foreign.parse(algorithm, hash, params)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.algorithm).toBe('pbkdf2_sha256')
      expect(Foreign.detect(result.stored)).toBe('pbkdf2_sha256')
    }
  })

  test('every form is stored as the same PHC string', () => {
    for (const hash of [PASSLIB, PHC, NORMAL]) {
      expect(Foreign.parse('pbkdf2_sha256', hash)).toEqual({
        ok: true,
        algorithm: 'pbkdf2_sha256',
        stored: NORMAL,
      })
    }
    expect(
      Foreign.parse('pbkdf2_sha256', HASH_B64, { iterations: 600_000, salt: SALT_B64 })
    ).toEqual({ ok: true, algorithm: 'pbkdf2_sha256', stored: NORMAL })
  })

  test('each form verifies with its own password and no other', async () => {
    for (const [hash, params] of [
      [DJANGO, undefined],
      [PASSLIB, undefined],
      [PHC, undefined],
      [HASH_B64, { iterations: 600_000, salt: SALT_B64 }],
    ] as const) {
      const parsed = Foreign.parse('pbkdf2_sha256', hash, params)
      if (!parsed.ok) {
        throw new Error(parsed.code)
      }
      expect(await Foreign.verify(parsed.stored, PASSWORD)).toBe(true)
      expect(await Foreign.verify(parsed.stored, `${PASSWORD}!`)).toBe(false)
      expect(await Foreign.verify(parsed.stored, '')).toBe(false)
    }
  })
})

describe('PBKDF2-SHA256: what is refused', () => {
  const refused = (hash: string, params?: Record<string, string | number>) => {
    const result = Foreign.parse('pbkdf2_sha256', hash, params)
    return result.ok ? 'accepted' : result.code
  }
  const django = (iterations: number | string) => DJANGO.replace('$260000$', `$${iterations}$`)

  test('the floor is 100,000 iterations and the ceiling 2,000,000', () => {
    expect(refused(django(99_999))).toBe('import.hash_parameters_too_weak')
    expect(refused(django(1))).toBe('import.hash_parameters_too_weak')
    expect(refused(django(100_000))).toBe('accepted')
    expect(refused(django(2_000_000))).toBe('accepted')
    expect(refused(django(2_000_001))).toBe('import.hash_parameters_too_costly')
    expect(refused(django(999_999_999))).toBe('import.hash_parameters_too_costly')
  })

  test('the same limits apply to every form', () => {
    expect(refused(PHC.replace('600000', '99999'))).toBe('import.hash_parameters_too_weak')
    expect(refused(PASSLIB.replace('600000', '2000001'))).toBe('import.hash_parameters_too_costly')
    expect(refused(HASH_B64, { iterations: 50_000, salt: SALT_B64 })).toBe(
      'import.hash_parameters_too_weak'
    )
    expect(refused(HASH_B64, { iterations: 3_000_000, salt: SALT_B64 })).toBe(
      'import.hash_parameters_too_costly'
    )
  })

  test.each([
    ['an empty hash', ''],
    ['text that is not a hash', 'hunter2'],
    ['a Django hash with a part missing', 'pbkdf2_sha256$260000$Xp9aBcDeFgHi'],
    ['a Django hash with a part too many', `${DJANGO}$x`],
    ['a Django hash whose count is not a number', django('many')],
    ['a Django hash with a negative count', django('-5')],
    ['a Django hash with a fractional count', django('2.5e5')],
    ['a Django hash with a salt under 8 bytes', DJANGO.replace('Xp9aBcDeFgHi', 'short')],
    ['a Django hash with malformed base64', DJANGO.replace('tPuM', 'tP*M')],
    ['a Django hash with a truncated digest', DJANGO.slice(0, -10)],
    ['a Django hash with a digest of 8 bytes', 'pbkdf2_sha256$260000$Xp9aBcDeFgHi$AAAAAAAAAAA='],
    ['PHC with a wrong `l`', PHC.replace('l=32', 'l=33')],
    ['PHC with another hash function', PHC.replace('pbkdf2-sha256', 'pbkdf2-sha1')],
    ['PHC with a part too many', `${PHC}$x`],
    ['PHC with malformed base64', PHC.replace('uPiY', 'uP*Y')],
    ['a derived key with no params', HASH_B64],
    [
      'a salt of 7 bytes',
      `$pbkdf2-sha256$i=600000$${Buffer.alloc(7).toString('base64')}$${HASH_B64}`,
    ],
  ])('%s is malformed', (_name, hash) => {
    expect(refused(hash)).toBe('import.hash_malformed')
  })

  test.each([
    ['a derived key with a non-numeric count', { iterations: '600000', salt: SALT_B64 }],
    ['a derived key with a fractional count', { iterations: 600_000.5, salt: SALT_B64 }],
    ['a derived key with no salt', { iterations: 600_000 }],
    ['a derived key with a numeric salt', { iterations: 600_000, salt: 12345678 }],
    ['a derived key with a salt that is not base64', { iterations: 600_000, salt: '!!!!' }],
  ])('%s is malformed', (_name, params) => {
    expect(refused(HASH_B64, params)).toBe('import.hash_malformed')
  })
})

describe('PBKDF2-SHA256: verification at sign-in', () => {
  test('a stored hash edited past the limits matches nothing', async () => {
    expect(await Foreign.verify(NORMAL.replace('600000', '99999'), PASSWORD)).toBe(false)
    expect(await Foreign.verify(NORMAL.replace('600000', '999999999'), PASSWORD)).toBe(false)
    expect(await Foreign.verify('$pbkdf2-sha256$garbage', PASSWORD)).toBe(false)
  })

  test('a tampered salt or digest matches nothing', async () => {
    expect(await Foreign.verify(NORMAL.replace('EBES', 'EBET'), PASSWORD)).toBe(false)
    expect(await Foreign.verify(NORMAL.replace('p/4+', 'p/4-'), PASSWORD)).toBe(false)
    expect(await Foreign.verify(NORMAL.replace('Ykg', 'Ykh'), PASSWORD)).toBe(false)
  })

  test('another format is left to the caller', async () => {
    expect(await Foreign.verify('$2b$10$abc', PASSWORD)).toBeNull()
    expect(await Foreign.verify('$argon2id$v=19$m=1,t=1,p=1$a$b', PASSWORD)).toBeNull()
  })
})

describe('Firebase scrypt against the published vector', () => {
  test('firebase/scrypt README: user1password', async () => {
    const hash = await stored()
    expect(Foreign.detect(hash)).toBe('firebase_scrypt')
    expect(await Foreign.verify(hash, FB_PASSWORD, opener())).toBe(true)
  })

  test('a wrong password, an empty one and a near miss', async () => {
    const hash = await stored()
    for (const password of ['user1password ', 'User1password', 'user1passwor', '']) {
      expect(await Foreign.verify(hash, password, opener())).toBe(false)
    }
  })

  test('another project key, separator, rounds or cost gives another hash', async () => {
    for (const changed of [
      { ...FIREBASE, saltSeparator: 'Bg==' },
      { ...FIREBASE, rounds: 9 },
      { ...FIREBASE, memCost: 13 },
      {
        ...FIREBASE,
        signerKey: `${FIREBASE.signerKey.slice(0, 10)}A${FIREBASE.signerKey.slice(11)}`,
      },
    ]) {
      expect(await Foreign.verify(await stored(changed), FB_PASSWORD, opener())).toBe(false)
    }
  })
})

describe('Firebase scrypt: the parameters are sealed', () => {
  test('the stored hash holds none of the parameters in the clear', async () => {
    const hash = await stored()
    for (const secret of [FIREBASE.signerKey, FIREBASE.saltSeparator]) {
      expect(hash).not.toContain(secret)
    }
    const sealed = hash.split('$')[3] ?? ''
    expect(Buffer.from(sealed.split('.')[2] ?? '', 'base64url').toString('latin1')).not.toContain(
      FIREBASE.signerKey
    )
    expect(hash).not.toContain(Buffer.from(FIREBASE.signerKey, 'base64').toString('base64url'))
  })

  test('the same parameters are sealed differently each time', async () => {
    expect(await stored()).not.toBe(await stored())
  })

  test('without an opener, or with another user, or another environment, it matches nothing', async () => {
    const hash = await stored()
    expect(await Foreign.verify(hash, FB_PASSWORD)).toBe(false)
    expect(
      await Foreign.verify(hash, FB_PASSWORD, Foreign.opener({ secretBox }, ENV, 'other'))
    ).toBe(false)
    expect(
      await Foreign.verify(hash, FB_PASSWORD, Foreign.opener({ secretBox }, 'env2', USER))
    ).toBe(false)
  })

  test('a different master key does not open it', async () => {
    const hash = await stored()
    const other = createSecretBox('11'.repeat(32))
    expect(
      await Foreign.verify(hash, FB_PASSWORD, Foreign.opener({ secretBox: other }, ENV, USER))
    ).toBe(false)
  })

  test('a sealed block copied from another user does not open', async () => {
    const mine = await stored()
    const other = await Foreign.prepare(
      { secretBox },
      { environmentId: ENV, userId: 'someone-else' },
      fbRow(),
      FIREBASE
    )
    if (!other.ok) {
      throw new Error(other.code)
    }
    const [, , , , salt, hash] = mine.split('$')
    const sealed = other.stored.split('$')[3]
    const graft = `$tula-firebase-scrypt$v1$${sealed}$${salt}$${hash}`
    expect(await Foreign.verify(graft, FB_PASSWORD, opener())).toBe(false)
  })

  test('a tampered stored hash matches nothing', async () => {
    const hash = await stored()
    const parts = hash.split('$')
    const flip = (text: string) => `${text.slice(0, -3)}${text.endsWith('AAA') ? 'BBB' : 'AAA'}`
    expect(
      await Foreign.verify(
        `$tula-firebase-scrypt$v1$${flip(parts[3] ?? '')}$${parts[4]}$${parts[5]}`,
        FB_PASSWORD,
        opener()
      )
    ).toBe(false)
    expect(
      await Foreign.verify(
        `$tula-firebase-scrypt$v1$${parts[3]}$${parts[4]?.replace('42xE', '42xF')}$${parts[5]}`,
        FB_PASSWORD,
        opener()
      )
    ).toBe(false)
    expect(
      await Foreign.verify(
        `$tula-firebase-scrypt$v1$${parts[3]}$${parts[4]}$${parts[5]?.replace('lSrf', 'lSrg')}`,
        FB_PASSWORD,
        opener()
      )
    ).toBe(false)
    expect(await Foreign.verify('$tula-firebase-scrypt$v1$garbage', FB_PASSWORD, opener())).toBe(
      false
    )
  })

  test('sealed parameters outside the limits (a row edited with a valid seal) match nothing', async () => {
    const seal = (body: object) =>
      secretBox.seal(
        'import-hash-parameters',
        new TextEncoder().encode(JSON.stringify(body)),
        `import-hash:${ENV}:${USER}`
      )
    const base = { k: FIREBASE.signerKey, s: FIREBASE.saltSeparator, r: 8, m: 14 }
    const parts = (await stored()).split('$')
    for (const body of [
      { ...base, m: 31 },
      { ...base, m: 17 },
      { ...base, r: 1000 },
      { ...base, m: 16, r: 16 },
      { ...base, m: 2 },
      { ...base, r: 'eight' },
      { ...base, k: '!!!' },
    ]) {
      const hash = `$tula-firebase-scrypt$v1$${await seal(body)}$${parts[4]}$${parts[5]}`
      expect(await Foreign.verify(hash, FB_PASSWORD, opener())).toBe(false)
    }
  })
})

describe('Firebase scrypt: what is refused at import', () => {
  const refused = async (
    firebase: FirebaseScryptParams | undefined,
    row: Parameters<typeof Foreign.prepare>[2] = fbRow()
  ) => {
    const result = await Foreign.prepare({ secretBox }, user, row, firebase)
    return result.ok ? 'accepted' : result.code
  }

  test('the call carries no project parameters', async () => {
    expect(await refused(undefined)).toBe('import.hash_malformed')
  })

  test.each([
    ['a signer key that is not base64', { signerKey: '***' }],
    ['an empty signer key', { signerKey: '' }],
    ['a signer key over 128 bytes', { signerKey: Buffer.alloc(129).toString('base64') }],
    ['a separator that is not base64', { saltSeparator: 'B' }],
    ['a separator over 64 bytes', { saltSeparator: Buffer.alloc(65).toString('base64') }],
    ['rounds that are not whole', { rounds: 8.5 }],
    ['a cost that is not whole', { memCost: 14.2 }],
  ])('%s is malformed', async (_name, change) => {
    expect(await refused({ ...FIREBASE, ...change })).toBe('import.hash_malformed')
  })

  test('the floors: cost 12 and 4 rounds, not less', async () => {
    expect(await refused({ ...FIREBASE, memCost: 12, rounds: 4 })).toBe('accepted')
    expect(await refused({ ...FIREBASE, memCost: 11 })).toBe('import.hash_parameters_too_weak')
    expect(await refused({ ...FIREBASE, rounds: 3 })).toBe('import.hash_parameters_too_weak')
    expect(await refused({ ...FIREBASE, memCost: 0, rounds: 0 })).toBe(
      'import.hash_parameters_too_weak'
    )
    expect(await refused({ ...FIREBASE, rounds: -1 })).toBe('import.hash_parameters_too_weak')
  })

  test('the ceilings: cost 16, 16 rounds, and 64 MiB for the two together', async () => {
    expect(await refused({ ...FIREBASE, memCost: 16, rounds: 4 })).toBe('accepted')
    expect(await refused({ ...FIREBASE, memCost: 13, rounds: 16 })).toBe('accepted')
    expect(await refused({ ...FIREBASE, memCost: 17 })).toBe('import.hash_parameters_too_costly')
    expect(await refused({ ...FIREBASE, rounds: 17 })).toBe('import.hash_parameters_too_costly')
    expect(await refused({ ...FIREBASE, memCost: 16, rounds: 16 })).toBe(
      'import.hash_parameters_too_costly'
    )
    expect(await refused({ ...FIREBASE, memCost: 16, rounds: 9 })).toBe(
      'import.hash_parameters_too_costly'
    )
    expect(await refused({ ...FIREBASE, memCost: 31, rounds: 1_000_000 })).toBe(
      'import.hash_parameters_too_costly'
    )
  })

  test.each<[string, { hash: string; params: Record<string, string | number> }]>([
    ['no salt', { hash: FB_HASH, params: {} }],
    ['a salt that is not base64', { hash: FB_HASH, params: { salt: '%%%' } }],
    ['a salt of 7 bytes', { hash: FB_HASH, params: { salt: Buffer.alloc(7).toString('base64') } }],
    [
      'a salt of 65 bytes',
      { hash: FB_HASH, params: { salt: Buffer.alloc(65).toString('base64') } },
    ],
    ['a numeric salt', { hash: FB_HASH, params: { salt: 12345678 } }],
    ['a hash that is not base64', { hash: 'not*base64', params: { salt: FB_SALT } }],
    [
      'a hash of the wrong length',
      { hash: Buffer.alloc(32).toString('base64'), params: { salt: FB_SALT } },
    ],
    ['an empty hash', { hash: '', params: { salt: FB_SALT } }],
  ])('a row with %s is malformed', async (_name, change) => {
    expect(await refused(FIREBASE, { algorithm: 'firebase_scrypt', ...change })).toBe(
      'import.hash_malformed'
    )
  })

  test('a refused row seals nothing', async () => {
    let sealed = 0
    const counting = {
      secretBox: {
        ...secretBox,
        seal: (...args: Parameters<typeof secretBox.seal>) => {
          sealed += 1
          return secretBox.seal(...args)
        },
      },
    }
    await Foreign.prepare(counting, user, fbRow({ hash: 'x' }), FIREBASE)
    await Foreign.prepare(counting, user, fbRow(), { ...FIREBASE, memCost: 20 })
    expect(sealed).toBe(0)
  })
})
