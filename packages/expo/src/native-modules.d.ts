// The two native modules this package imports, declared as far as it uses them.
//
// The repository does not install React Native or Expo (about 500 packages for two imports;
// ADR 0046), so their own declarations are not there to check against. These are the
// members `native.ts` reads, copied from `expo-secure-store` 57.0.4
// (`build/SecureStore.d.ts`) and `react-native` 0.87.1
// (`Libraries/Utilities/Platform.d.ts`), the versions of Expo SDK 57. An application has
// the real packages, and their declarations take the place of these: a module that
// resolves is never an ambient one.

declare module 'expo-secure-store' {
  /** When a stored entry can be read (`kSecAttrAccessible`, iOS). */
  export type KeychainAccessibilityConstant = number
  /** Readable after the first unlock since a restart; not migrated to another device. */
  export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: KeychainAccessibilityConstant
  /** Readable only while the device is unlocked; not migrated to another device. */
  export const WHEN_UNLOCKED_THIS_DEVICE_ONLY: KeychainAccessibilityConstant
  /** The options of one read, write or delete. */
  export type SecureStoreOptions = {
    keychainService?: string
    requireAuthentication?: boolean
    authenticationPrompt?: string
    keychainAccessible?: KeychainAccessibilityConstant
    accessGroup?: string
  }
  /** Resolves with the value, or `null` when there is none; rejects when it cannot be read. */
  export function getItemAsync(key: string, options?: SecureStoreOptions): Promise<string | null>
  /** Rejects when the value cannot be stored. */
  export function setItemAsync(
    key: string,
    value: string,
    options?: SecureStoreOptions
  ): Promise<void>
  /** Rejects when the value cannot be deleted. */
  export function deleteItemAsync(key: string, options?: SecureStoreOptions): Promise<void>
}

declare module 'react-native' {
  /** The platform the app runs on. */
  export const Platform: {
    /** `ios`, `android`, or what another renderer of React Native calls itself (`web`, …). */
    readonly OS: string
  }
}
