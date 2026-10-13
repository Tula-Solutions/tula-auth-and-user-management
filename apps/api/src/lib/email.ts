import { isTestAddress } from '@tula/contract'
import { z } from 'zod'

const EmailSchema = z.email().max(320)

/** Printable ASCII with no space: the only characters an address Tula accepts may contain. */
const ASCII_ADDRESS = /^[\x21-\x7e]+$/

/**
 * Normalize an email for lookups and uniqueness: trimmed, with the ASCII letters lowercased.
 *
 * Only `A` to `Z` are folded. `String.prototype.toLowerCase` also maps some non-ASCII
 * characters to ASCII ones (U+212A KELVIN SIGN becomes `k`), which would make a look-alike
 * address equal to somebody else's mailbox; such a character is left as it is, so it matches no
 * stored address ({@link parseEmail} refuses it outright).
 *
 * Deliberately nothing provider-specific (no stripping `+tags` or dots): those rules differ per
 * provider and would merge addresses their owners consider distinct.
 *
 * @param email - The email as entered.
 * @returns The normalized email.
 */
export function normalizeEmail(email: string): string {
  return email.trim().replace(/[A-Z]+/g, (letters) => letters.toLowerCase())
}

/**
 * Mask an email for display and logs, e.g. `m***@northline.app`.
 *
 * The mask has a fixed width so it does not reveal the length of the local part.
 *
 * @param email - The email to mask.
 * @returns The masked email, or `***` when it has no local part or domain.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at < 1 || at === email.length - 1) {
    return '***'
  }
  return `${email[0]}***${email.slice(at)}`
}

/**
 * Validate an email as entered and return both forms the system stores.
 *
 * **The address is validated as it was written, before any case folding, and must be ASCII.**
 * Validating the folded form would accept characters that only become valid by folding
 * (U+212A KELVIN SIGN lowercases to `k`), so an address a provider vouches for could equal an
 * existing ASCII mailbox it is not. The rule is therefore: printable ASCII only, in the local
 * part and the domain. That refuses fullwidth and other compatibility forms, combining marks,
 * internationalised local parts (which were never accepted) and an IDN domain written in
 * Unicode; an IDN domain is accepted in its punycode form (`xn--…`). Folding the case of an
 * ASCII string cannot produce a character that was not validated.
 *
 * **An address of the reserved test domain is not a valid address** (`isTestAddress`, ADR
 * 0058): it is what a sign-in test's throwaway user holds, and no person may sign up with
 * one, be created with one, be reported by a provider with one or ask for mail at one. The
 * refusal is the one a malformed address gets, decided from the address alone. Only the
 * test's own run, which holds a {@link TestAddressPermit}, is given one.
 *
 * @param input - The email as the user typed it, or as a provider reported it.
 * @param permit - A sign-in test's permit; anything else is none.
 * @returns The trimmed email and its normalized form, or `null` when it is not a valid address.
 *
 * @example
 * ```ts
 * parseEmail(' Maya@Northline.app ') // { email: 'Maya@Northline.app', normalized: 'maya@northline.app' }
 * parseEmail('Kelvin@northline.app') // null: the Kelvin sign is not a "k"
 * ```
 */
export function parseEmail(
  input: string,
  permit?: TestAddressPermit
): { email: string; normalized: string } | null {
  const email = input.trim()
  if (!ASCII_ADDRESS.test(email) || !EmailSchema.safeParse(email).success) {
    return null
  }
  if (isTestAddress(email) && !isPermit(permit)) {
    return null
  }
  return { email, normalized: normalizeEmail(email) }
}

/**
 * The key of a {@link TestAddressPermit}. **Not exported, on purpose**: a value keyed by it
 * can only be made in this module, so nothing a request carries and no object literal
 * anywhere else is one. It is not taken from the global symbol registry, which would hand
 * it to anyone.
 */
const TEST_ADDRESS_PERMIT: unique symbol = Symbol('test address permit')

/**
 * What lets {@link parseEmail} take an address of the reserved test domain (ADR 0058): the
 * sign-in test's own run, and nothing else. It has no field a caller can write or read.
 */
export interface TestAddressPermit {
  readonly [TEST_ADDRESS_PERMIT]: true
}

/**
 * Make a {@link TestAddressPermit}. **The one caller is the sign-in test's service**
 * (`~/modules/sign-in-test/service`), for the throwaway user of its own run:
 * `lib/email.test.ts` fails if any other file of the server names this function.
 *
 * @returns The permit, to put in a run's `ClientContext`.
 */
export function testAddressPermit(): TestAddressPermit {
  return Object.freeze({ [TEST_ADDRESS_PERMIT]: true as const })
}

/** Whether a value is a permit this module made: the key itself, as an own property. */
function isPermit(value: unknown): value is TestAddressPermit {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, TEST_ADDRESS_PERMIT)
}
