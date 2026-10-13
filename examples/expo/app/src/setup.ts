/**
 * What the app starts with: the client, or why there is none.
 *
 * The client refuses a missing or malformed value when it is made, and it is made while the
 * app's first module loads: thrown from there that is a red screen with a stack trace, on
 * the first run of anyone who has not written `.env.local` yet. The app draws a screen that
 * says what to do instead.
 */
export type Setup<Client> =
  | { tula: Client }
  | {
      tula: null
      /** The variables `.env.local` does not set, by name. Never a value. */
      unset: string[]
      /**
       * What the client said of a value it refused, or `null`. Its sentences name the
       * option and never repeat what it was given.
       */
      refused: string | null
    }

/** The two values the app is configured with, as `.env.local` gave them. */
export interface Values {
  /** `EXPO_PUBLIC_TULA_PUBLISHABLE_KEY`. */
  publishableKey: string | undefined
  /** `EXPO_PUBLIC_TULA_API_URL`. */
  baseUrl: string | undefined
}

/**
 * Make the client when both values are there and it takes them, and say what is wrong
 * otherwise. It never throws: this runs while the app's first module loads.
 *
 * It imports nothing, so that the repository can test it without Expo installed.
 *
 * @param values - The publishable key and the API's address, or `undefined` for one not set.
 * @param create - Makes the client; may throw for a value it refuses.
 * @returns The client, or the names of what is not set and what the client said.
 */
export function setUp<Client>(
  values: Values,
  create: (publishableKey: string, baseUrl: string) => Client
): Setup<Client> {
  const { publishableKey, baseUrl } = values
  const unset = [
    ...(publishableKey ? [] : ['EXPO_PUBLIC_TULA_PUBLISHABLE_KEY']),
    ...(baseUrl ? [] : ['EXPO_PUBLIC_TULA_API_URL']),
  ]
  if (!publishableKey || !baseUrl) {
    return { tula: null, unset, refused: null }
  }
  try {
    return { tula: create(publishableKey, baseUrl) }
  } catch (error) {
    // A value that is set and is not what the client takes: an address that is no URL, a
    // secret key where the publishable one belongs.
    return { tula: null, unset, refused: error instanceof Error ? error.message : null }
  }
}
