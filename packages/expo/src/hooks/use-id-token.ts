import type { IdTokenProvider, TulaClient } from '@tula/core'
import { useEffect, useState } from 'react'
import { useTula } from '../context'
import { hostOf } from '../host'

/**
 * The providers whose native sheet can be shown, as last answered for this client: what
 * was known before until the sheets have been asked again, which happens after every mount
 * and never while rendering.
 *
 * @param client - The client.
 * @returns The providers; empty until a sheet has said it is available.
 */
export function useIdTokenWays(client: TulaClient): readonly IdTokenProvider[] {
  const [known, setKnown] = useState(() => ({
    client,
    ways: hostOf(client)?.idTokenWays() ?? [],
  }))
  useEffect(() => {
    // An effect that waits is restartable: each run drops its own late answer.
    let current = true
    // The host's question never rejects: a sheet that throws or rejects is one that cannot
    // be shown, decided there.
    void hostOf(client)
      ?.askIdTokenWays()
      .then((ways) => {
        if (current) {
          setKnown((before) =>
            before.client === client && before.ways.join() === ways.join()
              ? before
              : { client, ways }
          )
        }
      })
    return () => {
      current = false
    }
  }, [client])
  return known.client === client ? known.ways : []
}

/**
 * What {@link useIdTokenProviders} returns.
 *
 * @example
 * ```ts
 * const { google, apple }: UseIdTokenProvidersResult = useIdTokenProviders()
 * ```
 */
export interface UseIdTokenProvidersResult {
  /** Whether Google's native sheet can be shown: draw the control only where it is `true`. */
  google: boolean
  /** Whether Sign in with Apple's sheet can be shown: draw the control only where it is `true`. */
  apple: boolean
}

/**
 * Which providers' native sign-in sheets this app can show, for deciding which controls to
 * draw. Both are `false` until the sheets have answered, which is after the first render:
 * **a control is hidden until it is known to work**, so that an app in Expo Go, or on a
 * device without the provider's sign-in, never shows a button that can only fail.
 *
 * A sheet is available when the client was created with it (`google`, `apple`), its native
 * module is in the build, and the device has the sign-in (Sign in with Apple needs iOS 13
 * and is not on Android). `useSignIn().withIdToken` asks again before every sign-in.
 *
 * @returns Whether each sheet can be shown.
 * @throws Error outside a `<TulaProvider>`.
 *
 * @example
 * ```tsx
 * function NativeProviders() {
 *   const signIn = useSignIn()
 *   const { google, apple } = useIdTokenProviders()
 *   return (
 *     <View>
 *       {apple && <Button title='Sign in with Apple' onPress={() => signIn.withIdToken({ provider: 'apple' })} />}
 *       {google && <Button title='Sign in with Google' onPress={() => signIn.withIdToken({ provider: 'google' })} />}
 *     </View>
 *   )
 * }
 * ```
 */
export function useIdTokenProviders(): UseIdTokenProvidersResult {
  const ways = useIdTokenWays(useTula())
  return { google: ways.includes('google'), apple: ways.includes('apple') }
}
