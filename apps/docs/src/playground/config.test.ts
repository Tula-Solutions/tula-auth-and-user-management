import { describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, parseConfig } from '@tula-tech/config'
import { contrastRatio, DEFAULT_THEME, isValidThemeValue } from '@tula-tech/contract/theme'
import { configTs, cssBlock, environmentOf, jsx } from './code'
import {
  buttonContrast,
  DEFAULT_CONFIG,
  EMBED_PRESETS,
  LOOK_PRESETS,
  matchingLook,
  mix,
  normalize,
  type PlaygroundConfig,
  setMethod,
  setMfaPolicy,
  setOrganizations,
  setProvider,
  themeOverrides,
} from './config'
import { SANDBOX_PROVIDERS } from './sandbox'

function withLook(look: Partial<PlaygroundConfig>): PlaygroundConfig {
  return { ...DEFAULT_CONFIG, ...look }
}

describe('the rules a configuration keeps', () => {
  test('an emailed link brings the emailed code with it, and removing the code removes the link', () => {
    const linked = setMethod(DEFAULT_CONFIG, 'emailLink', true)
    expect(linked.settings.methods).toMatchObject({ emailCode: true, emailLink: true })
    const unlinked = setMethod(linked, 'emailCode', false)
    expect(unlinked.settings.methods).toMatchObject({ emailCode: false, emailLink: false })
  })

  test('a sign-up with no password needs the emailed code, and falls back to required without it', () => {
    const optional = normalize({
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        signUpPassword: 'optional',
        methods: { ...DEFAULT_CONFIG.settings.methods, emailCode: false },
      },
    })
    expect(optional.settings.methods.emailCode).toBe(true)
    const off = setMethod(optional, 'emailCode', false)
    expect(off.settings.signUpPassword).toBe('required')
  })

  test('the last way in cannot be switched off', () => {
    let config = setMethod(DEFAULT_CONFIG, 'emailCode', false)
    config = setMethod(config, 'password', false)
    expect(config.settings.methods.password).toBe(true)
  })

  test('providers alone are a way in, and are kept in the panel order', () => {
    let config = setMethod(DEFAULT_CONFIG, 'emailCode', false)
    config = setProvider(config, 'github', true)
    config = setProvider(config, 'google', true)
    config = setMethod(config, 'password', false)
    expect(config.settings.methods.password).toBe(false)
    expect(config.settings.oauth).toEqual(['google', 'github'])
    expect(setProvider(config, 'google', false).settings.oauth).toEqual(['github'])
  })

  test('the two-step policy is set as given', () => {
    expect(setMfaPolicy(DEFAULT_CONFIG, 'required').settings.mfaPolicy).toBe('required')
  })

  test('organizations are off unless a preset turns them on, and switching them off leaves their screens', () => {
    expect(DEFAULT_CONFIG.settings.organizations).toBe(false)
    const preset = EMBED_PRESETS.organizations
    expect(preset?.config.settings.organizations).toBe(true)
    expect(preset?.config.screen).toBe('organization-switcher')
    expect(preset?.panels).toContain('organizations')
    const off = setOrganizations(preset?.config ?? DEFAULT_CONFIG, false)
    expect(off.settings.organizations).toBe(false)
    expect(off.screen).toBe('sign-in')
    // A screen that is not an organization's stays where it is.
    expect(setOrganizations({ ...DEFAULT_CONFIG, screen: 'account' }, false).screen).toBe('account')
    expect(setOrganizations(DEFAULT_CONFIG, true).settings.organizations).toBe(true)
  })
})

