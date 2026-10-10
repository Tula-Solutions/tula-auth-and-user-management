import { describe, expect, test } from 'bun:test'
import {
  ANDROID_APK_KEY_HASH_PREFIX,
  AppleAppSiteAssociationSchema,
  ASSET_LINKS_RELATIONS,
  AssetLinksSchema,
  androidApkKeyHashOrigin,
  appleAppSiteAssociation,
  assetLinks,
  CERT_FINGERPRINT_PATTERN,
  CreateNativeAppRequestSchema,
  MAX_BUNDLE_ID_LENGTH,
  MAX_CERT_FINGERPRINTS,
  MAX_PACKAGE_NAME_LENGTH,
  type NativeAppIdentity,
  NativeAppSchema,
  nativeAppIdentifier,
  nativeAppWeakenings,
  normalizeCertFingerprint,
  normalizeCertFingerprints,
  UpdateNativeAppRequestSchema,
} from './native-app'

/** A fingerprint in the stored form, every byte the same. */
function fingerprint(byte: string): string {
  return Array.from({ length: 32 }, () => byte).join(':')
}

const AA = fingerprint('AA')
const BB = fingerprint('BB')
const ios = { platform: 'ios', teamId: 'A1B2C3D4E5', bundleId: 'com.example.app' } as const
const android = {
  platform: 'android',
  packageName: 'com.example.app',
  sha256CertFingerprints: [AA],
} as const

const accepted = (input: unknown) => CreateNativeAppRequestSchema.safeParse(input).success

describe('an iOS app’s identity', () => {
  test('a team id and a bundle id are accepted', () => {
    expect(accepted(ios)).toBe(true)
    expect(accepted({ ...ios, bundleId: 'com.example-co.My-App2' })).toBe(true)
  })

  test.each([
    ['nine characters', 'A1B2C3D4E'],
    ['eleven characters', 'A1B2C3D4E5F'],
    ['lower case', 'a1b2c3d4e5'],
    ['a period', 'A1B2C3D4.5'],
    ['a space', 'A1B2C3D4 5'],
    ['empty', ''],
  ])('a team id with %s is refused', (_name, teamId) => {
    expect(accepted({ ...ios, teamId })).toBe(false)
  })

  test.each([
    ['one segment', 'app'],
    ['an empty segment', 'com..app'],
    ['a leading period', '.com.example'],
    ['a trailing period', 'com.example.'],
    ['an underscore', 'com.example.my_app'],
    ['a wildcard', 'com.example.*'],
    ['a space', 'com.example. app'],
    ['a slash', 'com.example/app'],
    ['a line break', 'com.example.app\n'],
    ['a team prefix with a colon', 'A1B2C3D4E5:com.example.app'],
    ['too many characters', `com.${'a'.repeat(MAX_BUNDLE_ID_LENGTH)}`],
  ])('a bundle id with %s is refused', (_name, bundleId) => {
    expect(accepted({ ...ios, bundleId })).toBe(false)
  })

  test('a field of the other platform, or one nobody defined, is refused', () => {
    expect(accepted({ ...ios, sha256CertFingerprints: [AA] })).toBe(false)
    expect(accepted({ ...ios, packageName: 'com.example.app' })).toBe(false)
    expect(accepted({ ...ios, paths: ['/*'] })).toBe(false)
    expect(accepted({ teamId: ios.teamId, bundleId: ios.bundleId })).toBe(false)
    expect(accepted({ ...ios, platform: 'windows' })).toBe(false)
  })
})

