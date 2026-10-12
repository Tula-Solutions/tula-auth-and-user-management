import type {
  DeviceKey,
  DeviceKeySource,
  DevicePublicJwk,
  FetchLike,
  TokenStorage,
} from '@tula/core'
import { base64Bytes, base64url } from './bytes'
import { DEVICE_KEY_ALIAS, type DeviceKeyStore } from './device-key-store'
import { sha256Hex } from './sha256'

// Device binding for an Expo client (ADR 0043, ADR 0052). `@tula/core` makes the proofs and
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

/** How many answers' marks are remembered between an answer and the write of its token. */
const REMEMBERED = 4

/** The key this run of the app has found. */
interface Held {
  /** The public key's x coordinate: what a stored session is marked with. */
  x: string
  /** The key's thumbprint (RFC 7638): what the server names a bound session's key by. */
  jkt: string
  key: DeviceKey
}

function hexBytes(hex: string): number[] {
  const bytes: number[] = []
  for (let at = 0; at < hex.length; at += 2) {
    bytes.push(Number.parseInt(hex.slice(at, at + 2), 16))
  }
  return bytes
}

/** The thumbprint of a P-256 public key (RFC 7638): the members in order, hashed. */
function thumbprint(x: string, y: string): string {
  return base64url(hexBytes(sha256Hex(`{"crv":"P-256","kty":"EC","x":"${x}","y":"${y}"}`)))
}

/**
 * The key an access token says its session is bound to (`cnf.jkt`, ADR 0043), or `null`
 * for a session that is not bound and for anything that is not such a token. The token is
 * not verified here and nothing is granted for it: it is read for the one fact of which key
 * the server bound, from the server's own answer.
 */
function boundKeyOf(accessToken: string): string | null {
  try {
    const bytes = base64Bytes(accessToken.split('.')[1] ?? '')
    // A byte a character: a claim outside ASCII comes out wrong and still parses, and the
    // thumbprint is ASCII.
    const claims: unknown = JSON.parse(String.fromCharCode(...(bytes ?? [])))
    const cnf = (claims as { cnf?: { jkt?: unknown } } | null)?.cnf
    return typeof cnf?.jkt === 'string' ? cnf.jkt : null
  } catch {
    return null
  }
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
 * x coordinate, after a line break, in the same secure-store entry). **A token is marked
 * only on the server's word**: `watch` reads every answer that issues a session, and the
 * mark is written when that answer's access token names this device's key (`cnf.jkt`). A
 * start that was proven and then failed or was left, and a refresh of a session the server
 * never bound, mark nothing: `@tula/core` hands the storage a token and nothing about the
 * attempt it came from, so the answer the token arrived in is what is asked. A token no
 * watched answer brought is stored unmarked. When the app starts and
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
 * @returns The storage to give the client, with a key store the source of its key, and
 *   `watch`, which the client's `fetch` goes through.
 */
export function createDeviceBinding(parts: {
  store: DeviceKeyStore | undefined
  storage: TokenStorage
}): {
  storage: TokenStorage
  source: DeviceKeySource | undefined
  watch(fetch: FetchLike | undefined): FetchLike | undefined
} {
  const { store, storage: inner } = parts
  let held: Held | null = null
  /**
   * The last key this run found, kept apart from `held`: a signature that fails clears
   * `held` so that the next request looks again, and an answer still on its way then has to
   * be compared with the key its request was proven by.
   */
  let known: { x: string; jkt: string } | null = null
  /** One look at the key store at a time: two at once could each make a key. */
  let finding: Promise<Held & { created: boolean }> | null = null
  /** The mark of the session this client holds, or `null` for none and for an unmarked one. */
  let stored: string | null = null
  /**
   * What each newly issued refresh token is to be marked with, by the token's hash (the
   * token itself is kept nowhere but the secure store; its hash here, in memory, until the
   * token is replaced four answers on or the entry is removed): written by `watch` from the answer
   * the token arrived in, read by the write of that token.
   */
  const marks = new Map<string, string | null>()

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
        held = { x, jkt: thumbprint(x, y), key: deviceKey(keys, { kty: 'EC', crv: 'P-256', x, y }) }
        known = { x: held.x, jkt: held.jkt }
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
        if ((await store.isAvailable()) !== true) {
          // No key store in this build or on this device: the request goes without a proof
          // and the session, if the profile allows one, is not bound.
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
          return undefined
        }
        return found.key
      }
    : undefined

  /** Remember what the session an answer issued is bound to, for the write of its token. */
  function note(body: unknown): void {
    // A refresh answers the tokens themselves; a step that completes a sign-in holds them
    // as its `session`.
    const top = body as { session?: unknown } | null
    const issued = (typeof top?.session === 'object' ? top.session : top) as {
      refreshToken?: unknown
      accessToken?: unknown
    } | null
    if (typeof issued?.refreshToken !== 'string' || typeof issued.accessToken !== 'string') {
      return
    }
    const jkt = boundKeyOf(issued.accessToken)
    // Another key's session, and one bound while this run has found no key, are left unmarked:
    // there is no coordinate to mark them with, and unmarked is the safe side.
    marks.set(sha256Hex(issued.refreshToken), known && jkt === known.jkt ? known.x : null)
    for (const oldest of marks.keys()) {
      if (marks.size <= REMEMBERED) {
        break
      }
      marks.delete(oldest)
    }
  }

  return {
    source,
    watch(fetch) {
      if (!store) {
        return fetch
      }
      return async (request) => {
        // The runtime's own `fetch` where the app gave none, looked up when it is called.
        const response = await (fetch ?? globalThis.fetch)(request)
        if (response.ok) {
          try {
            note(await response.clone().json())
          } catch {
            // An answer that could not be read here marks nothing; the client reads its own.
          }
        }
        return response
      }
    },
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
        // The mark is what the answer this token arrived in said: a new session's, or a
        // refresh's next token of the same session. Never what an earlier start hoped for.
        stored = marks.get(sha256Hex(value)) ?? null
        await inner.set(name, stored === null ? value : `${value}${MARK}${stored}`)
      },
      async remove(name) {
        stored = null
        // A signed-out client keeps nothing of its tokens, their hashes included.
        marks.clear()
        await inner.remove(name)
      },
    },
  }
}
