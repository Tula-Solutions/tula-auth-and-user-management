'use client'

/**
 * `@tula/react`: a provider, hooks and prebuilt components for Tula Auth.
 *
 * Everything exported here is the package's public, versioned surface. Import the stylesheet
 * once, next to the provider: `import '@tula/react/styles.css'`.
 */
export type { FlowStep, Session, TulaClient, TulaError, User } from '@tula/core'
export {
  type Appearance,
  ELEMENT_NAMES,
  type ElementName,
} from './appearance'
export { SignedIn, SignedOut, TulaLoading } from './components/control'
export type { FlowResult } from './components/flow-screens'
export { SignIn, type SignInProps } from './components/sign-in'
export { SignUp, type SignUpProps } from './components/sign-up'
export type { HeadingLevel } from './components/ui'
export { UserButton, type UserButtonProps } from './components/user-button'
export { UserProfile, type UserProfileProps } from './components/user-profile'
export { TulaProvider, type TulaProviderProps } from './context'
export { type UseAuthResult, useAuth } from './hooks/use-auth'
export type { FlowState } from './hooks/use-flow'
export {
  type PasswordChecklist,
  useClientConfig,
  usePasswordChecklist,
} from './hooks/use-password-checklist'
export { type UseResetPasswordResult, useResetPassword } from './hooks/use-reset-password'
export { type UseSessionResult, useSession } from './hooks/use-session'
export { type UseSignInResult, useSignIn } from './hooks/use-sign-in'
export { type UseSignUpResult, useSignUp } from './hooks/use-sign-up'
export { useTula } from './hooks/use-tula'
export { type UseUserResult, useUser } from './hooks/use-user'
export {
  EN_LOCALIZATION,
  type LocalizationOverrides,
  type TulaLocalization,
} from './localization'
export type { NavigationOptions } from './navigation'
