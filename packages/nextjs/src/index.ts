'use client'

/**
 * `@tula/nextjs`: the client half. A provider for the App Router and every `@tula/react`
 * component and hook, marked as Client Components so that a Server Component can import them
 * directly. The server half is `@tula/nextjs/server`, the request interceptor
 * `@tula/nextjs/middleware`, and the route handler `@tula/nextjs/handlers`.
 *
 * Import the stylesheet once, next to the provider: `import '@tula/react/styles.css'`.
 */
export type { FlowStep, Session, TulaClient, TulaError, User } from '@tula/core'
export {
  type Appearance,
  ELEMENT_NAMES,
  type ElementName,
  EmailLinkCallback,
  type EmailLinkCallbackProps,
  type EmailLinkStatus,
  EN_LOCALIZATION,
  type FactorEnrolmentHookActions,
  type FlowResult,
  type FlowState,
  type HeadingLevel,
  type LocalizationOverrides,
  type NavigationOptions,
  OAuthCallback,
  type OAuthCallbackProps,
  type OAuthCallbackStatus,
  type PasswordChecklist,
  SignedIn,
  SignedOut,
  SignIn,
  type SignInProps,
  SignUp,
  type SignUpProps,
  TulaLoading,
  type TulaLocalization,
  type UseAuthResult,
  type UseEmailLinkCallbackResult,
  type UseOAuthCallbackResult,
  type UseResetPasswordResult,
  UserButton,
  type UserButtonProps,
  UserProfile,
  type UserProfileProps,
  type UseSessionResult,
  type UseSignInResult,
  type UseSignUpResult,
  type UseUserResult,
  useAuth,
  useClientConfig,
  useEmailLinkCallback,
  useOAuthCallback,
  usePasswordChecklist,
  useResetPassword,
  useSession,
  useSignIn,
  useSignUp,
  useStepUp,
  useTula,
  useUser,
  type WithStepUp,
} from '@tula/react'
export { DEFAULT_HANDLER_PATH } from './paths'
export { type InitialAuthState, TulaProvider, type TulaProviderProps } from './provider'
