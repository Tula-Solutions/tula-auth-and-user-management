import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { setUp } from '../../examples/expo/app/src/setup'
import { createTulaClient, memoryStorage } from '../../packages/core/src/index'

// The Expo example is not a workspace package and the repository installs no Expo, so the
// app itself runs nowhere here. What decides its first screen is a function with no
// imports, tested here with the client `@tula/expo` is made of.

const KEY = 'tula_pk_dev_example0000000000000000000000000'
const create = (publishableKey: string, baseUrl: string) =>
  createTulaClient({ publishableKey, baseUrl, client: 'ios', storage: memoryStorage() })

describe('the Expo example before .env.local is written', () => {
  test.each([
    [{ publishableKey: undefined, baseUrl: undefined }, 2],
    [{ publishableKey: '', baseUrl: '' }, 2],
    [{ publishableKey: KEY, baseUrl: undefined }, 1],
    [{ publishableKey: undefined, baseUrl: 'http://localhost:3003' }, 1],
  ])(
    'a value that is not set is named, nothing is thrown and no client is made: %j',
    (values, missing) => {
      let made = 0
      const setup = setUp(values, (key, url) => {
        made += 1
        return create(key, url)
      })
      expect(made).toBe(0)
      expect(setup.tula).toBeNull()
      if (setup.tula === null) {
        expect(setup.unset).toHaveLength(missing)
        expect(setup.refused).toBeNull()
        for (const name of setup.unset) {
          expect(name).toMatch(/^EXPO_PUBLIC_TULA_[A-Z_]+$/)
        }
      }
    }
  )

  test.each([
    ['an address that is no URL', { publishableKey: KEY, baseUrl: 'canary-not-a-url' }],
    [
      'a secret key',
      { publishableKey: 'tula_sk_dev_canary0000000', baseUrl: 'http://localhost:3003' },
    ],
    ['a key that is no key', { publishableKey: 'canary-key', baseUrl: 'http://localhost:3003' }],
  ])(
    '%s is refused in the client’s words, which do not repeat it, and nothing is thrown',
    (_name, values) => {
      const setup = setUp(values, create)
      expect(setup.tula).toBeNull()
      if (setup.tula === null) {
        expect(setup.unset).toEqual([])
        expect(setup.refused).toStartWith('createTulaClient: ')
        expect(setup.refused).not.toContain('canary')
      }
    }
  )

  test('both values there and taken: the client', () => {
    const setup = setUp({ publishableKey: KEY, baseUrl: 'http://localhost:3003' }, create)
    expect(setup.tula?.state).toEqual({ status: 'loading' })
  })

  test('the app makes its client through it, and never with a value it made up', async () => {
    const source = await Bun.file(
      join(import.meta.dir, '../../examples/expo/app/src/tula.ts')
    ).text()
    expect(source).toContain('export const setup = setUp(values, createClient)')
    // `?? ''` is what made the client throw while the module loaded.
    expect(source).not.toContain("?? ''")
  })
})
