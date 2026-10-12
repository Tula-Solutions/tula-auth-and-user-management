import type { BrowserSession, PasskeySheet } from './host'

// The two native modules this package can wrap, each as far as it is used. The modules are
// arguments here, so both adapters run (and are tested) where neither is installed;
// `passkeys.ts` and `browser.ts` hand in the real ones.

/** `react-native-passkey`'s `Passkey`, as far as the adapter calls it. */
export interface PasskeyModuleLike {
  isSupported(): boolean
  create(request: never): Promise<unknown>
  get(request: never): Promise<unknown>
}

/**
 * The `name` a browser would give each failure `react-native-passkey` reports in the
 * `error` member of what it rejects with. A word that is not here is a failure with no
 * name: `passkey.failed`.
 *
 * Read from the module's tarball, version 3.6.2, and from nothing that ran:
 * `lib/module/PasskeyError.js` has the objects it rejects with (`UserCancelledError`,
 * `InterruptedError`, `TimeoutError`, `CredentialAlreadyExistsError`, `NotSupportedError`)
 * and `mapNativeErrorCode`, which turns a native code into one of them;
 * `lib/module/Passkey.js` throws `NotSupportedError` itself when `isSupported()` is false.
 * The native codes: `ios/PasskeyErrors.swift` (`RNPasskeyErrorType`: `UserCancelled`,
 * `TimedOut`, `CredentialAlreadyExists`, `NotSupported`; it has no `Interrupted`) and
 * `ios/Passkey.swift`, which maps `ASAuthorizationError` to them; and
 * `android/src/main/java/com/reactnativepasskey/PasskeyModule.kt`
 * (`handleRegistrationException`, `handleAuthenticationException`: Credential Manager's
 * cancellation is `UserCancelled`, its interruption `Interrupted`, a DOM
 * `InvalidStateError` `CredentialAlreadyExists`, `TimeoutError` `TimedOut`).
 *
 * **No sheet was dismissed to see which word arrives.** A dismissal that reaches here as
 * another word, or as a native code the module does not map (it then rejects with
 * `{ error: 'Native error' }`), is `passkey.failed`: an error where the user only closed a
 * sheet. `docs/plans/phase-2-unverified.md` has the row.
 */
const FAILURE_NAMES: Readonly<Record<string, string>> = {
  // The user closed the sheet, the system took it away, or nobody answered in time.
  UserCancelled: 'NotAllowedError',
  Interrupted: 'NotAllowedError',
  TimedOut: 'NotAllowedError',
  // `excludeCredentials` matched: this device already holds a passkey of the account.
  CredentialAlreadyExists: 'InvalidStateError',
  NotSupported: 'NotSupportedError',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A rejection that carries a name and nothing else: the module's own message (which can
 * quote a domain or a native error) stops here.
 */
function failure(thrown: unknown): Error {
  const word =
    isRecord(thrown) && Object.hasOwn(thrown, 'error') && typeof thrown.error === 'string'
      ? thrown.error
      : ''
  const name = Object.hasOwn(FAILURE_NAMES, word) ? FAILURE_NAMES[word] : undefined
  return Object.assign(new Error('The passkey request failed.'), { name: name ?? 'UnknownError' })
}

/**
 * The credential as WebAuthn's JSON form has it. The module's own types make `type`
 * optional; a credential is of no other type, so a missing one is filled in. One that says
 * something else is left alone, and refused by the client before it is sent.
 */
function credential(answer: unknown): unknown {
  return isRecord(answer) && answer.type === undefined ? { ...answer, type: 'public-key' } : answer
}

/**
 * A passkey sheet over `react-native-passkey`.
 *
 * @param module - The module's `Passkey`.
 * @returns The sheet `createTulaExpoClient` takes as `passkeys`.
 */
export function passkeySheetOver(module: PasskeyModuleLike): PasskeySheet {
  const ask = async (call: () => Promise<unknown>) => {
    try {
      return credential(await call())
    } catch (thrown) {
      throw failure(thrown)
    }
  }
  return {
    isSupported: () => module.isSupported() === true,
    create: (options) => ask(() => module.create(options as never)),
    get: (options) => ask(() => module.get(options as never)),
  }
}

/** `expo-web-browser`, as far as the adapter calls it. */
export interface WebBrowserModuleLike {
  openAuthSessionAsync(
    url: string,
    redirectUrl?: string | null,
    options?: { preferUniversalLinks?: boolean }
  ): Promise<{ type: string; url?: unknown }>
}

/**
 * A browser session over `expo-web-browser`'s `openAuthSessionAsync`.
 *
 * An `https` redirect URL is asked for as a universal link (`preferUniversalLinks`; iOS
 * 17.4 and later, with the Associated Domains entitlement): without it iOS matches a
 * callback by scheme, and `https` is every site's.
 *
 * @param module - The module.
 * @returns The session `createTulaExpoClient` takes as `browser`.
 */
export function browserSessionOver(module: WebBrowserModuleLike): BrowserSession {
  return {
    async open(authorizationUrl, redirectUrl) {
      const result = await module.openAuthSessionAsync(
        authorizationUrl,
        redirectUrl,
        /^https:/i.test(redirectUrl) ? { preferUniversalLinks: true } : {}
      )
      // `cancel`, `dismiss`, `opened`, `locked`: the browser did not come back with a URL.
      return result.type === 'success' && typeof result.url === 'string' ? result.url : null
    },
  }
}
