import { useTulaContext } from '../context'
import type { TulaLocalization } from '../localization'

/**
 * The strings the provider uses: {@link EN_LOCALIZATION} with the provider's `localization`
 * overrides merged in, and the error messages of `@tula-tech/core`'s table.
 *
 * A component that draws words takes them from here, never from a literal, so that an app's
 * translation reaches it.
 *
 * @returns The merged table. The same object while the provider's overrides are the same.
 * @throws Error outside a `<TulaProvider>`.
 *
 * @example
 * ```tsx
 * function Title() {
 *   const t = useLocalization()
 *   return <h1>{t.signIn.title}</h1>
 * }
 * ```
 */
export function useLocalization(): TulaLocalization {
  return useTulaContext().localization
}
