/**
 * The Tula packages that are built and checked but not released to npm yet. A scaffold tool
 * answers `scaffold.not_released` for a framework that needs one: telling an agent to install
 * a package the registry does not have ends in a failed install, or in somebody else's
 * package of a similar name.
 *
 * It is the repository's list of held-back packages (`HELD_PACKAGES` in
 * `scripts/publish-manifest.ts`), by name, and the same list `create-tula` keeps. This
 * package is published and cannot import either, so it keeps the names itself;
 * `.claude/hooks/release.test.ts` holds the three equal. This module imports nothing.
 *
 * @example
 * ```ts
 * UNRELEASED_TULA_PACKAGES.includes('@tula-tech/expo') // true
 * ```
 */
export const UNRELEASED_TULA_PACKAGES: readonly string[] = [
  '@tula-tech/expo',
  '@tula-tech/expo-screens',
]