describe('an Android app’s identity', () => {
  test('a package name and a fingerprint are accepted', () => {
    expect(accepted(android)).toBe(true)
    expect(accepted({ ...android, packageName: 'com.example.my_app.V2' })).toBe(true)
  })

  test.each([
    ['one segment', 'app'],
    ['a segment that starts with a digit', 'com.2example.app'],
    ['a segment that starts with an underscore', 'com._example.app'],
    ['a hyphen', 'com.example.my-app'],
    ['an empty segment', 'com..app'],
    ['a trailing period', 'com.example.'],
    ['a space', 'com.example app'],
    ['too many characters', `com.${'a'.repeat(MAX_PACKAGE_NAME_LENGTH)}`],
  ])('a package name with %s is refused', (_name, packageName) => {
    expect(accepted({ ...android, packageName })).toBe(false)
  })

  test.each([
    ['31 bytes', AA.slice(3)],
    ['33 bytes', `${AA}:AA`],
    ['a letter that is not hex', `GG${AA.slice(2)}`],
    ['another separator', AA.replaceAll(':', '-')],
    ['some colons missing', `AAAA${AA.slice(5)}`],
    ['a SHA-1 fingerprint', Array.from({ length: 20 }, () => 'AA').join(':')],
    ['a trailing line break', `${AA}\n`],
    ['empty', ''],
  ])('a fingerprint with %s is refused', (_name, value) => {
    expect(accepted({ ...android, sha256CertFingerprints: [value] })).toBe(false)
    expect(normalizeCertFingerprint(value)).toBeNull()
  })

  test('an app has at least one fingerprint and no more than the cap', () => {
    expect(accepted({ ...android, sha256CertFingerprints: [] })).toBe(false)
    const many = Array.from({ length: MAX_CERT_FINGERPRINTS + 1 }, (_, n) =>
      fingerprint(n.toString(16).padStart(2, '0').toUpperCase())
    )
    expect(accepted({ ...android, sha256CertFingerprints: many.slice(1) })).toBe(true)
    expect(accepted({ ...android, sha256CertFingerprints: many })).toBe(false)
  })

  test('the same fingerprint twice is refused, however each is written', () => {
    expect(accepted({ ...android, sha256CertFingerprints: [AA, AA] })).toBe(false)
    expect(accepted({ ...android, sha256CertFingerprints: [AA, AA.toLowerCase()] })).toBe(false)
    expect(accepted({ ...android, sha256CertFingerprints: [AA, 'aa'.repeat(32)] })).toBe(false)
  })

  test('a field of the other platform is refused', () => {
    expect(accepted({ ...android, teamId: 'A1B2C3D4E5' })).toBe(false)
    expect(accepted({ ...android, bundleId: 'com.example.app' })).toBe(false)
  })
})

describe('a fingerprint as stored', () => {
  test('lower case and no colons become upper case with colons', () => {
    expect(normalizeCertFingerprint(AA.toLowerCase())).toBe(AA)
    expect(normalizeCertFingerprint('aa'.repeat(32))).toBe(AA)
    expect(normalizeCertFingerprint(AA)).toBe(AA)
    expect(CERT_FINGERPRINT_PATTERN.test(String(normalizeCertFingerprint('0f'.repeat(32))))).toBe(
      true
    )
  })

  test('a list is a set: each once, sorted', () => {
    expect(normalizeCertFingerprints([BB, AA.toLowerCase(), 'aa'.repeat(32), 'nonsense'])).toEqual([
      AA,
      BB,
    ])
  })
})

describe('an update', () => {
  const ok = (input: unknown) => UpdateNativeAppRequestSchema.safeParse(input).success

  test('names a team id or a set of fingerprints, validated as on registration', () => {
    expect(ok({ teamId: 'ZZZZZZZZZZ' })).toBe(true)
    expect(ok({ sha256CertFingerprints: [AA, BB] })).toBe(true)
    expect(ok({})).toBe(false)
    expect(ok({ teamId: 'short' })).toBe(false)
    expect(ok({ sha256CertFingerprints: [] })).toBe(false)
    expect(ok({ sha256CertFingerprints: ['nonsense'] })).toBe(false)
  })

  test('cannot name what an app is', () => {
    expect(ok({ teamId: 'ZZZZZZZZZZ', bundleId: 'com.other.app' })).toBe(false)
    expect(ok({ sha256CertFingerprints: [AA], packageName: 'com.other.app' })).toBe(false)
    expect(ok({ teamId: 'ZZZZZZZZZZ', platform: 'android' })).toBe(false)
  })
})

