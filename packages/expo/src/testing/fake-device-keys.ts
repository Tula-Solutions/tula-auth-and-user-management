import { type DeviceKey, generateSoftwareDeviceKey } from '@tula-tech/core'
import type { DeviceKeyStore } from '../device-key-store'

/**
 * A phone's key store for tests: software keys (WebCrypto) behind the interface a hardware
 * key store has, with the ways a real one fails switched on by the test.
 */
export interface FakeDeviceKeys extends DeviceKeyStore {
  /** The key under each alias. Deleting an entry is "the key is gone". */
  readonly keys: Map<string, DeviceKey>
  /** What the next key the store makes will be; a new software key when left empty. */
  readonly planted: DeviceKey[]
  /** `false`: no key store in this build. `'throws'`: it cannot say. */
  available: boolean | 'throws'
  /** While `true`, the key store cannot be reached: every `obtain` rejects. */
  locked: boolean
  /** While `true`, every `sign` rejects. */
  failSigning: boolean
  /** Every call, in order. */
  readonly calls: string[]
}

/** The rejection of a key store that cannot be reached; its text must never be shown. */
export const KEY_STORE_CANARY = 'keystore-canary-51c2'

/**
 * @param first - The key the store already holds, if any.
 * @returns A key store.
 */
export function fakeDeviceKeys(first?: { alias: string; key: DeviceKey }): FakeDeviceKeys {
  const keys = new Map<string, DeviceKey>()
  if (first) {
    keys.set(first.alias, first.key)
  }
  const fake: FakeDeviceKeys = {
    keys,
    planted: [],
    available: true,
    locked: false,
    failSigning: false,
    calls: [],
    isAvailable() {
      fake.calls.push('isAvailable')
      if (fake.available === 'throws') {
        throw new Error(KEY_STORE_CANARY)
      }
      return fake.available
    },
    async obtain(alias) {
      fake.calls.push(`obtain ${alias}`)
      if (fake.locked) {
        throw new Error(KEY_STORE_CANARY)
      }
      const held = keys.get(alias)
      if (held) {
        return { publicJwk: held.publicJwk, created: false }
      }
      const made = fake.planted.shift() ?? (await generateSoftwareDeviceKey())
      keys.set(alias, made)
      return { publicJwk: made.publicJwk, created: true }
    },
    async sign(alias, data) {
      fake.calls.push(`sign ${alias}`)
      const held = keys.get(alias)
      if (fake.failSigning || !held) {
        throw new Error(KEY_STORE_CANARY)
      }
      return held.sign(data)
    },
  }
  return fake
}
