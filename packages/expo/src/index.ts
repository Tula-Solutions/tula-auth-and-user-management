/**
 * `@tula-tech/expo`: Tula for an Expo app, headless.
 *
 * `@tula-tech/core`'s client with its refresh token in the device's secure store, a provider and
 * hooks for sign-up, sign-in (a password, a code, an emailed link, a passkey, a provider's
 * page or its own sheet), password reset and the session, bound to a key the device keeps where the app
 * gives a key store. The passkey sheet, the system browser, Google's and Apple's sheets and
 * the key store are entry points of their own (`@tula-tech/expo/passkeys`, `@tula-tech/expo/browser`,
 * `@tula-tech/expo/google`, `@tula-tech/expo/apple`, `@tula-tech/expo/device-key`), so that an app
 * installs a native module only for what it uses; `@tula-tech/expo/plugin` is the config plugin. It draws nothing: the screens
 * are the app's. Everything exported here is the package's public, versioned surface; what an
 * app needs from `@tula-tech/core` beside the client is re-exported, so one import serves a screen.
 */

export {
  type AcceptedInvitation,
  type ActiveOrganization,
  type AuthState,
  type ClientConfig,
  evaluatePassword,
  type FactorEnrolmentResult,
  type FlowStep,
  type Identity,
  type IdTokenProvider,
  type InvitationLink,
  type InvitationPreview,
  isStepUpRequired,
  isTulaError,
  type OAuthProvider,
  type OrganizationInvitation,
  type OrganizationSuggestion,
  type Passkey,
  type PasswordCheck,
  type PasswordEvaluation,
  readInvitationLink,
  type SecondFactorProof,
  type Session,
  stepUpMethods,
  type TotpEnrolment,
  type TulaClient,
  TulaError,
  type TulaFieldError,
  type User,
  type UserOrganization,
  type UserOrganizationList,
} from '@tula-tech/core'
export type { TulaExpoClientOptions } from './client'
export { TulaProvider, type TulaProviderProps, useTula } from './context'
export {
  DEVICE_KEY_ALIAS,
  type DeviceKeyStore,
  type ObtainedDeviceKey,
} from './device-key-store'
export {
  type EmailLinkOutcome,
  isEmailLink,
  openEmailLink,
  requestEmailLink,
} from './email-link'
export {
  type UseAuthResult,
  type UseUserResult,
  useAuth,
  useUser,
} from './hooks/use-auth'
export type { FactorEnrolmentHookActions, FlowState } from './hooks/use-flow'
export {
  type UseResetPasswordResult,
  type UseSignInResult,
  type UseSignUpResult,
  useResetPassword,
  useSignIn,
  useSignUp,
} from './hooks/use-flows'
export { type UseIdTokenProvidersResult, useIdTokenProviders } from './hooks/use-id-token'
export { type UsePasskeysResult, usePasskeys } from './hooks/use-passkeys'
export { type UseSessionResult, useSession } from './hooks/use-session'
export type { BrowserSession, IdTokenCredential, IdTokenSheet, PasskeySheet } from './host'
export {
  ID_TOKEN_SHEET_CEILING_MS,
  type IdTokenOutcome,
  type IdTokenSignInInput,
  idTokenProviders,
  signInWithIdToken,
} from './id-token-sign-in'
export { createTulaExpoClient } from './native'
export {
  linkProvider,
  type ProviderOutcome,
  type ProviderSignInInput,
  retryProviderSignIn,
  signInWithProvider,
} from './provider-sign-in'
export { type FlowScreen, type FlowWays, flowScreen } from './screens'
export {
  type KeychainAccess,
  MAX_SECURE_VALUE_BYTES,
  type Schedule,
  type SecureStorageOptions,
  type SecureStoreLike,
  secureStoreStorage,
} from './secure-storage'
