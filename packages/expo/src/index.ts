/**
 * `@tula/expo`: Tula for an Expo app, headless.
 *
 * `@tula/core`'s client with its refresh token in the device's secure store, a provider and
 * hooks for sign-up, sign-in, password reset and the session. It draws nothing: the screens
 * are the app's. Everything exported here is the package's public, versioned surface; what an
 * app needs from `@tula/core` beside the client is re-exported, so one import serves a screen.
 */

export {
  type AuthState,
  type ClientConfig,
  evaluatePassword,
  type FactorEnrolmentResult,
  type FlowStep,
  isStepUpRequired,
  isTulaError,
  type PasswordCheck,
  type PasswordEvaluation,
  type SecondFactorProof,
  type Session,
  stepUpMethods,
  type TotpEnrolment,
  type TulaClient,
  TulaError,
  type TulaFieldError,
  type User,
} from '@tula/core'
export type { TulaExpoClientOptions } from './client'
export { TulaProvider, type TulaProviderProps, useTula } from './context'
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
export { type UseSessionResult, useSession } from './hooks/use-session'
export { createTulaExpoClient } from './native'
export { type FlowScreen, flowScreen } from './screens'
export {
  type KeychainAccess,
  MAX_SECURE_VALUE_BYTES,
  type SecureStorageOptions,
  type SecureStoreLike,
  secureStoreStorage,
} from './secure-storage'
