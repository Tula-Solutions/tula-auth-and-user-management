/**
 * The test double of shadcn's `cn` (`@/lib/utils` in an app): joins class names. It does not
 * merge conflicting Tailwind classes; the tests assert on behaviour, never on classes.
 */
export function cn(...inputs: Array<string | false | null | undefined>): string {
  return inputs.filter(Boolean).join(' ')
}
