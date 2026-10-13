import { describe, expect, test } from 'bun:test'
import defaultExport, { type ExpoConfigLike, reversedGoogleClientId, withTula } from './plugin'

// The config plugin is a function over a plain object, so it is tested on plain objects:
// `@expo/config-plugins` is not installed here, and no prebuild was run with it.

const WEB = '1234-web.apps.googleusercontent.com'
const IOS = '1234-ios.apps.googleusercontent.com'

const APP: ExpoConfigLike = {
  name: 'Example',
  slug: 'example',
  ios: { bundleIdentifier: 'com.example.app' },
  android: { package: 'com.example.app' },
}

describe('withTula', () => {
  test('with nothing asked for it changes nothing', () => {
    expect(withTula(APP)).toEqual(APP)
    expect(withTula(APP, {})).toEqual(APP)
    expect(withTula({ name: 'Bare' }, {})).toEqual({ name: 'Bare' })
  })

  test('the default export is the plugin, which is how Expo takes one from a module', () => {
    expect(defaultExport).toBe(withTula)
  })

  test('a credential domain is a webcredentials entry on iOS and nothing on Android', () => {
    const config = withTula(APP, { domains: ['Example.com', 'auth.example.com'] })
    expect(config.ios?.associatedDomains).toEqual([
      'webcredentials:example.com',
      'webcredentials:auth.example.com',
    ])
    expect(config.android).toEqual(APP.android)
  })

  test('an app link is an applinks entry on iOS and a verified filter of its exact paths on Android', () => {
    const config = withTula(APP, {
      appLinks: [{ domain: 'app.example.com', paths: ['/oauth/callback', '/open'] }],
    })
    expect(config.ios?.associatedDomains).toEqual(['applinks:app.example.com'])
    expect(config.android?.intentFilters).toEqual([
      {
        action: 'VIEW',
        autoVerify: true,
        data: [
          { scheme: 'https', host: 'app.example.com', path: '/oauth/callback' },
          { scheme: 'https', host: 'app.example.com', path: '/open' },
        ],
        category: ['BROWSABLE', 'DEFAULT'],
      },
    ])
  })

  test('Sign in with Apple is the entitlement and Expo’s own switch', () => {
    const config = withTula(APP, { apple: true })
    expect(config.ios?.usesAppleSignIn).toBe(true)
    expect(config.ios?.entitlements).toEqual({ 'com.apple.developer.applesignin': ['Default'] })
    const off = withTula(APP, { apple: false })
    expect(off).toEqual(APP)
  })

  test('Google’s client ids go where the app reads them, and the iOS one becomes the reversed scheme', () => {
    const config = withTula(APP, { google: { webClientId: WEB, iosClientId: IOS } })
    expect(config.extra).toEqual({ tula: { google: { webClientId: WEB, iosClientId: IOS } } })
    expect(config.ios?.infoPlist).toEqual({
      GIDClientID: IOS,
      CFBundleURLTypes: [{ CFBundleURLSchemes: ['com.googleusercontent.apps.1234-ios'] }],
    })
  })

  test('without an iOS client id nothing of Google is written for iOS', () => {
    const config = withTula(APP, { google: { webClientId: WEB } })
    expect(config.extra).toEqual({ tula: { google: { webClientId: WEB } } })
    expect(config.ios).toEqual(APP.ios)
  })

  test('what the configuration already holds is kept', () => {
    const held: ExpoConfigLike = {
      ...APP,
      ios: {
        bundleIdentifier: 'com.example.app',
        associatedDomains: ['applinks:other.example.com'],
        entitlements: { 'aps-environment': 'production' },
        infoPlist: {
          NSCameraUsageDescription: 'Scan a code',
          CFBundleURLTypes: [{ CFBundleURLSchemes: ['example'] }],
        },
      },
      android: {
        package: 'com.example.app',
        intentFilters: [{ action: 'VIEW', data: [{ scheme: 'example' }] }],
      },
      extra: { eas: { projectId: 'p' }, tula: { publishableKey: 'tula_pk_test' } },
    }
    const config = withTula(held, {
      domains: ['example.com'],
      appLinks: [{ domain: 'app.example.com', paths: ['/oauth/callback'] }],
      apple: true,
      google: { webClientId: WEB, iosClientId: IOS },
    })
    expect(config.ios?.associatedDomains).toEqual([
      'applinks:other.example.com',
      'webcredentials:example.com',
      'applinks:app.example.com',
    ])
    expect(config.ios?.entitlements).toEqual({
      'aps-environment': 'production',
      'com.apple.developer.applesignin': ['Default'],
    })
    expect(config.ios?.infoPlist).toEqual({
      NSCameraUsageDescription: 'Scan a code',
      GIDClientID: IOS,
      CFBundleURLTypes: [
        { CFBundleURLSchemes: ['example'] },
        { CFBundleURLSchemes: ['com.googleusercontent.apps.1234-ios'] },
      ],
    })
    expect(config.ios?.bundleIdentifier).toBe('com.example.app')
    expect(config.android?.intentFilters).toHaveLength(2)
    expect(config.android?.intentFilters?.[0]).toEqual({
      action: 'VIEW',
      data: [{ scheme: 'example' }],
    })
    expect(config.extra).toEqual({
      eas: { projectId: 'p' },
      tula: {
        publishableKey: 'tula_pk_test',
        google: { webClientId: WEB, iosClientId: IOS },
      },
    })
    expect(config.name).toBe('Example')
  })

  test('applying it again changes nothing, and the configuration it was given is not changed', () => {
    const props = {
      domains: ['example.com'],
      appLinks: [{ domain: 'app.example.com', paths: ['/oauth/callback'] }],
      apple: true,
      google: { webClientId: WEB, iosClientId: IOS },
    }
    const before = JSON.stringify(APP)
    const once = withTula(APP, props)
    expect(JSON.stringify(APP)).toBe(before)
    const twice = withTula(once, props)
    expect(twice).toEqual(once)
    expect(JSON.stringify(once)).toBe(JSON.stringify(withTula(APP, props)))
  })

  test('a domain named for credentials and for links has both entries, each once', () => {
    const config = withTula(APP, {
      domains: ['example.com', 'example.com'],
      appLinks: [{ domain: 'example.com', paths: ['/open'] }],
    })
    expect(config.ios?.associatedDomains).toEqual([
      'webcredentials:example.com',
      'applinks:example.com',
    ])
  })

  const CANARY = 'canary-value-7f3a'

  test.each([
    ['domains', { domains: CANARY }, 'domains'],
    ['a domain with a scheme', { domains: [`https://${CANARY}.example.com`] }, 'domains.0'],
    ['a domain with a wildcard', { domains: ['example.com', `*.${CANARY}.com`] }, 'domains.1'],
    ['a domain with a port', { domains: [`${CANARY}.example.com:443`] }, 'domains.0'],
    ['a domain with a path', { domains: [`${CANARY}.example.com/a`] }, 'domains.0'],
    ['a single label', { domains: [CANARY] }, 'domains.0'],
    ['a domain that is no text', { domains: [42] }, 'domains.0'],
    ['appLinks that is no list', { appLinks: CANARY }, 'appLinks'],
    ['an app link that is no object', { appLinks: [CANARY] }, 'appLinks.0'],
    ['an app link with no domain', { appLinks: [{ paths: [`/${CANARY}`] }] }, 'appLinks.0.domain'],
    [
      'an app link with no path',
      { appLinks: [{ domain: `${CANARY}.example.com`, paths: [] }] },
      'appLinks.0.paths',
    ],
    [
      'a path with a wildcard',
      { appLinks: [{ domain: 'app.example.com', paths: ['/ok', `/${CANARY}/*`] }] },
      'appLinks.0.paths.1',
    ],
    [
      'a path with a query',
      { appLinks: [{ domain: 'app.example.com', paths: [`/${CANARY}?a=1`] }] },
      'appLinks.0.paths.0',
    ],
    [
      'a path with a dot segment',
      { appLinks: [{ domain: 'app.example.com', paths: [`/${CANARY}/../b`] }] },
      'appLinks.0.paths.0',
    ],
    [
      'a path with a trailing slash',
      { appLinks: [{ domain: 'app.example.com', paths: [`/${CANARY}/`] }] },
      'appLinks.0.paths.0',
    ],
    [
      'the root path',
      { appLinks: [{ domain: 'app.example.com', paths: ['/'] }] },
      'appLinks.0.paths.0',
    ],
    ['apple that is no boolean', { apple: CANARY }, 'apple'],
    ['google that is no object', { google: CANARY }, 'google.webClientId'],
    ['a web client id of another shape', { google: { webClientId: CANARY } }, 'google.webClientId'],
    [
      'an iOS client id of another shape',
      { google: { webClientId: WEB, iosClientId: CANARY } },
      'google.iosClientId',
    ],
  ])('%s is refused by the option’s name, never its value', (_name, props, option) => {
    let thrown: unknown
    try {
      withTula(APP, props as never)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(TypeError)
    const { message } = thrown as TypeError
    expect(message).toContain(`\`${option}`)
    expect(message).not.toContain(CANARY)
  })

  test('a configuration or props that are no object are refused', () => {
    expect(() => withTula(null as never, {})).toThrow(TypeError)
    expect(() => withTula([] as never, {})).toThrow(TypeError)
    expect(() => withTula(APP, 'example.com' as never)).toThrow(TypeError)
  })
})

describe('reversedGoogleClientId', () => {
  test('is the scheme withTula writes', () => {
    expect(reversedGoogleClientId(IOS)).toBe('com.googleusercontent.apps.1234-ios')
    const config = withTula(APP, { google: { webClientId: WEB, iosClientId: IOS } })
    expect(JSON.stringify(config.ios?.infoPlist)).toContain(reversedGoogleClientId(IOS))
  })

  test.each([['canary-not-an-id'], ['canary.apps.googleusercontent.com.evil'], [42], [undefined]])(
    '%j is refused without being repeated',
    (value) => {
      let message = ''
      try {
        reversedGoogleClientId(value as never)
      } catch (error) {
        expect(error).toBeInstanceOf(TypeError)
        message = (error as Error).message
      }
      expect(message).toContain('google.iosClientId')
      expect(message).not.toContain('canary')
    }
  )
})
