/**
 * Where a non-browser client keeps its refresh token between runs.
 *
 * The `web` client kind never uses it: there the refresh token lives in an httpOnly cookie that
 * JavaScript cannot read. For `ios`, `android` and `server` the token is a long-lived
 * credential, so back this with the platform's secure store (Keychain, Keystore, an encrypted
 * file), never with `localStorage` or a plain file. A React Native secure-store adapter ships in
 * Phase 2.
 *
 * @example
 * ```ts
 * const keychain: TokenStorage = {
 *   get: (key) => SecureStore.getItemAsync(key),
 *   set: (key, value) => SecureStore.setItemAsync(key, value),
 *   remove: (key) => SecureStore.deleteItemAsync(key),
 * }
 * createTulaClient({ publishableKey, baseUrl, client: 'ios', storage: keychain })
 * ```
 */
export interface TokenStorage {
  /**
   * @param key - The entry's name.
   * @returns The stored value, or `null` when there is none.
   */
  get(key: string): Promise<string | null>
  /**
   * @param key - The entry's name.
   * @param value - The value to store.
   */
  set(key: string, value: string): Promise<void>
  /** @param key - The entry to delete. Deleting a missing entry is not an error. */
  remove(key: string): Promise<void>
}

/**
 * A {@link TokenStorage} that keeps values in memory: the session lasts as long as the process
 * (or the page). The default for non-browser clients, and the right choice for scripts and
 * tests.
 *
 * @returns The storage.
 *
 * @example
 * ```ts
 * createTulaClient({ publishableKey, baseUrl, client: 'server', storage: memoryStorage() })
 * ```
 */
export function memoryStorage(): TokenStorage {
  const values = new Map<string, string>()
  return {
    async get(key) {
      return values.get(key) ?? null
    },
    async set(key, value) {
      values.set(key, value)
    },
    async remove(key) {
      values.delete(key)
    },
  }
}
