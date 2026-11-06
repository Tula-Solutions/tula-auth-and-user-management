import { contrastRatio, DEFAULT_THEME, type ThemeOverrides } from '@tula-tech/contract/theme'
import {
  DEFAULT_SANDBOX_SETTINGS,
  SANDBOX_PROVIDERS,
  type SandboxMfaPolicy,
  type SandboxProvider,
  type SandboxSettings,
} from './sandbox'

// What a visitor can change in the playground, and how each choice becomes the three things
// the page shows: the sandbox environment (its settings), the component's `appearance`, and
// the code to copy. One object, so the live component and the copied code cannot disagree.

/** The component the frame shows. Resetting a password is reached from "Forgot password?". */
export type Screen =
  | 'sign-in'
  | 'sign-up'
  | 'account'
  | 'organization-switcher'
  | 'create-organization'
  | 'organization-profile'

/** The screens that need organizations switched on, and a signed-in user. */
export const ORGANIZATION_SCREENS: readonly Screen[] = [
  'organization-switcher',
  'create-organization',
  'organization-profile',
]

/** Whether a screen is one of the organization components. */
export function isOrganizationScreen(screen: Screen): boolean {
  return ORGANIZATION_SCREENS.includes(screen)
}

/** How tightly the component is spaced. */
export type Density = 'compact' | 'comfortable' | 'spacious'

/** The typeface choices. `system` is the component's default. */
export type FontChoice = 'system' | 'serif' | 'rounded' | 'mono'

/** The colour scheme the frame is shown in. */
export type Scheme = 'light' | 'dark'

/** The width of the frame: a phone or the page. */
export type Device = 'phone' | 'page'

/** Everything the panel edits. */
export interface PlaygroundConfig {
  screen: Screen
  /** The sandbox environment's settings. */
  settings: SandboxSettings
  /** The brand colour (`#rrggbb`); the hover and text colours follow from it. */
  primary: string
  /** The colour of links and the focus ring (`#rrggbb`). */
  accent: string
  /** Corner radius of cards, fields and buttons, in pixels. */
  radius: number
  font: FontChoice
  density: Density
  /** Whether the card drops its shadow. */
  flat: boolean
  scheme: Scheme
  device: Device
}

/** The default look, which is the component's own: no override at all. */
export const DEFAULT_LOOK = {
  primary: DEFAULT_THEME.light.primary,
  accent: DEFAULT_THEME.light.link,
  radius: 10,
  font: 'system' as FontChoice,
  density: 'comfortable' as Density,
  flat: false,
}

/** The starting configuration of the full playground page. */
export const DEFAULT_CONFIG: PlaygroundConfig = {
  screen: 'sign-in',
  settings: {
    ...DEFAULT_SANDBOX_SETTINGS,
    methods: { password: true, emailCode: true, emailLink: false, passkey: false },
  },
  ...DEFAULT_LOOK,
  scheme: 'light',
  device: 'page',
}

/**
 * Make a configuration obey the rules the real settings schema has, so that what the frame
 * shows and what the copied `tula.config.ts` says can both be applied to a real environment:
 * a link needs the emailed code, a sign-up with no password needs the emailed code, and at
 * least one way in must stay on.
 *
 * @param config - A configuration as the panel produced it.
 * @returns The same configuration with those rules applied.
 */
export function normalize(config: PlaygroundConfig): PlaygroundConfig {
  const methods = { ...config.settings.methods }
  if (methods.emailLink) {
    methods.emailCode = true
  }
  let signUpPassword = config.settings.signUpPassword
  if (signUpPassword === 'optional') {
    methods.emailCode = true
  }
  const oauth = SANDBOX_PROVIDERS.filter((provider) => config.settings.oauth.includes(provider))
  if (
    !(methods.password || methods.emailCode || methods.emailLink || methods.passkey) &&
    !oauth.length
  ) {
    methods.password = true
  }
  if (!methods.emailCode) {
    signUpPassword = 'required'
  }
  return { ...config, settings: { ...config.settings, methods, oauth, signUpPassword } }
}

