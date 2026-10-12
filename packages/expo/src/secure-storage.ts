import type { TokenStorage } from '@tula/core'

/**
 * When the device lets the stored refresh token be read. Both keep it on this device only: it
 * is never synced and never restored to another device from a backup.
 *
 * - `when_unlocked` (the default): only while the device is unlocked.
 * - `after_first_unlock`: from the first unlock after a restart, also while locked. For an
 *   app that asks for a token from a background task; see the README for what the default
 *   costs such an app.
 *
 * iOS only (`kSecAttrAccessible`). On Android the value is encrypted with a Keystore key
 * whatever this says.
 *
 * @example
 * ```ts
 * const access: KeychainAccess = 'after_first_unlock'
 * ```
 */
export type KeychainAccess = 'when_unlocked' | 'after_first_unlock'

/**
 * How the refresh token is kept in the device's secure store.
 *
 * @example
 * ```ts
 * const options: SecureStorageOptions = { keychainAccess: 'after_first_unlock' }
 * ```
 */
export interface SecureStorageOptions {
  /** When the token can be read (iOS). Defaults to `when_unlocked`. */
  keychainAccess?: KeychainAccess
  /**
   * The Keychain service (iOS) or Keystore alias (Android) to keep the token under, for an
   * app that separates its own entries. Changing it later hides the stored token: the user
   * signs in again.
   */
  keychainService?: string
}

/** The options `expo-secure-store` takes with a read, a write or a delete, as far as used here. */
interface SecureStoreItemOptions {
  keychainService?: string
  keychainAccessible?: number
}

/**
 * The part of `expo-secure-store` this package uses. The module itself satisfies it; tests
 * pass a fake.
 *
 * @example
 * ```ts
 * import * as SecureStore from 'expo-secure-store'
 * const store: SecureStoreLike = SecureStore
 * ```
 */
export interface SecureStoreLike {
  /** Resolves with the value or `null`; rejects when the store cannot be read. */
  getItemAsync(key: string, options?: SecureStoreItemOptions): Promise<string | null>
  /** Rejects when the value cannot be stored. */
  setItemAsync(key: string, value: string, options?: SecureStoreItemOptions): Promise<void>
  /** Rejects when the value cannot be deleted. */
  deleteItemAsync(key: string, options?: SecureStoreItemOptions): Promise<void>
  /** `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`. */
  readonly WHEN_UNLOCKED_THIS_DEVICE_ONLY: number
  /** `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. */
  readonly AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: number
}

/**
 * The largest value the adapter stores, in bytes of UTF-8.
 *
 * `expo-secure-store` enforces no limit of its own and says that some iOS releases refused
 * values above about 2048 bytes. A refresh token is about 50 characters, so nothing this
 * package stores comes near; the adapter refuses a larger value itself, so that what happens
 * to one does not depend on the phone it happens on.
 *
 * @example
 * ```ts
 * expect(new TextEncoder().encode(refreshToken).length).toBeLessThan(MAX_SECURE_VALUE_BYTES)
 * ```
 */
export const MAX_SECURE_VALUE_BYTES = 2048

/**
 * How long the adapter waits before it asks the secure store to take a value again, in
 * milliseconds: a write is tried once and then once more after each of these, three times
 * in all.
 *
 * The server has already replaced the refresh token when the client stores the next one. A
 * write that fails leaves the store holding a token that is no longer the newest, and an
 * app that is ended before a later write gets through starts again with it: past the
 * server's grace window that is a reuse, and the user signs in again. A store that refused
 * for a moment (a write racing a lock, a busy Keychain) is worth a quarter of a second; one
 * that keeps refusing is reported, not waited for. The whole wait is inside the client's
 * single refresh, so it is kept far below the refresh's own time limit.
 *
 * @example
 * ```ts
 * SECURE_WRITE_RETRY_DELAYS_MS // [50, 200]
 * ```
 */
export const SECURE_WRITE_RETRY_DELAYS_MS: readonly number[] = [50, 200]

