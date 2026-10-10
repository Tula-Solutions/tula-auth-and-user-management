import { describe, expect, test } from 'bun:test'
import {
  ANDROID_APK_KEY_HASH_PREFIX,
  APP_LINK_PATH_PATTERN,
  AppleAppSiteAssociationSchema,
  ASSET_LINKS_APP_LINK_RELATION,
  ASSET_LINKS_RELATIONS,
  AssetLinksSchema,
  androidApkKeyHashOrigin,
  appleAppSiteAssociation,
  assetLinks,
  CERT_FINGERPRINT_PATTERN,
  CreateNativeAppRequestSchema,
  isAppLinkPath,
  MAX_APP_LINK_PATH_LENGTH,
  MAX_APP_LINK_PATHS,
  MAX_BUNDLE_ID_LENGTH,
  MAX_CERT_FINGERPRINTS,
  MAX_PACKAGE_NAME_LENGTH,
  type NativeAppIdentity,
  NativeAppSchema,
  nativeAppIdentifier,
  nativeAppWeakenings,
  normalizeAppLinkPaths,
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
    const appLinkPaths = ['/oauth/callback']
    expect(NativeAppSchema.safeParse({ ...stamps, ...ios, appLinkPaths }).success).toBe(true)
    expect(NativeAppSchema.safeParse({ ...stamps, ...android, appLinkPaths: [] }).success).toBe(
      true
    )
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
    [
      'an iOS app is registered with a path',
      null,
      { ...ios, appLinkPaths: ['/oauth'] },
      ['app', 'appLinkPaths'],
    ],
    [
      'an Android app is registered with a path',
      null,
      { ...android, appLinkPaths: ['/oauth'] },
      ['app', 'appLinkPaths'],
    ],
    [
      'an iOS app gains its first path',
      ios,
      { ...ios, appLinkPaths: ['/oauth'] },
      ['appLinkPaths'],
    ],
    [
      'an Android app gains its first path',
      android,
      { ...android, appLinkPaths: ['/oauth'] },
      ['appLinkPaths'],
    ],
    [
      'an app gains another path',
      { ...ios, appLinkPaths: ['/oauth'] },
      { ...ios, appLinkPaths: ['/oauth', '/link'] },
      ['appLinkPaths'],
    ],
    [
      'a path is swapped for another',
      { ...android, appLinkPaths: ['/oauth'] },
      { ...android, appLinkPaths: ['/link'] },
      ['appLinkPaths'],
    ],
    [
      'a path that differs only in case is another path',
      { ...ios, appLinkPaths: ['/oauth'] },
      { ...ios, appLinkPaths: ['/OAuth'] },
      ['appLinkPaths'],
    ],
    [
      'an app loses a path',
      { ...ios, appLinkPaths: ['/oauth', '/link'] },
      { ...ios, appLinkPaths: ['/oauth'] },
      [],
    ],
    ['an app loses every path', { ...android, appLinkPaths: ['/oauth'] }, android, []],
    [
      'the same paths in another order',
      { ...ios, appLinkPaths: ['/a', '/b'] },
      { ...ios, appLinkPaths: ['/b', '/a'] },
      [],
    ],
    [
      'a team and a path at once',
      ios,
      { ...ios, teamId: 'ZZZZZZZZZZ', appLinkPaths: ['/oauth'] },
      ['teamId', 'appLinkPaths'],
    ],
    [
      'a fingerprint and a path at once',
      android,
      { ...android, sha256CertFingerprints: [AA, BB], appLinkPaths: ['/oauth'] },
      ['sha256CertFingerprints', 'appLinkPaths'],
    ],
    ['an app with paths is removed', { ...ios, appLinkPaths: ['/oauth'] }, null, []],
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

describe('an app-link path', () => {
  test.each([
    ['/oauth'],
    ['/oauth/callback'],
    ['/a/b/c/d'],
    ['/OAuth_Callback~1.x-y'],
    ['/.well-known-ish'],
  ])('%s is one exact path', (path) => {
    expect(isAppLinkPath(path)).toBe(true)
    expect(APP_LINK_PATH_PATTERN.test(path)).toBe(true)
    expect(accepted({ ...ios, appLinkPaths: [path] })).toBe(true)
    expect(accepted({ ...android, appLinkPaths: [path] })).toBe(true)
  })

  test.each([
    [''],
    ['/'],
    ['oauth'],
    ['/oauth/'],
    ['//oauth'],
    ['/oauth//callback'],
    ['/*'],
    ['/oauth/*'],
    ['/oauth?'],
    ['/oa?th'],
    ['/oauth?x=1'],
    ['/oauth#x'],
    ['/oauth%2Fcallback'],
    ['/oauth/../admin'],
    ['/./oauth'],
    ['/oauth/..'],
    ['/oa uth'],
    ['/oauth\n'],
    ['/oauth​'],
    ['/café'],
    ['/oauth\\callback'],
    ['/oauth;x'],
    ['/oauth:x'],
    ['/oauth@x'],
    ['https://example.com/oauth'],
    [`/${'a'.repeat(MAX_APP_LINK_PATH_LENGTH)}`],
  ])('%j is refused', (path) => {
    expect(isAppLinkPath(path)).toBe(false)
    expect(accepted({ ...ios, appLinkPaths: [path] })).toBe(false)
    expect(accepted({ ...android, appLinkPaths: [path] })).toBe(false)
    expect(UpdateNativeAppRequestSchema.safeParse({ appLinkPaths: [path] }).success).toBe(false)
  })

  test('the longest path is accepted, the cap on their number is held, and none twice', () => {
    expect(isAppLinkPath(`/${'a'.repeat(MAX_APP_LINK_PATH_LENGTH - 1)}`)).toBe(true)
    const many = (n: number) => Array.from({ length: n }, (_, i) => `/p${i}`)
    expect(accepted({ ...ios, appLinkPaths: many(MAX_APP_LINK_PATHS) })).toBe(true)
    expect(accepted({ ...ios, appLinkPaths: many(MAX_APP_LINK_PATHS + 1) })).toBe(false)
    expect(accepted({ ...ios, appLinkPaths: ['/a', '/a'] })).toBe(false)
  })

  test('none is the default, and an empty list is accepted', () => {
    expect(accepted(ios)).toBe(true)
    expect(accepted({ ...ios, appLinkPaths: [] })).toBe(true)
    expect(UpdateNativeAppRequestSchema.safeParse({ appLinkPaths: [] }).success).toBe(true)
    expect(UpdateNativeAppRequestSchema.safeParse({}).success).toBe(false)
  })

  test('a request brings paths and nothing else about links', () => {
    for (const extra of [
      { applinks: { details: [] } },
      { relation: ['delegate_permission/common.handle_all_urls'] },
      { components: [{ '/': '/*' }] },
      { handleAllUrls: true },
    ]) {
      expect(accepted({ ...ios, ...extra })).toBe(false)
      expect(accepted({ ...android, ...extra })).toBe(false)
      expect(UpdateNativeAppRequestSchema.safeParse({ appLinkPaths: [], ...extra }).success).toBe(
        false
      )
    }
  })

  test('a list is a set: each once, sorted, nothing rewritten', () => {
    expect(normalizeAppLinkPaths(['/b', '/a', '/b', '/A'])).toEqual(['/A', '/a', '/b'])
    expect(normalizeAppLinkPaths(['/ok', '/*', '/x/'])).toEqual(['/ok'])
  })

  test('work is bounded: a long run of slashes is judged at once', () => {
    const started = performance.now()
    expect(isAppLinkPath(`${'/a'.repeat(120)}*`)).toBe(false)
    expect(APP_LINK_PATH_PATTERN.test(`${'/a'.repeat(5000)}*`)).toBe(false)
    expect(performance.now() - started).toBeLessThan(200)
  })
})

describe('the served files and app links', () => {
  const other = { platform: 'ios', teamId: 'A1B2C3D4E5', bundleId: 'com.example.other' } as const

  test('an iOS app with no path is in no applinks section', () => {
    expect(appleAppSiteAssociation([ios, { ...other, appLinkPaths: [] }])).toEqual({
      webcredentials: { apps: ['A1B2C3D4E5.com.example.app', 'A1B2C3D4E5.com.example.other'] },
    })
  })

  test('an iOS app with paths is handed exactly those paths, and only that app', () => {
    const file = appleAppSiteAssociation([
      { ...ios, appLinkPaths: ['/oauth/callback', '/link'] },
      other,
      { ...android, appLinkPaths: ['/android-only'] },
    ])
    expect(file).toEqual({
      webcredentials: { apps: ['A1B2C3D4E5.com.example.app', 'A1B2C3D4E5.com.example.other'] },
      applinks: {
        details: [
          {
            appIDs: ['A1B2C3D4E5.com.example.app'],
            components: [{ '/': '/link' }, { '/': '/oauth/callback' }],
          },
        ],
      },
    })
    expect(AppleAppSiteAssociationSchema.safeParse(file).success).toBe(true)
    const text = JSON.stringify(file)
    expect(text).not.toContain('*')
    expect(text).not.toContain('?')
    expect(text).not.toContain('android-only')
  })

  test('a path that is no path never reaches the file', () => {
    const file = appleAppSiteAssociation([{ ...ios, appLinkPaths: ['/*', '/ok', '/x?'] }])
    expect(file.applinks?.details).toEqual([
      { appIDs: ['A1B2C3D4E5.com.example.app'], components: [{ '/': '/ok' }] },
    ])
    expect(appleAppSiteAssociation([{ ...ios, appLinkPaths: ['/*'] }]).applinks).toBeUndefined()
  })

  test('the applinks section holds nothing but app ids and paths', () => {
    const strict = AppleAppSiteAssociationSchema.safeParse({
      webcredentials: { apps: ['A1B2C3D4E5.com.example.app'] },
      applinks: {
        details: [
          {
            appIDs: ['A1B2C3D4E5.com.example.app'],
            components: [{ '/': '/oauth', exclude: true }],
          },
        ],
      },
    })
    expect(strict.success).toBe(false)
    expect(AppleAppSiteAssociationSchema.safeParse({ applinks: { details: [] } }).success).toBe(
      false
    )
  })

  test('an Android app has handle_all_urls only with a path', () => {
    const droid = { ...android, packageName: 'com.example.droid' }
    const file = assetLinks([android, { ...droid, appLinkPaths: ['/oauth/callback'] }, ios])
    expect(file.map((statement) => [statement.target.package_name, statement.relation])).toEqual([
      ['com.example.app', [...ASSET_LINKS_RELATIONS]],
      ['com.example.droid', [...ASSET_LINKS_RELATIONS, ASSET_LINKS_APP_LINK_RELATION]],
    ])
    expect(ASSET_LINKS_APP_LINK_RELATION).toBe('delegate_permission/common.handle_all_urls')
    expect(ASSET_LINKS_RELATIONS as readonly string[]).not.toContain(ASSET_LINKS_APP_LINK_RELATION)
    expect(AssetLinksSchema.safeParse(file).success).toBe(true)
    // The file has no place for a path: Android's manifest names them.
    expect(JSON.stringify(file)).not.toContain('/oauth')
  })

  test('an Android app whose only path is no path gets no link', () => {
    expect(assetLinks([{ ...android, appLinkPaths: ['/*'] }])[0]?.relation).toEqual([
      ...ASSET_LINKS_RELATIONS,
    ])
    expect(assetLinks([{ ...android, appLinkPaths: [] }])[0]?.relation).toEqual([
      ...ASSET_LINKS_RELATIONS,
    ])
  })

  test('no app of a platform is still no section', () => {
    expect(appleAppSiteAssociation([{ ...android, appLinkPaths: ['/oauth'] }])).toEqual({})
    expect(assetLinks([{ ...ios, appLinkPaths: ['/oauth'] }])).toEqual([])
  })
})
