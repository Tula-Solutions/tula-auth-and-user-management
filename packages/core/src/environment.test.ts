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
})