describe('the look', () => {
  test('the default look changes no token, so the copied code is empty of overrides', () => {
    expect(themeOverrides(DEFAULT_CONFIG)).toEqual({})
    expect(cssBlock(DEFAULT_CONFIG)).toContain('default theme')
    expect(jsx(DEFAULT_CONFIG)).not.toContain('appearance')
  })

  test('every look preset yields only tokens the components accept', () => {
    for (const preset of LOOK_PRESETS) {
      const theme = themeOverrides(withLook(preset.look))
      const flat = [...Object.entries(theme.light ?? {}), ...Object.entries(theme.dark ?? {})] as [
        string,
        string,
      ][]
      for (const [key, value] of flat) {
        const type = key === 'shadow' ? 'shadow' : 'color'
        expect(isValidThemeValue(type, value)).toBe(true)
      }
      for (const key of ['radius', 'radiusSmall', 'spacing', 'fontSize'] as const) {
        const value = theme[key]
        if (value !== undefined) {
          expect(isValidThemeValue('length', value)).toBe(true)
        }
      }
      if (theme.fontFamily) {
        expect(isValidThemeValue('fontFamily', theme.fontFamily)).toBe(true)
      }
    }
  })

  test('the button text reads on the brand colour in both schemes for every preset', () => {
    for (const preset of LOOK_PRESETS) {
      const config = withLook(preset.look)
      const theme = themeOverrides(config)
      const light = { ...DEFAULT_THEME.light, ...theme.light }
      const dark = { ...DEFAULT_THEME.dark, ...theme.dark }
      expect(contrastRatio(light.primaryText, light.primary)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(dark.primaryText, dark.primary)).toBeGreaterThanOrEqual(4.5)
      // The dark brand colour is drawn on the dark card, and must stand out from it.
      expect(contrastRatio(dark.primary, dark.background)).toBeGreaterThanOrEqual(3)
      expect(contrastRatio(light.link, light.background)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(dark.link, dark.background)).toBeGreaterThanOrEqual(4.5)
      expect(buttonContrast(config)).toBeGreaterThanOrEqual(4.5)
    }
  })

  test('a colour that is hard to read is reported, not hidden', () => {
    expect(buttonContrast(withLook({ primary: '#777777' }))).toBeLessThan(4.5)
  })

  test('a preset is recognised until a control moves off it', () => {
    const indigo = LOOK_PRESETS.find((preset) => preset.id === 'indigo')
    expect(indigo && matchingLook(withLook(indigo.look))).toBe('indigo')
    expect(matchingLook(withLook({ radius: 9 }))).toBeNull()
  })

  test('mixing two colours is a plain interpolation', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
  })
})

