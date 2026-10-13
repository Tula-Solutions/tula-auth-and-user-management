import type { TulaClient } from '@tula-tech/core'
import { useTulaContext } from '../context'

/**
 * The `@tula-tech/core` client of the nearest `<TulaProvider>`, for anything the other hooks do not
 * cover.
 *
 * @returns The client.
 * @throws Error outside a `<TulaProvider>`.
 *
 * @example
 * ```tsx
 * const tula = useTula()
 * const config = await tula.config.get()
 * ```
 */
export function useTula(): TulaClient {
  return useTulaContext().client
}
