import { useEffect, useState } from 'react'
import { useTulaContext } from '../context'

/**
 * Whether this browser can run a passkey ceremony. A fact about the browser, read after mount:
 * nothing during render touches `navigator`.
 *
 * Hidden until known: draw a passkey control only when this is `true`. `undefined` means "not
 * asked yet", which is not the same as "no": a screen whose only way in is a passkey treats it
 * as "not ruled out" so that it does not open on "not supported" and then change its mind.
 *
 * @returns `undefined` until the component has mounted, then whether WebAuthn is there.
 * @throws Error outside a `<TulaProvider>`.
 *
 * @example
 * ```tsx
 * function PasskeyLink() {
 *   const supported = usePasskeySupport()
 *   return supported === true ? <a href='/passkey'>Use a passkey</a> : null
 * }
 * ```
 */
export function usePasskeySupport(): boolean | undefined {
  const { client } = useTulaContext()
  const [supported, setSupported] = useState<boolean | undefined>(undefined)
  useEffect(() => {
    setSupported(client.signIn.canUsePasskey())
  }, [client])
  return supported
}
