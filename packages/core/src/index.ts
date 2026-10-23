/**
 * `@tula-tech/core`: the headless Tula client.
 *
 * Everything exported here is the package's public, versioned surface. The password rule
 * engine is re-exported from the contract (its Zod-free entry point) so that a live password
 * checklist needs only this package and always agrees with the server.
 */

export {
  type DeviceKey,
  type DevicePublicJwk,
  generateSoftwareDeviceKey,
} from '@tula-tech/contract/device-binding'
export {
  evaluatePassword,
  type PasswordCheck,
  type PasswordEvaluation,
  type PasswordRule,
  type PasswordUserInfo,
} from '@tula-tech/contract/password-rules'
export {
  createClient as createTulaClientWithEnvironment,
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
  type ChannelLike,
  type Environment,
  type LinkStorageLike,
  type LockManagerLike,
  type PageLike,
  runtimeEnvironment,
} from './environment'
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
  IdTokenName,
  IdTokenProvider,
  IdTokenSignIn,
  PasswordResetFlow,
  SecondFactorResult,
  SignInFlow,
  SignUpFlow,
} from './flows'
export { type InvitationLink, readInvitationLink } from './invitation'
export type { Identity, OAuthCallbackOutcome, OAuthProvider } from './oauth'
export { isRetryableOAuthError } from './oauth'
export type {
  PasskeyCreationOptions,
  PasskeyGlobals,
  PasskeyProvider,
  PasskeyRequest,
  PasskeyRequestOptions,
} from './passkey'
export {
  ACCESS_TOKEN_EXPIRY_SKEW_MS,
  MAX_REFRESH_BACKOFF_MS,
  REFRESH_RETRY_WINDOW_MS,
  REFRESH_TIMEOUT_MS,
} from './session'
export { memoryStorage, type TokenStorage } from './storage'
export type { DeviceKeySource } from './transport'
export type {
  AcceptedInvitation,
  ActiveOrganization,
  AssignableRole,
  AssignableRoleList,
  AuthState,
  BackupCodes,
  ClientConfig,
  ClientKind,
  CreateOrganizationInput,
  CreateOrganizationInvitationInput,
  EmailCodeSent,
  FactorEnrolmentMethod,
  Factors,
  FetchLike,
  FirstFactorStrategy,
  FlowKind,
  FlowStep,
  InvitationPreview,
  MfaPolicy,
  OrganizationDomain,
  OrganizationDomainList,
  OrganizationInvitation,
  OrganizationInvitationList,
  OrganizationMember,
  OrganizationMemberList,
  OrganizationSuggestion,
  OrganizationSuggestionList,
  Passkey,
  PasswordPolicy,
  PhoneCodeSent,
  SecondFactorMethod,
  SecondFactorProof,
  Session,
  SmsFactorCode,
  StartOrganizationDomainInput,
  StepUpMethod,
  StepUpPrepared,
  StepUpProof,
  TotpEnrolment,
  UpdateOrganizationInput,
  User,
  UserOrganization,
  UserOrganizationList,
} from './types'
