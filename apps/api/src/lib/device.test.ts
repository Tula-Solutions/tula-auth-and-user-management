import { describe, expect, test } from 'bun:test'
import type { SessionClient } from '@tula/contract'
import { deviceFamily, UNKNOWN_DEVICE } from '~/lib/device'

const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
const LINUX = 'Mozilla/5.0 (X11; Linux x86_64)'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9)'
const CHROME = 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

describe('deviceFamily', () => {
  test.each<[string, string]>([
    [`${WINDOWS} ${CHROME}`, 'Chrome on Windows'],
    [`${MAC} ${CHROME}`, 'Chrome on macOS'],
    [`${LINUX} ${CHROME}`, 'Chrome on Linux'],
    [`${ANDROID} AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36`, 'Chrome on Android'],
    [`${IPHONE} AppleWebKit/605.1.15 CriOS/140.0 Mobile/15E148 Safari/604.1`, 'Chrome on iPhone'],
    [`${WINDOWS} ${CHROME} Edg/140.0.0.0`, 'Edge on Windows'],
    [`${MAC} ${CHROME} Edg/140.0.0.0`, 'Edge on macOS'],
    [`${LINUX} ${CHROME} Edg/140.0.0.0`, 'Edge on Linux'],
    [
      `${ANDROID} AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36 EdgA/140.0`,
      'Edge on Android',
    ],
    [`${IPHONE} AppleWebKit/605.1.15 EdgiOS/140.0 Mobile/15E148 Safari/605.1`, 'Edge on iPhone'],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
      'Firefox on Windows',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:130.0) Gecko/20100101 Firefox/130.0',
      'Firefox on macOS',
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0', 'Firefox on Linux'],
    ['Mozilla/5.0 (Android 15; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0', 'Firefox on Android'],
    [
      `${IPHONE} AppleWebKit/605.1.15 FxiOS/130.0 Mobile/15E148 Safari/605.1.15`,
      'Firefox on iPhone',
    ],
    [
      `${MAC} AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15`,
      'Safari on macOS',
    ],
    [`${IPHONE} AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1`, 'Safari on iPhone'],
    [
      'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Safari/604.1',
      'Safari on iPad',
    ],
    [`${MAC} ${CHROME} OPR/110.0`, 'Opera on macOS'],
    [
      'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
      'Chrome on ChromeOS',
    ],
    [`${LINUX} AppleWebKit/537.36 HeadlessChrome/140.0.0.0 Safari/537.36`, 'Chrome on Linux'],
  ])('%s → %s', (userAgent, expected) => {
    expect(deviceFamily('web', userAgent)).toBe(expected)
  })

  test('a version is not part of the family, so a browser update is not a new device', () => {
    expect(
      deviceFamily('web', `${WINDOWS} AppleWebKit/537.36 Chrome/139.0.0.0 Safari/537.36`)
    ).toBe(deviceFamily('web', `${WINDOWS} AppleWebKit/537.36 Chrome/141.0.7000.1 Safari/537.36`))
  })

  test.each<[SessionClient, string | null, string]>([
    ['ios', 'NorthlineApp/3.1 CFNetwork/1568.100.1 Darwin/24.0.0', 'iOS app'],
    ['ios', null, 'iOS app'],
    ['android', 'okhttp/4.12.0', 'Android app'],
    // A native kind is named by its platform even when its user agent claims a browser.
    ['android', `${WINDOWS} ${CHROME}`, 'Android app'],
    ['server', 'Bun/1.4.2', UNKNOWN_DEVICE],
    ['server', 'node', UNKNOWN_DEVICE],
    ['server', `${MAC} ${CHROME}`, 'Chrome on macOS'],
  ])('a %s session with %p is %s', (client, userAgent, expected) => {
    expect(deviceFamily(client, userAgent)).toBe(expected)
  })

  test.each<[string, string | null, string]>([
    ['nothing', null, UNKNOWN_DEVICE],
    ['an empty value', '', UNKNOWN_DEVICE],
    ['garbage', '\u0000\u0001 ]]>?? 🦦', UNKNOWN_DEVICE],
    ['a command-line client', 'curl/8.7.1', UNKNOWN_DEVICE],
    ['only a browser', 'curl/8.0 Firefox/1.0', 'Firefox'],
    ['only a system', 'MyApp/1.0 (Android)', 'Android'],
    ['HTML', '<img src=x onerror=alert(1)>', UNKNOWN_DEVICE],
    [
      'HTML around real tokens',
      '<script>alert(1)</script> Windows Chrome/1.0 <b>',
      'Chrome on Windows',
    ],
    [
      'a header injection',
      'Chrome/1.0 (Windows)\r\nBcc: attacker@evil.test\r\n\r\n<h1>hi</h1>',
      'Chrome on Windows',
    ],
  ])('%s is named from the fixed table only', (_, userAgent, expected) => {
    const family = deviceFamily('web', userAgent)
    expect(family).toBe(expected)
    expect(family).toMatch(/^[A-Za-z ]+$/)
  })

  test('a very long user agent is cut before it is matched', () => {
    const padding = 'x'.repeat(100_000)
    expect(deviceFamily('web', `${WINDOWS} ${CHROME} ${padding}`)).toBe('Chrome on Windows')
    // What lies past the cut is not looked at.
    expect(deviceFamily('web', `${padding} ${WINDOWS} ${CHROME}`)).toBe(UNKNOWN_DEVICE)
    expect(deviceFamily('web', 'Chrome/'.repeat(50_000))).toBe('Chrome')
  })
})
