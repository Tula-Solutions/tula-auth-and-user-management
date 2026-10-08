import type { ReactNode } from 'react'
import { useTulaContext } from '../context'
import { useAuthState } from '../hooks/use-auth-state'

/**
 * Renders its children only while someone is signed in. Nothing while loading or signed out,
 * and nothing during server rendering (the session is only known in the browser).
 *
 * @param props - The children.
 * @returns The children, or nothing.
 *
 * @example
 * ```tsx
 * <SignedIn>
 *   <UserButton />
 * </SignedIn>
 * ```
 */
export function SignedIn(props: { children?: ReactNode }) {
  const state = useAuthState(useTulaContext().client)
  return state.status === 'signed-in' ? props.children : null
}

/**
 * Renders its children only once it is known that nobody is signed in. Nothing while loading,
 * so a signed-in user never sees a flash of the sign-in form.
 *
 * @param props - The children.
 * @returns The children, or nothing.
 *
 * @example
 * ```tsx
 * <SignedOut>
 *   <SignIn />
 * </SignedOut>
 * ```
 */
export function SignedOut(props: { children?: ReactNode }) {
  const state = useAuthState(useTulaContext().client)
  return state.status === 'signed-out' ? props.children : null
}

/**
 * Renders its children while it is not yet known who is signed in: during server rendering,
 * and in the browser until the provider's `load()` has answered.
 *
 * @param props - The children, typically a skeleton or a spinner.
 * @returns The children, or nothing.
 *
 * @example
 * ```tsx
 * <TulaLoading>
 *   <p>Loading…</p>
 * </TulaLoading>
 * ```
 */
export function TulaLoading(props: { children?: ReactNode }) {
  const state = useAuthState(useTulaContext().client)
  return state.status === 'loading' ? props.children : null
}
