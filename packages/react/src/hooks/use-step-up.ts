import { isStepUpRequired, stepUpMethods } from '@tula/core'
import { useCallback } from 'react'
import { useTulaContext } from '../context'

/**
 * Runs a sensitive action and, when the API answers `auth.step_up_required`, asks the user to
 * prove who they are and runs it again.
 *
 * @example
 * ```ts
 * const withStepUp: WithStepUp = useStepUp()
 * ```
 */
export type WithStepUp = <Result>(action: () => Promise<Result>) => Promise<Result>

/**
 * Wrap a sensitive call (turning two-step verification off, new backup codes, your own
 * `tula.mfa.*` or `tula.user.changePassword` call) so that a step-up is handled for you.
 *
 * The action runs. If the API answers `auth.step_up_required`, the provider opens its step-up
 * dialog with the methods the server named (the authenticator code or a backup code for a
 * user with two-step verification, otherwise the password), sends the proof, and the action
 * runs **once** more. If the user closes the dialog, or has no way to step up, the original
 * error is thrown: check it with `isStepUpRequired` and show nothing, since the user chose.
 *
 * Nothing is prompted unless the server asks: the components hold no rule about which
 * actions are sensitive.
 *
 * @returns A function that runs an action with step-up handled.
 * @throws Error outside a `<TulaProvider>`.
 *
 * @example
 * ```tsx
 * function NewCodesButton() {
 *   const tula = useTula()
 *   const withStepUp = useStepUp()
 *   const [codes, setCodes] = useState<string[] | null>(null)
 *   const renew = async () => {
 *     try {
 *       setCodes((await withStepUp(() => tula.mfa.regenerateBackupCodes())).codes)
 *     } catch (error) {
 *       if (!isStepUpRequired(error)) throw error // the user closed the dialog otherwise
 *     }
 *   }
 *   return codes ? <CodeList codes={codes} /> : <button onClick={renew}>New backup codes</button>
 * }
 * ```
 */
export function useStepUp(): WithStepUp {
  const { prompts } = useTulaContext()
  return useCallback(
    async <Result>(action: () => Promise<Result>): Promise<Result> => {
      try {
        return await action()
      } catch (error) {
        if (!isStepUpRequired(error) || !(await prompts.stepUp(stepUpMethods(error)))) {
          throw error
        }
        return action()
      }
    },
    [prompts]
  )
}