/** Whether the sign-up can be made passwordless: it needs the emailed code. */
export function canBePasswordless(config: PlaygroundConfig): boolean {
  return config.settings.methods.emailCode
}

/** Switch a first-factor method on or off, keeping the rules of {@link normalize}. */
export function setMethod(
  config: PlaygroundConfig,
  method: keyof SandboxSettings['methods'],
  on: boolean
): PlaygroundConfig {
  const methods = { ...config.settings.methods, [method]: on }
  if (method === 'emailCode' && !on) {
    methods.emailLink = false
  }
  const signUpPassword = method === 'emailCode' && !on ? 'required' : config.settings.signUpPassword
  return normalize({ ...config, settings: { ...config.settings, methods, signUpPassword } })
}

/** Switch an OAuth provider on or off. */
export function setProvider(
  config: PlaygroundConfig,
  provider: SandboxProvider,
  on: boolean
): PlaygroundConfig {
  const oauth = on
    ? [...config.settings.oauth, provider]
    : config.settings.oauth.filter((one) => one !== provider)
  return normalize({ ...config, settings: { ...config.settings, oauth } })
}

/**
 * Switch organizations on or off. Switching them off while an organization component is shown
 * goes back to the sign-in screen: those components render nothing without them.
 */
export function setOrganizations(config: PlaygroundConfig, on: boolean): PlaygroundConfig {
  const screen = !on && isOrganizationScreen(config.screen) ? 'sign-in' : config.screen
  return { ...config, screen, settings: { ...config.settings, organizations: on } }
}

/** Set the two-step verification policy. */
export function setMfaPolicy(
  config: PlaygroundConfig,
  mfaPolicy: SandboxMfaPolicy
): PlaygroundConfig {
  return { ...config, settings: { ...config.settings, mfaPolicy } }
}

// Colour arithmetic -------------------------------------------------------------------------

function toRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function toHex([red, green, blue]: [number, number, number]): string {
  const part = (channel: number) =>
    Math.max(0, Math.min(255, Math.round(channel)))
      .toString(16)
      .padStart(2, '0')
  return `#${part(red)}${part(green)}${part(blue)}`
}

/**
 * Mix two `#rrggbb` colours.
 *
 * @param from - The colour at 0.
 * @param to - The colour at 1.
 * @param amount - How far towards `to`, from 0 to 1.
 * @returns The mixed colour.
 */
export function mix(from: string, to: string, amount: number): string {
  const a = toRgb(from)
  const b = toRgb(to)
  return toHex([
    a[0] + (b[0] - a[0]) * amount,
    a[1] + (b[1] - a[1]) * amount,
    a[2] + (b[2] - a[2]) * amount,
  ])
}

/** Whether a string is a `#rrggbb` colour. */
export function isHex(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value)
}

/**
 * The text colour that reads on a given background: the darker or the lighter of the two
 * default text colours, whichever has more contrast.
 *
 * @param background - A `#rrggbb` colour.
 * @returns A `#rrggbb` text colour.
 */
export function readableOn(background: string): string {
  const light = DEFAULT_THEME.light.primaryText
  const dark = DEFAULT_THEME.dark.primaryText
  return contrastRatio(light, background) >= contrastRatio(dark, background) ? light : dark
}

/**
 * The contrast of the text on the brand colour, to warn about a choice that is hard to read.
 *
 * @param config - The configuration.
 * @returns The WCAG contrast ratio of the button text on the button.
 */
export function buttonContrast(config: PlaygroundConfig): number {
  return contrastRatio(readableOn(config.primary), config.primary)
}

const FONTS: Record<Exclude<FontChoice, 'system'>, string> = {
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", serif',
  rounded: 'ui-rounded, "SF Pro Rounded", "Hiragino Maru Gothic ProN", system-ui, sans-serif',
  mono: DEFAULT_THEME.fontFamilyMono,
}

