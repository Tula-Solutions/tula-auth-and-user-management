/**
 * The contract's own data that the native SDKs get as constants: the error codes and the
 * default theme. Both come from the contract's Zod-free modules, the same ones `@tula/core`
 * and the stylesheet generator read.
 */
import { isValidThemeValue, type Theme, type ThemeTokenDefinition } from '@tula/contract/theme'

/** The contract's error codes with what the API answers for each (`ERROR_DEFINITIONS`). */
export type ErrorDefinitions = Readonly<
  Record<string, { readonly status: number; readonly message: string }>
>

/** The contract's theme: its default values and the table that says what each token is. */
export interface ThemeSource {
  readonly theme: Theme
  readonly tokens: readonly ThemeTokenDefinition[]
}

/** A token that has a value per colour scheme. */
export interface SchemeToken {
  readonly key: string
  readonly type: string
  readonly description: string
  readonly light: string
  readonly dark: string
}

/** A token with one value for both schemes. */
export interface SharedToken {
  readonly key: string
  readonly type: string
  readonly description: string
  readonly value: string
}

/** The default theme, token by token, in the contract's order. */
export interface ThemeValues {
  readonly scheme: readonly SchemeToken[]
  readonly shared: readonly SharedToken[]
}

function tokenValue(
  holder: object,
  token: ThemeTokenDefinition,
  where: 'light' | 'dark' | 'shared'
): string {
  const value: unknown = Object.hasOwn(holder, token.key)
    ? (holder as Record<string, unknown>)[token.key]
    : undefined
  // A theme value is untrusted wherever it ends up (ADR 0022): a default that the contract's
  // own grammar refuses is never written into a generated file. The value is not repeated in
  // the error: only where it was.
  if (typeof value !== 'string' || !isValidThemeValue(token.type, value)) {
    throw new Error(`theme token "${token.key}" (${where}) has no value that passes its grammar`)
  }
  return value
}

/**
 * The default theme as the list of tokens the generated constants are written from.
 *
 * Only tokens of the table are returned, each after its value passed `isValidThemeValue` for
 * the token's type: a key of the theme with no token is not written anywhere.
 *
 * @param source - The contract's default theme and its token table.
 * @returns The tokens of each scope with their values.
 * @throws Error for a token with no value, or with one its grammar refuses.
 *
 * @example
 * ```ts
 * themeValues({ theme: DEFAULT_THEME, tokens: THEME_TOKENS }).scheme[0]?.light // '#ffffff'
 * ```
 */
export function themeValues(source: ThemeSource): ThemeValues {
  const scheme: SchemeToken[] = []
  const shared: SharedToken[] = []
  for (const token of source.tokens) {
    const base = { key: token.key, type: token.type, description: token.description }
    if (token.scope === 'scheme') {
      scheme.push({
        ...base,
        light: tokenValue(source.theme.light, token, 'light'),
        dark: tokenValue(source.theme.dark, token, 'dark'),
      })
    } else {
      shared.push({ ...base, value: tokenValue(source.theme, token, 'shared') })
    }
  }
  return { scheme, shared }
}
