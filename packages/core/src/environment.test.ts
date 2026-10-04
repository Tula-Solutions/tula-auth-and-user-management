import { describe, expect, test } from 'bun:test'
import { type ChannelLike, type LockManagerLike, runtimeEnvironment } from './environment'

describe('runtimeEnvironment', () => {
  test('uses the runtime’s locks and BroadcastChannel when it has them', () => {
    const locks: LockManagerLike = { request: (_name, _options, callback) => callback() }
    const opened: string[] = []
    class Channel implements ChannelLike {
      onmessage = null
      constructor(name: string) {
        opened.push(name)
      }
      postMessage(): void {}
    }
    const environment = runtimeEnvironment({ navigator: { locks }, BroadcastChannel: Channel })
    expect(environment.locks).toBe(locks)
    expect(environment.createChannel?.('tula:x')).toBeInstanceOf(Channel)
    expect(opened).toEqual(['tula:x'])
    expect(Math.abs(environment.now() - Date.now())).toBeLessThan(1_000)
  })

  test('a runtime with neither (a server, an old browser) gets neither', () => {
    expect(runtimeEnvironment({})).toMatchObject({ locks: undefined, createChannel: undefined })
    expect(runtimeEnvironment({ navigator: {} }).locks).toBeUndefined()
  })

  test('reads the real globals by default without throwing', () => {
    expect(typeof runtimeEnvironment().now()).toBe('number')
  })

  test('the tab’s storage is `sessionStorage`, and a runtime where reading it throws has none', () => {
    const storage = {
      length: 0,
      key: () => null,
      getItem: () => null,
      setItem() {},
      removeItem() {},
    }
    expect(runtimeEnvironment({ sessionStorage: storage }).tabStorage).toBe(storage)
    expect(runtimeEnvironment({}).tabStorage).toBeUndefined()
    const sandboxed = Object.defineProperty({}, 'sessionStorage', {
      get() {
        throw new DOMException('denied', 'SecurityError')
      },
    })
    expect(runtimeEnvironment(sandboxed).tabStorage).toBeUndefined()
  })

  test('the page can be sent elsewhere, and a location without `assign` is tolerated', () => {
    const assigned: string[] = []
    const history = { state: null, replaceState() {} }
    const page = runtimeEnvironment({
      location: { href: 'https://app.test/', assign: (url: string) => assigned.push(url) },
      history,
    }).page
    page?.assign?.('https://accounts.google.com/')
    expect(assigned).toEqual(['https://accounts.google.com/'])
    runtimeEnvironment({ location: { href: 'https://app.test/' }, history }).page?.assign?.('x')
  })
})
