/**
 * `@tula/core`: the headless Tula client.
 *
 * Everything exported here is the package's public, versioned surface. The password rule
 * engine is re-exported from the contract (its Zod-free entry point) so that a live password
 * checklist needs only this package and always agrees with the server.
 */

export {
  type DeviceKey,
  type DevicePublicJwk,
  generateSoftwareDeviceKey,
} from '@tula/contract/device-binding'
export {
  evaluatePassword,
  type PasswordCheck,
  type PasswordEvaluation,
  type PasswordRule,
  type PasswordUserInfo,
} from '@tula/contract/password-rules'
export {
  createTulaClient,
  DEFAULT_TIMEOUT_MS,
  type TulaClient,
  type TulaClientOptions,
} from './client'
export {
  EMAIL_LINK_POLL_INTERVAL_MS,
  EMAIL_LINK_SESSION_WAIT_MS,
  type EmailLinkOutcome,
} from './email-link'
export {
  type ClientErrorCode,
  EN_MESSAGES,
  type ErrorParams,
  formatMessage,
  isStepUpRequired,
  isTulaError,
  type Messages,
  stepUpMethods,
  TulaError,
  type TulaErrorCode,
  type TulaErrorInit,
  type TulaFieldError,
} from './errors'
export type {
  FactorEnrolmentResult,
  FlowSnapshot,
  IdTokenProvider,
  IdTokenSignIn,
  PasswordResetFlow,
  SecondFactorResult,
  SignInFlow,
  SignUpFlow,
} from './flows'
export type { Identity, OAuthCallbackOutcome, OAuthProvider } from './oauth'
export { isRetryableOAuthError } from './oauth'
export type { PasskeyRequest } from './passkey'
export {
  ACCESS_TOKEN_EXPIRY_SKEW_MS,
  MAX_REFRESH_BACKOFF_MS,
  REFRESH_RETRY_WINDOW_MS,
  REFRESH_TIMEOUT_MS,
} from './session'
export { memoryStorage, type TokenStorage } from './storage'
export type {
  AuthState,
  BackupCodes,
  ClientConfig,
  ClientKind,
  FactorEnrolmentMethod,
  Factors,
  FetchLike,
  FirstFactorStrategy,
  FlowKind,
  FlowStep,
  MfaPolicy,
  Passkey,
  PasswordPolicy,
  PhoneCodeSent,
  SecondFactorMethod,
  SecondFactorProof,
  Session,
  SmsFactorCode,
  StepUpMethod,
  StepUpPrepared,
  StepUpProof,
  TotpEnrolment,
  User,
} from './types'
