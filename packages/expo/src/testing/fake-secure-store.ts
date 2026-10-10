import type { SecureStoreLike } from '../secure-storage'

/** One call a test's secure store received. */
export interface SecureStoreCall {
  operation: 'get' | 'set' | 'delete'
  key: string
  /** The options given with the call, as they were. */
  options: { keychainService?: string; keychainAccessible?: number } | undefined
}

/**
 * `expo-secure-store` for tests: the same functions and constants, an in-memory map, and the
 * rule about keys the real module enforces. A test can make the next calls fail (a locked
 * device, a full disk) and read what was asked.
 */
export interface FakeSecureStore extends SecureStoreLike {
  /** What is stored, by the key the store was given and its service. */
  readonly entries: Map<string, string>
  /** Every call, in order. */
  readonly calls: SecureStoreCall[]
  /**
   * Make calls of one operation reject until cleared.
   *
   * @param operation - Which calls fail.
   * @param error - What they reject with; `null` lets them through again.
   */
  fail(operation: SecureStoreCall['operation'], error: Error | null): void
}

/** The keys the real module accepts: "alphanumeric characters, `.`, `-`, and `_`". */
const VALID_KEY = /^[A-Za-z0-9._-]+$/

/** The two constants this package reads, as the real module numbers them on iOS. */
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 6
export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY = 1

/** @returns An empty secure store. */
export function fakeSecureStore(): FakeSecureStore {
  const entries = new Map<string, string>()
  const calls: SecureStoreCall[] = []
  const failing = new Map<SecureStoreCall['operation'], Error>()

  /** Record the call and refuse what the real module would. */
  function enter(
    operation: SecureStoreCall['operation'],
    key: string,
    options: SecureStoreCall['options']
  ): string {
    calls.push({ operation, key, options })
    if (!VALID_KEY.test(key)) {
      throw new Error('Invalid key provided to SecureStore.')
    }
    const failure = failing.get(operation)
    if (failure) {
      throw failure
    }
    // A value set under a service is found only under that service.
    return `${options?.keychainService ?? ''}/${key}`
  }

  return {
    entries,
    calls,
    WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    fail(operation, error) {
      if (error) {
        failing.set(operation, error)
      } else {
        failing.delete(operation)
      }
    },
    async getItemAsync(key, options) {
      return entries.get(enter('get', key, options)) ?? null
    },
    async setItemAsync(key, value, options) {
      entries.set(enter('set', key, options), value)
    },
    async deleteItemAsync(key, options) {
      entries.delete(enter('delete', key, options))
    },
  }
}
