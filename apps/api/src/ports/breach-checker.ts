/**
 * Outcome of a breached-password lookup.
 *
 * `unknown` means the source could not be reached; callers decide whether to fail open.
 */
export type BreachStatus = 'breached' | 'clean' | 'unknown'

/** Looks up whether a password appears in known breach corpora. */
export interface BreachChecker {
  /**
   * @param password - The NFC-normalized candidate password. Implementations must never log it
   *   or send it anywhere in recoverable form.
   * @returns Whether it is known to be breached, or `unknown` when the source is unavailable.
   */
  check(password: string): Promise<BreachStatus>
}