describe('the served files', () => {
  const apps: NativeAppIdentity[] = [
    { platform: 'ios', teamId: 'ZZZZZZZZZZ', bundleId: 'com.example.second' },
    { platform: 'android', packageName: 'com.example.zebra', sha256CertFingerprints: [BB] },
    ios,
    { platform: 'android', packageName: 'com.example.app', sha256CertFingerprints: [AA, BB] },
  ]

  test('Apple’s file names the iOS apps as team id and bundle id, and has no other section', () => {
    const file = appleAppSiteAssociation(apps)
    expect(file).toEqual({
      webcredentials: { apps: ['A1B2C3D4E5.com.example.app', 'ZZZZZZZZZZ.com.example.second'] },
    })
    expect(Object.keys(file)).toEqual(['webcredentials'])
    expect(AppleAppSiteAssociationSchema.parse(file)).toEqual(file)
  })

  test('Android’s file has one statement per Android app with the credentials relation only', () => {
    const file = assetLinks(apps)
    expect(file).toEqual([
      {
        relation: ['delegate_permission/common.get_login_creds'],
        target: {
          namespace: 'android_app',
          package_name: 'com.example.app',
          sha256_cert_fingerprints: [AA, BB],
        },
      },
      {
        relation: ['delegate_permission/common.get_login_creds'],
        target: {
          namespace: 'android_app',
          package_name: 'com.example.zebra',
          sha256_cert_fingerprints: [BB],
        },
      },
    ])
    expect(AssetLinksSchema.parse(file)).toEqual(file)
  })

  test('no relation hands an app the links of a domain', () => {
    expect(ASSET_LINKS_RELATIONS).toEqual(['delegate_permission/common.get_login_creds'])
    expect(JSON.stringify(assetLinks(apps))).not.toContain('handle_all_urls')
    expect(JSON.stringify(appleAppSiteAssociation(apps))).not.toContain('applinks')
  })

  test('with no app of a platform its file grants nothing: no section, no statement', () => {
    expect(appleAppSiteAssociation([])).toEqual({})
    expect(assetLinks([])).toEqual([])
    expect(appleAppSiteAssociation([android])).toEqual({})
    expect(assetLinks([ios])).toEqual([])
    expect(AppleAppSiteAssociationSchema.parse({})).toEqual({})
    expect(AssetLinksSchema.parse([])).toEqual([])
  })

  test('the schemas refuse a section or a key nobody decided to serve', () => {
    expect(AppleAppSiteAssociationSchema.safeParse({ applinks: { details: [] } }).success).toBe(
      false
    )
    expect(AppleAppSiteAssociationSchema.safeParse({ webcredentials: { apps: [] } }).success).toBe(
      false
    )
    const [statement] = assetLinks([android])
    expect(AssetLinksSchema.safeParse([{ ...statement, extra: 1 }]).success).toBe(false)
  })
})

