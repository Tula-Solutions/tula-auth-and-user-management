import type { DeviceKey, DeviceKeySource, DevicePublicJwk, TokenStorage } from '@tula/core'
import { base64url } from './bytes'
import { DEVICE_KEY_ALIAS, type DeviceKeyStore } from './device-key-store'

// Device binding for an Expo client (ADR 0043, ADR 0051). `@tula/core` makes the proofs and
// decides nothing here is its to decide; this module finds the device's key when the client
// asks for it, and notices, before any request, that the key a stored session was bound to
// is gone. Nothing here imports a native module: the key store is handed in
// (`@tula/expo/device-key`, or an app's own).

/** A P-256 coordinate: 32 bytes as base64url without padding. Also what marks a stored token. */
const COORDINATE = /^[A-Za-z0-9_-]{43}$/

/**
 * What separates a stored refresh token from the mark of the key its session is bound to.
 * A refresh token never holds a line break.
 */
const MARK = '\n'

/** The key this run of the app has found. */
interface Held {
  /** The public key's x coordinate: what a stored session is marked with. */
  x: string
  key: DeviceKey
}

let proofs = 0

/**
 * A proof's id. The server refuses one it has seen and asks nothing else of it, so it has to
 * be new and need not be a secret: the runtime's random source where there is one (a React
 * Native engine may have none), and otherwise the time, a count and what randomness there is.
 */
function proofId(): string {
  const source = (globalThis as { crypto?: { getRandomValues?: unknown } }).crypto
  if (typeof source?.getRandomValues === 'function') {
    return base64url(
      (source as { getRandomValues(bytes: Uint8Array): Uint8Array }).getRandomValues(
        new Uint8Array(16)
      )
    )
  }
  proofs += 1
  const noise = () => Math.random().toString(36).slice(2)
  return `${Date.now().toString(36)}.${proofs.toString(36)}.${noise()}${noise()}`.padEnd(16, '0')
}

function isPublicJwk(value: unknown): value is DevicePublicJwk {
  const jwk = value as Partial<DevicePublicJwk> | null
  return (
    typeof jwk === 'object' &&
    jwk !== null &&
    jwk.kty === 'EC' &&
    jwk.crv === 'P-256' &&
    typeof jwk.x === 'string' &&
    COORDINATE.test(jwk.x) &&
    typeof jwk.y === 'string' &&
    COORDINATE.test(jwk.y)
  )
}

/**
 * Build what binds an Expo client's sessions to the device's key: where `@tula/core` gets
 * the key from, and the storage that remembers which key a stored session belongs to.
 *
 * **The stored refresh token of a bound session is marked with its key** (the public key's
 * x coordinate, after a line break, in the same secure-store entry). When the app starts and
 * the entry is marked, the key is looked for before the token is handed to the client:
 *
 * - the same key is there: the token is handed on, and its refreshes carry a proof;
 * - there is none (the store made one now), another one, or no key store at all: the
 *   session cannot be refreshed by anyone, so the entry is deleted and the client starts
 *   signed out, **with no request**. The user signs in again;
 * - the key store cannot say (a rejection): the read fails, the client reports
 *   `storage.failed` and keeps the session. A key that could not be reached is never taken
 *   for a key that is gone.
 *
 * The server is not told that the session was dropped (the refresh token is the only
 * credential it would take, and presenting it without its key is refused): the session
 * stays in the account's list until it ends by itself or is ended from another device.
 *
 * @param parts - The key store the app gave, if any, and the secure-store storage.
 * @returns The storage to give the client and, with a key store, the source of its key.
 */
