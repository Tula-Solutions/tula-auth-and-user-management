import {
  type ClientConfig,
  evaluatePassword,
  type PasswordCheck,
  type PasswordPolicy,
  type PasswordUserInfo,
} from '@tula/core'
import { useEffect, useMemo, useState } from 'react'
import { useTulaContext } from '../context'

/**
 * The environment's public configuration (app name, sign-in methods, password policy), fetched
 * once per client and shared.
 *
 * @returns The configuration, or `null` until it has arrived (or while the API is unreachable).
 * @throws Error outside a `<TulaProvider>`.
 *
 * @example
 * ```tsx
 * const config = useClientConfig()
 * return <h1>Sign in to {config?.app.name ?? 'your account'}</h1>
 * ```
 */
export function useClientConfig(): ClientConfig | null {
  const { client } = useTulaContext()
  const [config, setConfig] = useState<ClientConfig | null>(null)
  useEffect(() => {
    let current = true
    // Another client is another environment: its predecessor's policy is not shown meanwhile.
    setConfig(null)
    client.config.get().then(
      (loaded) => {
        if (current) {
          setConfig(loaded)
        }
      },
      // Without the policy there is no checklist; the server still enforces it on submit.
      () => undefined
    )
    return () => {
      current = false
    }
  }, [client])
  return config
}

/**
 * What {@link usePasswordChecklist} returns.
 *
 * @example
 * ```ts
 * const { checks, ok }: PasswordChecklist = usePasswordChecklist(password)
 * ```
 */
export interface PasswordChecklist {
  /** The environment's policy, or `null` until it has been fetched. */
  policy: PasswordPolicy | null
  /** Every applicable rule with whether the password meets it; empty until the policy is known. */
  checks: PasswordCheck[]
  /** Whether every rule is met. `false` until the policy is known. */
  ok: boolean
}

/**
 * A live password checklist that agrees with the server: the environment's policy, evaluated
 * by the same function the server runs. (The breached-password check is server-side only and
 * is reported when the password is submitted. So is the password history: where
 * `policy.history` is at least 1, a password that replaces one must not be one of the user's
 * last that many, which only the server can judge. It is not among `checks`; the answer to a
 * reused password is the error `password.reused`.)
 *
 * @param password - What the user has typed so far.
 * @param userInfo - The email and names the password must not contain.
 * @returns The policy, each rule's result, and whether all are met.
 * @throws Error outside a `<TulaProvider>`.
 *
 * @example
 * ```tsx
 * const { checks } = usePasswordChecklist(password, { email })
 * return (
 *   <ul>
 *     {checks.map((check) => (
 *       <li key={check.rule}>{check.passed ? '✓' : '○'} {check.rule}</li>
 *     ))}
 *   </ul>
 * )
 * ```
 */
export function usePasswordChecklist(
  password: string,
  userInfo: PasswordUserInfo = {}
): PasswordChecklist {
  const policy = useClientConfig()?.password ?? null
  const { email, firstName, lastName, username } = userInfo
  return useMemo(() => {
    if (!policy) {
      return { policy: null, checks: [], ok: false }
    }
    const { ok, checks } = evaluatePassword(policy, password, {
      email,
      firstName,
      lastName,
      username,
    })
    return { policy, checks, ok }
  }, [policy, password, email, firstName, lastName, username])
}