/**
 * When the adapter asks the secure store again, later, to take a value it refused three
 * times in a row: this long after the last refusal, and then this long after the one before,
 * in milliseconds. Two more tries, and then no more.
 *
 * The three immediate tries are inside the client's refresh and have to be short. After
 * them the running app holds the newest refresh token in memory only, the store holds the
 * one the server has replaced, and the client's next write is a whole access token's
 * lifetime away; `getToken()` tells the app nothing. These tries shorten that time for a
 * store that recovers within seconds. They write the value of the newest write only: a
 * newer write or a delete of the same entry cancels them. The numbers are a guess, not a
 * measurement of any phone.
 *
 * @example
 * ```ts
 * SECURE_REWRITE_DELAYS_MS // [1000, 5000]
 * ```
 */
export const SECURE_REWRITE_DELAYS_MS: readonly number[] = [1_000, 5_000]

/**
 * Runs something later and can call it off. `secureStoreStorage` waits through one of these
 * and nothing else, so a test moves time itself; the default is the runtime's timers.
 *
 * @param run - What to run.
 * @param ms - How long from now, in milliseconds.
 * @returns Calls it off; does nothing once it has run.
 *
 * @example
 * ```ts
 * const schedule: Schedule = (run, ms) => {
 *   const timer = setTimeout(run, ms)
 *   return () => clearTimeout(timer)
 * }
 * ```
 */
export type Schedule = (run: () => void, ms: number) => () => void

/** The runtime's timers. A timer of this package never keeps a process alive by itself. */
export const realSchedule: Schedule = (run, ms) => {
  const timer: unknown = setTimeout(run, ms)
  // Node and Bun hand back an object that holds the process open; React Native a number.
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    ;(timer as { unref(): void }).unref()
  }
  return () => clearTimeout(timer as Parameters<typeof clearTimeout>[0])
}

/** Resolve after `ms` milliseconds of a schedule. */
function wait(schedule: Schedule, ms: number): Promise<void> {
  return new Promise((resolve) => {
    schedule(resolve, ms)
  })
}

/** What is known of one entry of one secure store, by every adapter over that store. */
interface EntryState {
  /** The newest write or delete asked for. */
  turn: number
  /** Calls off the later try of a refused write, while one is waiting. */
  cancel: (() => void) | null
  /** Whether the newest thing asked of the entry is a delete. */
  removed: boolean
}

/**
 * The entries of every secure store an adapter was made for. Keyed by the store object and
 * not kept per adapter: two adapters over one store (two clients, a client made again) write
 * the same entry, and each has to see the other's newer write or sign-out.
 */
const entries = new WeakMap<SecureStoreLike, Map<string, EntryState>>()

/** The state of one entry of a store, made when first asked for. */
function entryOf(store: SecureStoreLike, name: string): EntryState {
  let ofStore = entries.get(store)
  if (!ofStore) {
    ofStore = new Map()
    entries.set(store, ofStore)
  }
  let state = ofStore.get(name)
  if (!state) {
    state = { turn: 0, cancel: null, removed: false }
    ofStore.set(name, state)
  }
  return state
}

/**
 * Take the newest turn of an entry: what waited to be written to it is called off. A write
 * that is already in the store's hands is not: nothing can recall it.
 */
function claim(state: EntryState, removed: boolean): number {
  state.cancel?.()
  state.cancel = null
  state.turn += 1
  state.removed = removed
  return state.turn
}

/**
 * Start a call of the store so that whatever it does is a promise's outcome: a store that
 * throws at the call itself, where a real one rejects, must not throw out of a timer.
 */
function started(call: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve) => {
    resolve(call())
  })
}

/** What a secure-store key may hold besides the escape character: letters, digits, `.` and `-`. */
const PLAIN = /^[A-Za-z0-9.-]$/

/**
 * The UTF-8 bytes of one code point. Written out because the package asks the runtime for
 * nothing a React Native engine may lack (`TextEncoder` is not in every one).
 */
