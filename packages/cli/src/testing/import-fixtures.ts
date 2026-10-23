import { readFileSync } from 'node:fs'

/**
 * A fixture export of one provider's real format, from `src/import/fixtures/`.
 *
 * @param name - The file's name.
 * @returns Its text.
 */
export function fixture(name: string): string {
  return readFileSync(new URL(`../import/fixtures/${name}`, import.meta.url), 'utf8')
}
