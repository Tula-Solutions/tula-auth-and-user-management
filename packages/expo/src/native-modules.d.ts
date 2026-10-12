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
//
// These are narrower than the real declarations and were never compiled against them.
// `react-native-passkey` declares `Passkey` as a class with static methods (`create`,
// `get`, `isSupported` and others this package does not call) and typed requests and
// results; here it is a constant object with the three members, taking and returning
// `object`. `expo-web-browser`'s options and result types have members left out. A
// difference between the two shows only when an application compiles against the real
// packages, which nobody has done (`docs/plans/phase-2-unverified.md`).

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

// The three modules below were added with the native sign-in sheets and the device key
// (ADR 0051), under the same terms: members copied from `expo-apple-authentication` 57.0.2
// (`build/AppleAuthentication.d.ts`, `build/AppleAuthentication.types.d.ts`; the version
// Expo SDK 57 pins), `react-native-nitro-google-signin` 2.3.0
// (`lib/typescript/src/GoogleOneTapSignIn.d.ts`, `…/specs/nitro-google-signin.nitro.d.ts`)
// and `@pagopa/io-react-native-crypto` 1.2.5 (`lib/typescript/index.d.ts`), narrower than
// the real ones and never compiled against them.

declare module 'expo-apple-authentication' {
  /** What a sign-in may ask Apple to hand over. */
  export enum AppleAuthenticationScope {
    FULL_NAME = 0,
    EMAIL = 1,
  }
  /** The name Apple hands over the first time an account is used with the app. */
  export type AppleAuthenticationFullName = {
    givenName: string | null
    familyName: string | null
  }
  /** What a sign-in resolves with, as far as this package reads it. */
  export type AppleAuthenticationCredential = {
    /** The identity token (a JWT). */
    identityToken: string | null
    fullName: AppleAuthenticationFullName | null
  }
  /** The options of a sign-in this package sets. */
  export type AppleAuthenticationSignInOptions = {
    requestedScopes?: AppleAuthenticationScope[]
    /** Handed to `ASAuthorizationAppleIDRequest.nonce` as it is. */
    nonce?: string
  }
  /** `false` where the system has no Sign in with Apple (Android, iOS before 13). */
  export function isAvailableAsync(): Promise<boolean>
  /** Rejects with the code `ERR_REQUEST_CANCELED` when the user dismisses the sheet. */
  export function signInAsync(
    options?: AppleAuthenticationSignInOptions
  ): Promise<AppleAuthenticationCredential>
}

declare module 'react-native-nitro-google-signin' {
  /** What a sign-in resolves with. `data` is non-null only for `success`. */
  export type OneTapResponse = {
    type: 'success' | 'noSavedCredentialFound' | 'cancelled'
    data: {
      idToken: string
      user: { givenName: string | null; familyName: string | null }
    } | null
  }
  /** The options of `configure` this package sets. */
  export type OneTapConfigureParams = {
    webClientId: string
    iosClientId?: string | null
    nonce?: string | null
  }
  /** Google's sign-in calls. */
  export const GoogleOneTapSignIn: {
    /** Required before any other call; sets the nonce of the next sign-in. */
    configure(params: OneTapConfigureParams): void
    /** Rejects on an Android device without usable Play Services; resolves on iOS. */
    checkPlayServices(showErrorResolutionDialog?: boolean): Promise<void>
    /** The explicit "Sign in with Google" sheet. */
    presentExplicitSignIn(): Promise<OneTapResponse>
  }
}

declare module '@pagopa/io-react-native-crypto' {
  /** A public key as a JWK: an EC key, or the RSA key Android falls back to. */
  export type PublicKey =
    | { kty: 'EC'; crv: string; x: string; y: string }
    | { kty: 'RSA'; alg: string; e: string; n: string }
  /** The key under `keyTag`, coordinates as base64url without padding. */
  export function getPublicKeyFixed(keyTag: string): Promise<PublicKey>
  /** Make a hardware-backed key under `keyTag`; rejects when one is there. */
  export function generate(keyTag: string): Promise<PublicKey>
  /** A base64 DER signature (ECDSA, SHA-256) over the message's UTF-8 bytes. */
  export function sign(message: string, keyTag: string): Promise<string>
  /** Delete the key under `keyTag`; resolves when there is none. */
  export function deleteKey(keyTag: string): Promise<void>
}
