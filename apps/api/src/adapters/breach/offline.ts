import { COMMON_PASSWORDS } from '@tula/contract'
import type { BreachChecker } from '~/ports/breach-checker'

/**
 * Breach checker for local and dev: matches the bundled common-password list, with no network.
 *
 * Live tiers must use `HibpBreachChecker` (enforced by `env.ts`); this list only catches the most
 * common passwords.
 */
export const offlineBreachChecker: BreachChecker = {
  async check(password) {
    return COMMON_PASSWORDS.has(password.toLowerCase()) ? 'breached' : 'clean'
  },
}