describe('what an app is', () => {
  test('its bundle id or its package name', () => {
    expect(nativeAppIdentifier(ios)).toBe('com.example.app')
    expect(nativeAppIdentifier({ ...android, packageName: 'com.example.droid' })).toBe(
      'com.example.droid'
    )
  })

  test('a listed app is one platform’s fields and not the other’s', () => {
    const stamps = {
      id: '0199c2f4-7a1a-7cdd-9bec-ef9a0d6c7b11',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    expect(NativeAppSchema.safeParse({ ...stamps, ...ios }).success).toBe(true)
    expect(NativeAppSchema.safeParse({ ...stamps, ...android }).success).toBe(true)
    expect(NativeAppSchema.safeParse({ ...stamps, platform: 'ios' }).success).toBe(false)
  })
})

describe('what widens which app the files name', () => {
  test.each<[string, NativeAppIdentity | null, NativeAppIdentity | null, string[]]>([
    ['an iOS app is registered', null, ios, ['app']],
    ['an Android app is registered', null, android, ['app']],
    ['an app is removed', ios, null, []],
    ['nothing changes', ios, ios, []],
    ['an iOS app moves to another team', ios, { ...ios, teamId: 'ZZZZZZZZZZ' }, ['teamId']],
    [
      'an Android app gains a fingerprint',
      android,
      { ...android, sha256CertFingerprints: [AA, BB] },
      ['sha256CertFingerprints'],
    ],
    [
      'an Android app loses a fingerprint',
      { ...android, sha256CertFingerprints: [AA, BB] },
      android,
      [],
    ],
    [
      'a fingerprint is swapped for another',
      android,
      { ...android, sha256CertFingerprints: [BB] },
      ['sha256CertFingerprints'],
    ],
    [
      'the same fingerprints are written another way',
      android,
      { ...android, sha256CertFingerprints: ['aa'.repeat(32)] },
      [],
    ],
    ['a row changes platform', ios, android, ['app']],
  ])('%s', (_name, was, is, expected) => {
    expect(nativeAppWeakenings(was, is)).toEqual(expected as never)
  })
})

describe('the origin an Android app presents for a passkey', () => {
  // Computed with the Python lines of Android's own documentation ("Verify origin"), not
  // with this package: `base64.urlsafe_b64encode(binascii.a2b_hex(hex)).replace('=', '')`.
  const DOCUMENTED = [
    [
      '14:B6:C3:A1:E9:D0:7F:52:88:6A:4B:0C:3D:9E:1F:20:A7:B8:C9:D0:E1:F2:A3:B4:C5:D6:E7:F8:09:1A:2B:3C',
      'android:apk-key-hash:FLbDoenQf1KIaksMPZ4fIKe4ydDh8qO0xdbn-AkaKzw',
    ],
    [
      'FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C',
      'android:apk-key-hash:-sYXRdwJA3hvue3mKpYrOZ9zSPC7b4mbgzJmdZEDO5w',
    ],
    // Bytes that standard base64 writes with `+` and `/`.
    [
      'FB:FF:BE:FB:FF:BE:FB:FF:BE:FB:FF:BE:FB:FF:BE:FB:FF:BE:FB:FF:BE:FB:FF:BE:FB:FF:BE:FB:FF:BE:FB:FF',
      'android:apk-key-hash:-_---_---_---_---_---_---_---_---_---_---_8',
    ],
    [fingerprint('00'), `android:apk-key-hash:${'A'.repeat(43)}`],
  ] as const

  test.each(DOCUMENTED)('%s is %s', (stored, origin) => {
    expect(androidApkKeyHashOrigin(stored)).toBe(origin)
  })

  test('it is the prefix and 43 base64url characters: no padding, no plus, no slash', () => {
    for (const [stored] of DOCUMENTED) {
      const origin = String(androidApkKeyHashOrigin(stored))
      expect(origin.startsWith(ANDROID_APK_KEY_HASH_PREFIX)).toBe(true)
      expect(origin.slice(ANDROID_APK_KEY_HASH_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{43}$/)
    }
  })

  test('every spelling of one fingerprint gives one origin', () => {
    const [stored, origin] = DOCUMENTED[0]
    expect(androidApkKeyHashOrigin(stored.toLowerCase())).toBe(origin)
    expect(androidApkKeyHashOrigin(stored.replaceAll(':', ''))).toBe(origin)
  })

  test.each([
    ['nothing', ''],
    ['31 bytes', Array.from({ length: 31 }, () => 'AA').join(':')],
    ['33 bytes', Array.from({ length: 33 }, () => 'AA').join(':')],
    ['a letter that is not hex', `G${AA.slice(1)}`],
    ['an origin', 'android:apk-key-hash:FLbDoenQf1KIaksMPZ4fIKe4ydDh8qO0xdbn-AkaKzw'],
    ['a trailing newline', `${AA}\n`],
  ])('%s is no fingerprint and has no origin', (_name, value) => {
    expect(androidApkKeyHashOrigin(value)).toBeNull()
  })
})
