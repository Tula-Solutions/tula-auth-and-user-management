import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Join class names, letting a later Tailwind utility win over an earlier one.
 *
 * @param inputs - Class names, arrays or conditional maps.
 * @returns One class string.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
