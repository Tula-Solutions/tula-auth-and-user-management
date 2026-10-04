import { type ThemeOverrides, themeToCssVariables } from '@tula/contract/theme'
import type { CSSProperties } from 'react'

/**
 * The parts of the components an app can style. Each is rendered with the class
 * `tula-<kebab-name>` and a `data-tula-element="<name>"` attribute, both stable across
 * releases, and takes an extra class name through {@link Appearance.elements}.
 *
 * @example
 * ```ts
 * ELEMENT_NAMES.includes('primaryButton') // true
 * ```
 */
export const ELEMENT_NAMES = [
  'root',
  'card',
  'header',
  'title',
  'subtitle',
  'form',
  'field',
  'label',
  'inputGroup',
  'input',
  'codeInput',
  'passwordToggle',
  'hint',
  'fieldError',
  'error',
  'status',
  'primaryButton',
  'secondaryButton',
  'dangerButton',
  'linkButton',
  'link',
  'spinner',
  'identity',
  'alternatives',
  'waiting',
  'strengthBar',
  'checklist',
  'checklistItem',
  'footer',
  'branding',
  'avatar',
  'badge',
  'userButton',
  'userButtonTrigger',
  'menu',
  'menuHeader',
  'menuItem',
  'dialog',
  'section',
  'sectionTitle',
  'profile',
  'sessionList',
  'sessionItem',
  'modal',
  'qrCode',
  'secret',
  'backupCodes',
  'backupCode',
  'checkbox',
  'oauthButtons',
  'oauthIcon',
  'divider',
  'identityList',
  'identityItem',
] as const

/**
 * The name of a stylable part. See {@link ELEMENT_NAMES}.
 *
 * @example
 * ```ts
 * const name: ElementName = 'card'
 * ```
 */
export type ElementName = (typeof ELEMENT_NAMES)[number]

/**
 * How the components look: theme tokens, the colour scheme, and class names for their parts.
 * Given to `<TulaProvider>` for every component, or to one component to change only that one
 * (the component's values win; class names from both are applied).
 *
 * @example
 * ```tsx
 * <SignIn
 *   appearance={{
 *     theme: { light: { primary: '#0f766e' }, radius: '6px' },
 *     colorScheme: 'light',
 *     elements: { card: 'shadow-none', primaryButton: 'uppercase' },
 *   }}
 * />
 * ```
 */
export interface Appearance {
  /**
   * Theme tokens to change. Applied as CSS custom properties on the component's root.
   *
   * Values are treated as untrusted (a brand colour may come from data a tenant edits): each
   * is checked against a strict grammar for its token's type (`isValidThemeValue` in
   * `@tula/contract/theme`) and one that is not a plain colour, length, font list or shadow is
   * dropped, so the default stays. Nothing here can add a declaration or load a resource.
   */
  theme?: ThemeOverrides
  /**
   * `system` (the default) follows `prefers-color-scheme` and any `data-tula-theme` attribute
   * on an ancestor; `light` and `dark` force one.
   */
  colorScheme?: 'light' | 'dark' | 'system'
  /** An extra class name per part, added after the component's own. */
  elements?: Partial<Record<ElementName, string>>
}

/** The attributes of one rendered part. */
export interface ElementAttributes {
  className: string
  'data-tula-element': ElementName
}

/** Builds the attributes of a part; extra class names are state modifiers such as `tula-is-open`. */
export type ElementProps = (
  name: ElementName,
  ...modifiers: (string | false | undefined)[]
) => ElementAttributes

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

/**
 * Combine the provider's appearance with a component's own. The component's theme tokens and
 * colour scheme win; class names for the same part are both kept.
 *
 * @param base - The provider's appearance.
 * @param override - The component's appearance.
 * @returns The merged appearance.
 */
export function mergeAppearance(
  base: Appearance | undefined,
  override: Appearance | undefined
): Appearance {
  if (!base || !override) {
    return override ?? base ?? {}
  }
  const elements: Partial<Record<ElementName, string>> = { ...base.elements }
  for (const [name, className] of Object.entries(override.elements ?? {}) as [
    ElementName,
    string,
  ][]) {
    elements[name] = [elements[name], className].filter(Boolean).join(' ')
  }
  return {
    theme: {
      ...base.theme,
      ...override.theme,
      light: { ...base.theme?.light, ...override.theme?.light },
      dark: { ...base.theme?.dark, ...override.theme?.dark },
    },
    colorScheme: override.colorScheme ?? base.colorScheme,
    elements,
  }
}

/**
 * @param appearance - The merged appearance.
 * @returns A function that builds the class name and data attribute of a part.
 */
export function elementProps(appearance: Appearance): ElementProps {
  return (name, ...modifiers) => {
    const custom =
      appearance.elements && Object.hasOwn(appearance.elements, name)
        ? appearance.elements[name]
        : ''
    return {
      className: [`tula-${kebab(name)}`, ...modifiers, custom].filter(Boolean).join(' '),
      'data-tula-element': name,
    }
  }
}

/**
 * The attributes a component's root element takes from an appearance: the theme as inline
 * custom properties and, for a forced colour scheme, `data-tula-theme`.
 *
 * @param appearance - The merged appearance.
 * @returns `style` and, when the scheme is forced, `data-tula-theme`.
 */
export function rootAttributes(appearance: Appearance): {
  style?: CSSProperties
  'data-tula-theme'?: 'light' | 'dark'
} {
  const variables = appearance.theme ? themeToCssVariables(appearance.theme) : {}
  const forced = appearance.colorScheme === 'light' || appearance.colorScheme === 'dark'
  return {
    ...(Object.keys(variables).length > 0 && { style: variables as CSSProperties }),
    ...(forced && { 'data-tula-theme': appearance.colorScheme as 'light' | 'dark' }),
  }
}