function utf8(codePoint: number): number[] {
  if (codePoint < 0x80) {
    return [codePoint]
  }
  if (codePoint < 0x800) {
    return [0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f)]
  }
  if (codePoint < 0x10000) {
    return [0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f)]
  }
  return [
    0xf0 | (codePoint >> 18),
    0x80 | ((codePoint >> 12) & 0x3f),
    0x80 | ((codePoint >> 6) & 0x3f),
    0x80 | (codePoint & 0x3f),
  ]
}

/** How many bytes of UTF-8 a text is. */
function byteLength(text: string): number {
  let bytes = 0
  for (const character of text) {
    bytes += utf8(character.codePointAt(0) as number).length
  }
  return bytes
}

/**
 * The secure-store key for one of the client's storage keys.
 *
 * `expo-secure-store` accepts letters, digits, `.`, `-` and `_` in a key, and `@tula/core`
 * names its entry after the API's address and the publishable key
 * (`tula.refresh.https://…|tula_pk_…`). Every other character, and `_` itself, is written as
 * `_` and the two hexadecimal digits of each of its UTF-8 bytes, so two different keys never
 * share an entry.
 *
 * @param key - The client's storage key.
 * @returns The key to give the secure store.
 *
 * @example
 * ```ts
 * secureStoreKey('tula.refresh.https://auth.example.com')
 * // 'tula.refresh.https_3a_2f_2fauth.example.com'
 * ```
 */
export function secureStoreKey(key: string): string {
  let encoded = ''
  for (const character of key) {
    if (PLAIN.test(character)) {
      encoded += character
      continue
    }
    for (const byte of utf8(character.codePointAt(0) as number)) {
      encoded += `_${byte.toString(16).padStart(2, '0')}`
    }
  }
  return encoded
}

/**
 * A `TokenStorage` for `@tula/core` that keeps values in the device's secure store: the
 * Keychain on iOS, Keystore-encrypted preferences on Android.
 *
 * The client uses it for one thing, its refresh token. Nothing is cached here and nothing is
 * logged; a read, a write or a delete the store refuses rejects, which the client reports as
 * `storage.failed` without ending the session. A value over {@link MAX_SECURE_VALUE_BYTES} is
 * refused before the store is asked. No error made here holds a value.
 *
 * A write the store refuses is tried again, twice ({@link SECURE_WRITE_RETRY_DELAYS_MS}),
 * before it rejects: the token being written has already replaced the stored one on the
 * server. After it has rejected, the same value is offered to the store twice more, later
 * ({@link SECURE_REWRITE_DELAYS_MS}), without anybody waiting for it. A read and a delete
 * are asked once.
 *
 * A write that is *waiting* to be tried again, now or later, gives up when a newer write or
 * a delete of the same entry was asked for meanwhile: a waiting try never undoes a sign-out
 * and never lands on a newer token. That holds across every adapter made over the same
 * store object, for the same key and service. It does not hold across two store objects
 * over one Keychain, nor across processes (an app extension).
 *
 * A write that is already in the store's hands is not recalled; nothing can recall it. Two
 * things follow for a later try that was inside the store when something newer was asked:
 *
 * - **A delete (a sign-out).** When the late write is taken after all, the adapter asks the
 *   store to delete the entry once more, once. If the store refuses that delete, the value
 *   stays: nobody is told and nothing is tried again.
 * - **A newer write.** Nothing is added. The adapter asked for the older value first and
 *   the newer one second; which of two writes in flight the native layer completes last is
 *   the native layer's, and an older token that lands last is what the store then holds
 *   until the client's next refresh writes its own. This was not observed on any phone.
 *
 * A waiting later try is called off by a newer write or a delete, and its timer never keeps
 * a process alive; an adapter that is dropped while one waits still makes at most those two
 * tries, within six seconds, and then holds nothing.
 *
 * `requireAuthentication` is never set: a refresh would ask for the user's face or
 * fingerprint every minute, and Expo Go does not support it.
 *
 * @param store - `expo-secure-store` (or, in a test, a fake of it).
 * @param options - When the token can be read on iOS, and the service to keep it under.
 * @param schedule - How the adapter waits; the runtime's timers unless a test passes its own.
 * @returns The storage adapter.
 * @throws TypeError for a `keychainAccess` that is not one of the two, or a `keychainService`
 *   that is not a non-empty string.
 *
 * @example
 * ```ts
 * import * as SecureStore from 'expo-secure-store'
 * const storage = secureStoreStorage(SecureStore)
 * ```
 */
