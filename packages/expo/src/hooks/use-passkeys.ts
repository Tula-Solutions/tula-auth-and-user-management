import { isTulaError, type Passkey, type TulaError } from '@tula/core'
import { useCallback, useRef, useState } from 'react'
import { useTula } from '../context'
import { toTulaError } from '../errors'
import { requireFreeSheet, waysOf } from '../host'

/**
 * What {@link usePasskeys} returns.
 *
 * @example
 * ```ts
 * const { supported, add }: UsePasskeysResult = usePasskeys()
 * ```
 */
export interface UsePasskeysResult {
  /**
   * Whether a passkey can be asked for here: the client was created with `passkeys` and the
   * device has them. Leave the passkey controls out where it is `false`.
   */
  supported: boolean
  /** Whether the passkey sheet is open or its answer is being sent. */
  isPending: boolean
  /** Why the last action failed, or `null`. A dismissed sheet is not a failure. */
  error: TulaError | null
  /**
   * Whether the user dismissed the passkey sheet of the last action. Nothing was added or
   * proven, and the action works again.
   */
  dismissed: boolean
  /**
   * Make a passkey on this device and save it to the signed-in account. Needs a recent
   * authentication (`auth.step_up_required` in `error` otherwise).
   *
   * @param input - An optional name for the passkey.
   * @returns The saved passkey, or `null` when it failed or the sheet was dismissed.
   */
  add(input?: { name?: string }): Promise<Passkey | null>
  /**
   * Prove a recent authentication with a passkey of the account (after
   * `auth.step_up_required` whose methods include `passkey`).
   *
   * @returns Whether it was proven.
   */
  stepUp(): Promise<boolean>
  /** Forget the error and the dismissal. */
  clearError(): void
}

/**
 * The signed-in user's passkeys on this device: add one, and step up with one. Listing,
 * renaming and removing need no sheet and are `useTula().user.passkeys`.
 *
 * One passkey request runs at a time. An action started while this hook's own is under
 * way resolves at once with nothing done; one started while a sheet some other part of the
 * app opened is still out fails with `flow.busy`, before any request (an error: nobody
 * dismissed anything). A dismissed sheet sets `dismissed`, never `error`, and so does a
 * sheet nobody answered within five minutes, after which the action works again.
 * What the sheet returns is sent and kept nowhere.
 *
 * @returns Whether passkeys can be used, and the two actions.
 * @throws Error outside a `<TulaProvider>`.
 *
 * @example
 * ```tsx
 * function AddPasskey() {
 *   const passkeys = usePasskeys()
 *   if (!passkeys.supported) {
 *     return null
 *   }
 *   return (
 *     <View>
 *       <Button title='Add a passkey' disabled={passkeys.isPending} onPress={() => passkeys.add()} />
 *       {passkeys.error && <Text>{passkeys.error.message}</Text>}
 *     </View>
 *   )
 * }
 * ```
 */
export function usePasskeys(): UsePasskeysResult {
  const client = useTula()
  const [isPending, setPending] = useState(false)
  const [error, setError] = useState<TulaError | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const busy = useRef(false)

  const run = useCallback(
    async <T>(work: () => Promise<T>): Promise<T | null> => {
      if (busy.current) {
        return null
      }
      /** The session the client has right now, read when asked (not from a render). */
      const session = () => (client.state.status === 'signed-in' ? client.state.sessionId : null)
      const startedFor = session()
      busy.current = true
      setPending(true)
      setError(null)
      setDismissed(false)
      try {
        // A sheet another part of the app opened is still out: said as busy, before any
        // request, never as a sheet this user dismissed.
        requireFreeSheet(client)
        const result = await work()
        // An answer for a session that has ended meanwhile is nobody's here.
        return session() === startedFor ? result : null
      } catch (caught) {
        if (session() === startedFor) {
          if (isTulaError(caught) && caught.code === 'passkey.cancelled') {
            setDismissed(true)
          } else {
            setError(toTulaError(caught))
          }
        }
        return null
      } finally {
        busy.current = false
        setPending(false)
      }
    },
    [client]
  )

  const add = useCallback(
    (input: { name?: string } = {}) => run(() => client.user.passkeys.add(input)),
    [client, run]
  )
  const stepUp = useCallback(
    async () =>
      (await run(async () => {
        await client.session.stepUpWithPasskey()
        return true
      })) === true,
    [client, run]
  )
  const clearError = useCallback(() => {
    setError(null)
    setDismissed(false)
  }, [])

  return { supported: waysOf(client).passkey, isPending, error, dismissed, add, stepUp, clearError }
}
