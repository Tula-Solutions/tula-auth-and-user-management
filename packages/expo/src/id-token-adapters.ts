import type { IdTokenSheet } from './host'
import { wordOf } from './native-words'

// The sheets of Apple and Google over their native modules. The modules are arguments, so
// both adapters run (and are tested) where neither is installed; `apple.ts` and
// `google.ts` hand in the real ones.

/** `expo-apple-authentication`, as far as the adapter calls it. */
export interface AppleAuthenticationModuleLike {
  isAvailableAsync(): Promise<boolean>
  signInAsync(options?: { requestedScopes?: number[]; nonce?: string }): Promise<{
    identityToken?: unknown
    fullName?: { givenName?: unknown; familyName?: unknown } | null
  }>
  readonly AppleAuthenticationScope: { readonly FULL_NAME: number; readonly EMAIL: number }
}

/**
 * Sign in with Apple's sheet over `expo-apple-authentication`.
 *
 * Read from the module's tarball, version 57.0.2 (`build/AppleAuthentication.js`,
 * `ios/AppleAuthenticationRequest.swift`), and from nothing that ran: `isAvailableAsync`
 * answers `false` where the native module is missing and on Android; `signInAsync` hands
 * its `nonce` to `ASAuthorizationAppleIDRequest.nonce` as it is, and rejects with the code
 * `ERR_REQUEST_CANCELED` when the user dismisses the sheet. **No sheet was dismissed to see
 * that code arrive**: a dismissal that reaches here under another code is a failure where
 * the user only closed a sheet (`docs/plans/phase-2-unverified.md`).
 *
 * The name and the email address are asked for (Apple hands them over the first time an
 * account is used with the app, and the server needs the token's verified address to make
 * an account). Of what the sheet returns, the identity token and the two names are kept;
 * the module's own message stops here.
 *
 * @param module - The module.
 * @returns The sheet `createTulaExpoClient` takes as `apple`.
 */
export function appleSheetOver(module: AppleAuthenticationModuleLike): IdTokenSheet {
  const part = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined)
  return {
    async isAvailable() {
      try {
        return (await module.isAvailableAsync()) === true
      } catch {
        return false
      }
    },
    async signIn({ nonce }) {
      let credential: Awaited<ReturnType<AppleAuthenticationModuleLike['signInAsync']>>
      try {
        const { FULL_NAME, EMAIL } = module.AppleAuthenticationScope
        credential = await module.signInAsync({ requestedScopes: [FULL_NAME, EMAIL], nonce })
      } catch (thrown) {
        if (wordOf(thrown, 'code') === 'ERR_REQUEST_CANCELED') {
          return null
        }
        throw new Error('Sign in with Apple failed.')
      }
      const idToken = part(credential?.identityToken)
      if (idToken === undefined) {
        throw new Error('Sign in with Apple returned no identity token.')
      }
      return {
        idToken,
        givenName: part(credential.fullName?.givenName),
        familyName: part(credential.fullName?.familyName),
      }
    },
  }
}

/** `react-native-nitro-google-signin`'s `GoogleOneTapSignIn`, as far as the adapter calls it. */
export interface GoogleSignInModuleLike {
  configure(params: {
    webClientId: string
    iosClientId?: string | null
    nonce?: string | null
  }): void
  checkPlayServices(showErrorResolutionDialog?: boolean): Promise<void>
  presentExplicitSignIn(): Promise<{
    type: string
    data?: {
      idToken?: unknown
      user?: { givenName?: unknown; familyName?: unknown } | null
    } | null
  }>
}

/**
 * The OAuth client ids Google's sheet is configured with. Neither is a secret.
 *
 * @example
 * ```ts
 * const ids: GoogleClientIds = {
 *   webClientId: '1234-abc.apps.googleusercontent.com',
 *   iosClientId: '1234-def.apps.googleusercontent.com',
 * }
 * ```
 */
export interface GoogleClientIds {
  /**
   * The **web** client id: the audience of the ID token on Android, and the one the
   * environment's Google provider is configured with (or one of its
   * `additionalClientIds`).
   */
  webClientId: string
  /**
   * The **iOS** client id, which is the audience of the ID token on iOS: it has to be among
   * the Google provider's `additionalClientIds`. Left out, the module reads it from a
   * `GoogleService-Info.plist`.
   */
  iosClientId?: string
}

/**
 * Google's account sheet over `react-native-nitro-google-signin`.
 *
 * Read from the module's tarball, version 2.3.0 (`src/GoogleOneTapSignIn.ts`, the Swift and
 * Kotlin sources under `ios/` and `android/`), and from nothing that ran: `configure` takes
 * a `nonce` and hands it to `GIDSignIn` on iOS and to `GetSignInWithGoogleOption.setNonce`
 * on Android as it is, so it is set again before every sign-in; `presentExplicitSignIn`
 * resolves with `type` `success`, `cancelled` or `noSavedCredentialFound`, and a native
 * cancellation that is thrown carries the code `SIGN_IN_CANCELLED`; `checkPlayServices`
 * rejects on an Android device without usable Play Services and resolves on iOS. **No sheet
 * was shown or dismissed to see any of it.**
 *
 * @param module - The module's `GoogleOneTapSignIn`.
 * @param ids - The client ids.
 * @returns The sheet `createTulaExpoClient` takes as `google`.
 */
export function googleSheetOver(
  module: GoogleSignInModuleLike,
  ids: GoogleClientIds
): IdTokenSheet {
  const part = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined)
  const { webClientId, iosClientId } = ids
  return {
    async isAvailable() {
      try {
        // `false`: never Google's own dialog for a question asked while drawing a screen.
        await module.checkPlayServices(false)
        return true
      } catch {
        return false
      }
    },
    async signIn({ nonce }) {
      let answer: Awaited<ReturnType<GoogleSignInModuleLike['presentExplicitSignIn']>>
      try {
        module.configure({ webClientId, ...(iosClientId && { iosClientId }), nonce })
        answer = await module.presentExplicitSignIn()
      } catch (thrown) {
        if (wordOf(thrown, 'code') === 'SIGN_IN_CANCELLED') {
          return null
        }
        throw new Error('Sign in with Google failed.')
      }
      if (answer?.type === 'cancelled' || answer?.type === 'noSavedCredentialFound') {
        return null
      }
      const idToken = answer?.type === 'success' ? part(answer.data?.idToken) : undefined
      if (idToken === undefined) {
        throw new Error('Sign in with Google returned no ID token.')
      }
      return {
        idToken,
        givenName: part(answer.data?.user?.givenName),
        familyName: part(answer.data?.user?.familyName),
      }
    },
  }
}