/**
 * The theme tokens that differ from the component's defaults: the `appearance.theme` the live
 * component gets and the code the visitor copies. A token left at its default is left out, so
 * the copied code is as short as the choice.
 *
 * @param config - The configuration.
 * @returns Only the tokens that changed.
 */
export function themeOverrides(config: PlaygroundConfig): ThemeOverrides {
  const light: Record<string, string> = {}
  const dark: Record<string, string> = {}
  const theme: ThemeOverrides = {}
  const primary = config.primary.toLowerCase()
  if (primary !== DEFAULT_LOOK.primary) {
    light.primary = primary
    light.primaryHover = mix(primary, '#000000', 0.2)
    light.primaryText = readableOn(primary)
    const lifted = mix(primary, '#ffffff', 0.45)
    dark.primary = lifted
    dark.primaryHover = mix(primary, '#ffffff', 0.6)
    dark.primaryText = readableOn(lifted)
  }
  const accent = config.accent.toLowerCase()
  if (accent !== DEFAULT_LOOK.accent) {
    light.link = accent
    light.focus = accent
    const lifted = mix(accent, '#ffffff', 0.45)
    dark.link = lifted
    dark.focus = lifted
  }
  if (config.flat) {
    light.shadow = 'none'
    dark.shadow = 'none'
  }
  if (Object.keys(light).length) {
    theme.light = light
  }
  if (Object.keys(dark).length) {
    theme.dark = dark
  }
  if (config.radius !== DEFAULT_LOOK.radius) {
    theme.radius = `${config.radius}px`
    theme.radiusSmall = `${Math.max(2, Math.round(config.radius * 0.6))}px`
  }
  if (config.font !== 'system') {
    theme.fontFamily = FONTS[config.font]
  }
  if (config.density === 'compact') {
    theme.spacing = '0.8125rem'
    theme.fontSize = '0.875rem'
  } else if (config.density === 'spacious') {
    theme.spacing = '1.25rem'
    theme.fontSize = '1rem'
  }
  return theme
}

/** A named look: a starting point for the colour, shape and type controls. */
export interface LookPreset {
  id: string
  label: string
  look: Pick<PlaygroundConfig, 'primary' | 'accent' | 'radius' | 'font' | 'density' | 'flat'>
}

/** The looks the panel offers. Each keeps the contrast the component's own theme keeps. */
export const LOOK_PRESETS: readonly LookPreset[] = [
  { id: 'tula', label: 'Tula', look: { ...DEFAULT_LOOK } },
  {
    id: 'indigo',
    label: 'Indigo',
    look: { ...DEFAULT_LOOK, primary: '#4f46e5', accent: '#4f46e5', radius: 12 },
  },
  {
    id: 'forest',
    label: 'Forest',
    look: { ...DEFAULT_LOOK, primary: '#0f766e', accent: '#0f766e', radius: 8, font: 'rounded' },
  },
  {
    id: 'rose',
    label: 'Rose',
    look: { ...DEFAULT_LOOK, primary: '#be123c', accent: '#be123c', radius: 18, font: 'serif' },
  },
  {
    id: 'terminal',
    label: 'Terminal',
    look: { ...DEFAULT_LOOK, radius: 2, font: 'mono', density: 'compact', flat: true },
  },
]

/** The id of the look preset a configuration matches exactly, or `null` for a custom one. */
export function matchingLook(config: PlaygroundConfig): string | null {
  const found = LOOK_PRESETS.find((preset) =>
    (Object.keys(preset.look) as (keyof LookPreset['look'])[]).every(
      (key) => String(preset.look[key]).toLowerCase() === String(config[key]).toLowerCase()
    )
  )
  return found?.id ?? null
}

/** The groups of controls a page may show. */
export type Panel = 'screen' | 'methods' | 'providers' | 'mfa' | 'organizations' | 'look'

/** A preset of an embedded playground: the starting configuration and the controls it shows. */
export interface EmbedPreset {
  id: string
  config: PlaygroundConfig
  panels: readonly Panel[]
  /** What to try, as a short list shown under the frame. */
  tryIt: readonly string[]
}