export function secureStoreStorage(
  store: SecureStoreLike,
  options: SecureStorageOptions = {},
  schedule: Schedule = realSchedule
): TokenStorage {
  const { keychainAccess = 'when_unlocked', keychainService } = options
  if (keychainAccess !== 'when_unlocked' && keychainAccess !== 'after_first_unlock') {
    throw new TypeError(
      '@tula/expo: `keychainAccess` is `when_unlocked` or `after_first_unlock`; the token is never kept in a class that leaves the device'
    )
  }
  if (
    keychainService !== undefined &&
    (typeof keychainService !== 'string' || keychainService === '')
  ) {
    throw new TypeError('@tula/expo: `keychainService` must be a non-empty string')
  }
  // Read when an entry is touched, not here: the module's constants are native values.
  const itemOptions = (): SecureStoreItemOptions => ({
    keychainAccessible:
      keychainAccess === 'after_first_unlock'
        ? store.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY
        : store.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    ...(keychainService !== undefined && { keychainService }),
  })
  // A value kept under a service is another entry than the same key under none.
  const stateOf = (entry: string): EntryState => entryOf(store, `${keychainService ?? ''}/${entry}`)

  /**
   * Offer a value the store refused to it again, later, with nobody waiting: while it is
   * still the newest thing asked of the entry, and no more often than the list says.
   */
  function writeLater(state: EntryState, turn: number, entry: string, value: string): void {
    const attempt = (index: number): void => {
      const delay = SECURE_REWRITE_DELAYS_MS[index]
      if (delay === undefined || state.turn !== turn) {
        return
      }
      state.cancel = schedule(() => {
        state.cancel = null
        if (state.turn !== turn) {
          return
        }
        started(() => store.setItemAsync(entry, value, itemOptions())).then(
          () => {
            if (state.turn === turn || !state.removed) {
              // Still the newest, or a newer write followed: nothing more is asked (a
              // delete now would take a signed-in user's token).
              return
            }
            // A sign-out came while the store had this write, and the write was taken
            // after it: the entry is deleted again. Asked once; a refusal is left at that.
            started(() => store.deleteItemAsync(entry, itemOptions())).then(
              () => undefined,
              () => undefined
            )
          },
          // Refused again: the next try, if one is left. Nobody is told; the write that
          // asked has already rejected, and the client's next refresh writes its own token.
          () => attempt(index + 1)
        )
      }, delay)
    }
    attempt(0)
  }
  return {
    async get(key) {
      const value = await store.getItemAsync(secureStoreKey(key), itemOptions())
      // Anything but a non-empty string is no token: the client then knows it has none.
      return typeof value === 'string' && value !== '' ? value : null
    },
    async set(key, value) {
      if (byteLength(value) > MAX_SECURE_VALUE_BYTES) {
        throw new RangeError(
          `@tula/expo: a value over ${MAX_SECURE_VALUE_BYTES} bytes is not kept in the secure store`
        )
      }
      const entry = secureStoreKey(key)
      const state = stateOf(entry)
      const turn = claim(state, false)
      for (let attempt = 0; ; attempt += 1) {
        try {
          await store.setItemAsync(entry, value, itemOptions())
          return
        } catch (cause) {
          const delay = SECURE_WRITE_RETRY_DELAYS_MS[attempt]
          if (delay === undefined) {
            if (state.turn === turn) {
              writeLater(state, turn, entry, value)
            }
            throw cause
          }
          await wait(schedule, delay)
          if (state.turn !== turn) {
            // Signed out, or a newer token written, while this one waited: writing it now
            // would put back what was removed or replaced. The failure stands.
            throw cause
          }
        }
      }
    },
    async remove(key) {
      const entry = secureStoreKey(key)
      claim(stateOf(entry), true)
      await store.deleteItemAsync(entry, itemOptions())
    },
  }
}