export function createDeviceBinding(parts: {
  store: DeviceKeyStore | undefined
  storage: TokenStorage
}): { storage: TokenStorage; source: DeviceKeySource | undefined } {
  const { store, storage: inner } = parts
  let held: Held | null = null
  /** One look at the key store at a time: two at once could each make a key. */
  let finding: Promise<Held & { created: boolean }> | null = null
  /** The mark of the session this client holds, or `null` for none and for an unmarked one. */
  let stored: string | null = null
  /**
   * The key the last start of a sign-in was proved by, or `null` when it carried no proof:
   * what the session that sign-in ends in is bound to.
   */
  let proved: string | null = null

  function deviceKey(keys: DeviceKeyStore, publicJwk: DevicePublicJwk): DeviceKey {
    return {
      publicJwk,
      proofId,
      async sign(data) {
        try {
          const signature = await keys.sign(DEVICE_KEY_ALIAS, data)
          if (!(signature instanceof Uint8Array) || signature.length !== 64) {
            throw new Error('The device key did not sign.')
          }
          return signature
        } catch (error) {
          // The key may be gone: the next request looks for it again instead of trusting
          // what this run found.
          held = null
          throw error
        }
      },
    }
  }

  function find(keys: DeviceKeyStore): Promise<Held & { created: boolean }> {
    if (!finding) {
      const looking = (async () => {
        const obtained = await keys.obtain(DEVICE_KEY_ALIAS)
        const { publicJwk } = obtained
        if (!isPublicJwk(publicJwk)) {
          throw new Error('The device key is not a P-256 key.')
        }
        // The four members and nothing else the store may have sent with them.
        const { x, y } = publicJwk
        held = { x, key: deviceKey(keys, { kty: 'EC', crv: 'P-256', x, y }) }
        return { ...held, created: obtained.created === true }
      })()
      finding = looking
      const done = () => {
        if (finding === looking) {
          finding = null
        }
      }
      looking.then(done, done)
    }
    return finding
  }

  /** Whether the key a stored session is marked with can no longer sign for it. */
  async function gone(mark: string): Promise<boolean> {
    if (!store || (await store.isAvailable()) !== true) {
      return true
    }
    const found = held ? { ...held, created: false } : await find(store)
    return found.created || found.x !== mark
  }

  const source: DeviceKeySource | undefined = store
    ? async (operation) => {
        if (operation === 'refreshSession' && stored !== null) {
          // The session is bound: only its own key may prove for it. A proof by another
          // key would be refused by the server; it is not made.
          const found = held ?? (await find(store))
          if (found.x !== stored) {
            throw new Error('The session is bound to another key.')
          }
          return found.key
        }
        const refresh = operation === 'refreshSession'
        if ((await store.isAvailable()) !== true) {
          // No key store in this build or on this device: the request goes without a proof
          // and the session, if the profile allows one, is not bound.
          proved = refresh ? proved : null
          return undefined
        }
        // A session that is not marked is not known to be bound; the server reads no proof
        // of one that is not, so sending one costs a signature and settles the doubt.
        let found: Held
        try {
          found = held ?? (await find(store))
        } catch (error) {
          // Looking for the key is how a store learns that the device can keep none (a key
          // it could not make, or could make only as RSA). It says so when asked again, and
          // the request then goes as from any device without a key store. A store that still
          // says it is there failed this once: that is the caller's to hear.
          if ((await store.isAvailable()) === true) {
            throw error
          }
          proved = refresh ? proved : null
          return undefined
        }
        proved = refresh ? proved : found.x
        return found.key
      }
    : undefined

  return {
    source,
    storage: {
      async get(name) {
        const value = await inner.get(name)
        const cut = value === null ? -1 : value.lastIndexOf(MARK)
        const mark = value === null || cut === -1 ? '' : value.slice(cut + 1)
        if (value === null || !COORDINATE.test(mark)) {
          stored = null
          return value
        }
        if (await gone(mark)) {
          stored = null
          // Asked once. A refusal leaves the entry, and the next start finds it marked with
          // a key that is still not this device's.
          await inner.remove(name).catch(() => undefined)
          return null
        }
        stored = mark
        return value.slice(0, cut)
      },
      async set(name, value) {
        // A session is bound to the key its sign-in was started with; with no start since
        // the last write, this is a refresh's next token, and the session keeps its mark.
        stored = proved ?? stored
        proved = null
        await inner.set(name, stored === null ? value : `${value}${MARK}${stored}`)
      },
      async remove(name) {
        stored = null
        proved = null
        await inner.remove(name)
      },
    },
  }
}