describe('the settings the copied config writes', () => {
  const matrix: PlaygroundConfig[] = [
    DEFAULT_CONFIG,
    setMethod(DEFAULT_CONFIG, 'emailLink', true),
    setMethod(DEFAULT_CONFIG, 'passkey', true),
    setMfaPolicy(DEFAULT_CONFIG, 'required'),
    setMfaPolicy(DEFAULT_CONFIG, 'off'),
    normalize({
      ...DEFAULT_CONFIG,
      settings: { ...DEFAULT_CONFIG.settings, signUpPassword: 'optional' },
    }),
    SANDBOX_PROVIDERS.reduce(
      (config, provider) => setProvider(config, provider, true),
      DEFAULT_CONFIG
    ),
    ...Object.values(EMBED_PRESETS).map((preset) => preset.config),
  ]

  test.each(matrix.map((config, index) => [index, config] as const))(
    'configuration %i validates against the config schema',
    (_index, config) => {
      const { kind, settings, providers } = environmentOf(config)
      const parsed = parseConfig({ environments: { dev: { kind, settings, providers } } })
      const dev = parsed.environments.dev
      expect(dev?.settings.signIn?.methods.password.enabled).toBe(config.settings.methods.password)
      expect(dev?.settings.mfa?.policy).toBe(config.settings.mfaPolicy)
      expect(Object.keys(dev?.providers ?? {}).sort()).toEqual([...config.settings.oauth].sort())
    }
  )

  test('a secret is only ever named, never written', () => {
    const text = configTs(setProvider(DEFAULT_CONFIG, 'github', true))
    expect(text).toContain("clientSecret: env('GITHUB_CLIENT_SECRET')")
    expect(text).toContain("import { defineConfig, env } from '@tula-tech/config'")
    expect(configTs(DEFAULT_CONFIG)).not.toContain('env(')
  })

  test.each(['Acme\\', "it's", "back\\'slash"])(
    'an app name of %p comes back from the generated file as typed',
    async (name) => {
      const dir = join(
        import.meta.dir,
        '..',
        '..',
        'node_modules',
        '.playground-config-name',
        String(Math.random()).slice(2)
      )
      mkdirSync(dir, { recursive: true })
      try {
        const file = join(dir, 'tula.config.ts')
        writeFileSync(
          file,
          configTs({ ...DEFAULT_CONFIG, settings: { ...DEFAULT_CONFIG.settings, appName: name } })
        )
        const loaded = await loadConfig(file)
        expect(loaded.config.environments.dev?.settings.app?.name).toBe(name)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )

  test('the generated file loads as a real tula.config.ts', async () => {
    // Inside node_modules so that `@tula-tech/config` resolves from here and git ignores it.
    const dir = join(import.meta.dir, '..', '..', 'node_modules', '.playground-config-test')
    mkdirSync(dir, { recursive: true })
    try {
      const config = setProvider(setMethod(DEFAULT_CONFIG, 'emailLink', true), 'google', true)
      const file = join(dir, 'tula.config.ts')
      writeFileSync(file, configTs(config))
      const loaded = await loadConfig(file)
      expect(loaded.config.environments.dev?.settings.signIn?.methods.emailLink.enabled).toBe(true)
      expect(loaded.config.environments.dev?.providers.google?.clientSecret).toEqual({
        $env: 'GOOGLE_CLIENT_SECRET',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the copied React and CSS', () => {
  test('changed tokens appear in the component props and in the stylesheet, and only those', () => {
    const config = withLook({ primary: '#0f766e', radius: 18 })
    const code = jsx(config)
    expect(code).toContain('appearance={{')
    expect(code).toContain("primary: '#0f766e'")
    expect(code).toContain("radius: '18px'")
    const css = cssBlock(config)
    expect(css).toContain('--tula-color-primary: #0f766e;')
    expect(css).toContain('--tula-dark-color-primary:')
    expect(css).toContain('--tula-radius: 18px;')
    expect(css).not.toContain('--tula-color-link')
  })

  test('the page imports exactly what it renders', () => {
    const config = setProvider(setMethod(DEFAULT_CONFIG, 'emailLink', true), 'github', true)
    const code = jsx(config)
    expect(code).toContain(
      "import { EmailLinkCallback, OAuthCallback, SignIn, TulaProvider } from '@tula-tech/react'"
    )
    expect(code).toContain("oauthCallbackUrl='/auth/callback'")
    expect(code).toContain("emailLinkUrl='/auth/email-link'")
    expect(jsx(withLook({ screen: 'account' }))).toContain('<UserProfile')
    expect(jsx(withLook({ screen: 'sign-up' }))).toContain('<SignUp')
  })

  test('each organization screen is its own component, with the destinations of the app', () => {
    const base = EMBED_PRESETS.organizations?.config ?? DEFAULT_CONFIG
    const switcher = jsx({ ...base, screen: 'organization-switcher' })
    expect(switcher).toContain(
      "import { OrganizationSwitcher, TulaProvider } from '@tula-tech/react'"
    )
    expect(switcher).toContain("organizationProfileUrl='/organization'")
    expect(switcher).toContain("createOrganizationUrl='/organization/new'")
    expect(jsx({ ...base, screen: 'create-organization' })).toContain('<CreateOrganization')
    const profile = jsx({ ...base, screen: 'organization-profile' })
    expect(profile).toContain('<OrganizationProfile')
    expect(profile).toContain("invitationUrl='/organizations'")
    expect(configTs(base)).toContain('organizations: {')
    expect(configTs(DEFAULT_CONFIG)).not.toContain('organizations')
  })

  test('no secret key is ever written', () => {
    for (const config of matrix()) {
      expect(jsx(config)).not.toMatch(/tula_sk_|clientSecret/)
    }
  })
})

function matrix(): PlaygroundConfig[] {
  return Object.values(EMBED_PRESETS).map((preset) => preset.config)
}
