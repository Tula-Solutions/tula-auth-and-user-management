// The native modules this package imports, declared as far as it uses them.
//
// The repository does not install React Native or Expo (about 500 packages for two imports;
// ADR 0046), so their own declarations are not there to check against. These are the
// members `native.ts` reads, copied from `expo-secure-store` 57.0.4
// (`build/SecureStore.d.ts`) and `react-native` 0.86.3
// (`Libraries/Utilities/Platform.d.ts`), the versions of Expo SDK 57; of
// `expo-web-browser` 57.0.3 (`build/WebBrowser.d.ts`, `build/WebBrowser.types.d.ts`), which
// `browser.ts` reads; and of `react-native-passkey` 3.6.2 (`lib/typescript/Passkey.d.ts`),
// which `passkeys.ts` reads. An application has
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

declare module 'expo-web-browser' {
  /** What an authentication session ended with: the redirect, or why there was none. */
  export type WebBrowserAuthSessionResult =
    | { type: 'success'; url: string }
    | { type: 'cancel' | 'dismiss' | 'opened' | 'locked' }
  /** The options of an authentication session this package sets. */
  export type AuthSessionOpenOptions = {
    /** iOS: do not share cookies with the user's browser. */
    preferEphemeralSession?: boolean
    /** iOS 17.4 and later: match an https callback as a universal link. */
    preferUniversalLinks?: boolean
  }
  /**
   * Open `url` in the system's authentication session and resolve when the browser is sent
   * to `redirectUrl` or closed.
   */
  export function openAuthSessionAsync(
    url: string,
    redirectUrl?: string | null,
    options?: AuthSessionOpenOptions
  ): Promise<WebBrowserAuthSessionResult>
}

declare module 'react-native-passkey' {
  /** The platform's passkey calls. Each rejects with a plain `{ error, message }`. */
  export const Passkey: {
    /** Make a passkey from WebAuthn creation options in their JSON form. */
    create(request: object): Promise<object>
    /** Ask for a passkey with WebAuthn request options in their JSON form. */
    get(request: object): Promise<object>
    /** iOS 15 and later, Android API 28 and later. */
    isSupported(): boolean
  }
}
