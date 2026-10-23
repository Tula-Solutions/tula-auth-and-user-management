'use client'

/**
 * `@tula-tech/react`: a provider, hooks and prebuilt components for Tula Auth.
 *
 * Everything exported here is the package's public, versioned surface. Import the stylesheet
 * once, next to the provider: `import '@tula-tech/react/styles.css'`.
 */
export type { OrganizationCheck } from '@tula-tech/contract/custom-claims'
export type {
  ActiveOrganization,
  CreateOrganizationInput,
  FlowStep,
  Session,
  TulaClient,
  TulaError,
  User,
  UserOrganization,
} from '@tula-tech/core'
export {
  type Appearance,
  ELEMENT_NAMES,
  type ElementName,
} from './appearance'
export { SignedIn, SignedOut, TulaLoading } from './components/control'
export { EmailLinkCallback, type EmailLinkCallbackProps } from './components/email-link-callback'
export {
  type FirstFactorCapabilities,
  type FirstFactorFormProps,
  type FirstFactorForms,
  firstFactorStrategies,
} from './components/first-factor-forms'
export type { FlowResult } from './components/flow-screens'
export { formatDuration, type PlacedErrors, rateLimitedAlert } from './components/form-errors'
export { OAuthCallback, type OAuthCallbackProps } from './components/oauth'
export { SignIn, type SignInProps } from './components/sign-in'
export { SignUp, type SignUpProps } from './components/sign-up'
export {
  type StepOf,
  StepRenderer,
  type StepRendererProps,
  type StepScreens,
  type StepStatus,
} from './components/step-renderer'
export { type HeadingLevel, useScreenChanged } from './components/ui'
export { UserButton, type UserButtonProps } from './components/user-button'
export { UserProfile, type UserProfileProps } from './components/user-profile'
export { TulaProvider, type TulaProviderProps } from './context'
export { type UseAuthResult, useAuth } from './hooks/use-auth'
export { useCountdown, useRetryCountdown } from './hooks/use-countdown'
export {
  type EmailLinkStatus,
  type UseEmailLinkCallbackResult,
  useEmailLinkCallback,
} from './hooks/use-email-link-callback'
export { useFieldErrors } from './hooks/use-field-errors'
export type { FactorEnrolmentHookActions, FlowState } from './hooks/use-flow'
export { useLocalization } from './hooks/use-localization'
export {
  type OAuthCallbackStatus,
  type UseOAuthCallbackResult,
  useOAuthCallback,
} from './hooks/use-oauth-callback'
export {
  type UseOrganizationListResult,
  type UseOrganizationResult,
  useOrganization,
  useOrganizationList,
} from './hooks/use-organization'
export { usePasskeySupport } from './hooks/use-passkey-support'
export {
  type PasswordChecklist,
  useClientConfig,
  usePasswordChecklist,
} from './hooks/use-password-checklist'
export { type UseResetPasswordResult, useResetPassword } from './hooks/use-reset-password'
export { type UseSessionResult, useSession } from './hooks/use-session'
export { type UseSignInResult, useSignIn } from './hooks/use-sign-in'
export { type UseSignUpResult, useSignUp } from './hooks/use-sign-up'
export { useStepUp, type WithStepUp } from './hooks/use-step-up'
export { useTula } from './hooks/use-tula'
export { type UseUserResult, useUser } from './hooks/use-user'
export {
  EN_LOCALIZATION,
  formatText,
  type LocalizationOverrides,
  type TulaLocalization,
} from './localization'
export type { NavigationOptions } from './navigation'