function preset(
  id: string,
  settings: Partial<SandboxSettings['methods']>,
  rest: {
    oauth?: SandboxProvider[]
    mfaPolicy?: SandboxMfaPolicy
    organizations?: boolean
    screen?: Screen
    panels: readonly Panel[]
    tryIt: readonly string[]
  }
): EmbedPreset {
  const config = normalize({
    ...DEFAULT_CONFIG,
    screen: rest.screen ?? 'sign-in',
    settings: {
      ...DEFAULT_SANDBOX_SETTINGS,
      methods: { password: false, emailCode: false, emailLink: false, passkey: false, ...settings },
      oauth: rest.oauth ?? [],
      mfaPolicy: rest.mfaPolicy ?? 'optional',
      organizations: rest.organizations ?? false,
    },
  })
  return { id, config, panels: rest.panels, tryIt: rest.tryIt }
}

/** The presets pages name in `:::playground{preset="…"}`. */
export const EMBED_PRESETS: Readonly<Record<string, EmbedPreset>> = {
  full: {
    id: 'full',
    config: DEFAULT_CONFIG,
    panels: ['screen', 'methods', 'providers', 'mfa', 'look'],
    tryIt: [
      'Sign in as ada@example.test with Sandbox-pass-42! , or try a wrong password.',
      'Switch on the emailed link and read it in the inbox.',
      'Turn two-step verification to required and sign in again.',
    ],
  },
  password: preset(
    'password',
    { password: true },
    {
      panels: ['screen', 'look'],
      tryIt: [
        'Sign in as ada@example.test with Sandbox-pass-42!.',
        'Enter a wrong password; the error is the same for any account.',
        'Press Forgot password and read the code in the inbox.',
      ],
    }
  ),
  'email-code': preset(
    'email-code',
    { emailCode: true },
    {
      panels: ['screen', 'look'],
      tryIt: [
        'Ask for a code for ada@example.test and read it in the inbox.',
        'Type a wrong code, then expire the real one from the inbox.',
        'Ask for a code for an address with no account: the screen is the same.',
      ],
    }
  ),
  'email-link': preset(
    'email-link',
    { emailCode: true, emailLink: true },
    {
      panels: ['screen', 'look'],
      tryIt: [
        'Ask for a link for ada@example.test and open it from the inbox.',
        'Open it in another browser instead: it proves nothing there.',
      ],
    }
  ),
  oauth: preset(
    'oauth',
    { password: true },
    {
      oauth: ['google', 'github'],
      panels: ['screen', 'providers', 'look'],
      tryIt: [
        'Continue with a provider, then approve on the sandbox consent screen.',
        'Decline on the consent screen to see the error screen.',
      ],
    }
  ),
  passkey: preset(
    'passkey',
    { password: true, passkey: true },
    {
      panels: ['screen', 'look'],
      tryIt: [
        'Sign in with the password, open Account and add a passkey.',
        'Sign out and sign in with the passkey. The authenticator is simulated.',
      ],
    }
  ),
  mfa: preset(
    'mfa',
    { password: true },
    {
      mfaPolicy: 'optional',
      panels: ['screen', 'mfa', 'look'],
      tryIt: [
        'Sign in as grace@example.test; the sandbox shows her authenticator app code.',
        'Set the policy to required and sign in as ada@example.test to enrol.',
      ],
    }
  ),
  organizations: preset(
    'organizations',
    { password: true },
    {
      organizations: true,
      screen: 'organization-switcher',
      panels: ['screen', 'organizations', 'look'],
      tryIt: [
        'Sign in as the demo account, then open the switcher and choose Globex.',
        'Accept the invitation to Hooli, or join Initech from the suggestions.',
        'Open Manage organization on Acme: rename it, invite someone, claim a domain.',
        'Switch to Globex, where you are a member, and see tabs and controls disappear.',
      ],
    }
  ),
}
